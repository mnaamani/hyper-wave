// useEngine — the mobile host for the shared engine. This is the RN counterpart of the desktop
// renderer's worker bridge: it boots the Bare worklet (hyperwave-engine's worklet/app.js, bundled
// by bare-pack) and speaks the SAME bare-rpc host<->UI seam (hyperwave-engine/lib/rpc) over the IPC
// stream that the desktop uses. The engine itself (the sweep, feed, Cashu wallet) runs unchanged
// inside the worklet — this file never touches Hyperswarm/Corestore/cashu-ts directly.
//
// The STATE + RULES live in `hyperwave-app-core`, the same view-model the desktop renderer drives:
// the wave directory, active-wave selection, the ended-wave lifecycle (TTL → unsubscribe), wallet
// metadata + the same-network filter, and the tip choreography (dm the token, note the
// announcement, redeem an inbound dm). So this hook is only transport + React glue.
//
// Custody + durability live on THIS side too (src/custody.js), mirroring Electron main: the seeds
// come from the OS keychain and the storage dir is the persistent document directory, both injected
// in the one-time `init` command.
import { useEffect, useRef, useState, useCallback } from 'react';
import { AppState } from 'react-native';
import { Worklet } from 'react-native-bare-kit';
import FramedStream from 'framed-stream';
import { createRpcClient } from 'hyperwave-engine/lib/rpc';
import { createAppCore } from 'hyperwave-app-core';
import bundle from '../bundles/app.bundle.mjs'; // produced by `npm run bundle` (bare-pack)
import {
  resolveStorageDir,
  resolveSeeds,
  readMint,
  writeMint
} from './custody';

// Engine results the UI narrates as a toast (the core handles their side effects).
const RESULT_TOASTS = {
  'burn-result': (msg) =>
    msg.stage === 'failed'
      ? `⚠ ${msg.reason || 'fee'} burn failed: ${msg.error}`
      : `🔥 ${msg.reason || 'fee'} burn ${msg.stage || 'sent'}`,
  'tip-result': (msg) =>
    msg.error ? `⚠ tip failed: ${msg.error}` : '✅ tipped',
  'fund-result': (msg) => {
    if (msg.error) {
      return `⚠ top up failed: ${msg.error}`;
    }
    return msg.pending ? '⏳ invoice issued — paying…' : '✅ topped up';
  },
  'cash-out-result': (msg) =>
    msg.error ? `⚠ cash out failed: ${msg.error}` : '✅ cashed out',
  'redeem-result': (msg) =>
    msg.error
      ? `⚠ redeem failed: ${msg.error}`
      : `🎉 tip redeemed +${msg.amount}`
};

// Narration for wave events — the same beats the desktop HUD shows (renderer/app.js's
// EVENT_HANDLERS), minus the ones that are purely visual there. Anything already visible in the
// snapshot (phase, roster count, fee) needs no beat.
const EVENT_TOASTS = {
  'wave-announce': (evt) =>
    evt.mine && evt.paid !== 'verified'
      ? '🔥 paying the start fee…'
      : '🌊 a wave is forming',
  paying: () => '🔥 paying the start fee…',
  'wave-verified': (evt) =>
    evt.mine ? '✅ your wave is live' : '✅ start fee verified — you can join',
  'wave-unpaid': () => '⚠ ignored an unpaid wave',
  'join-blocked': (evt) => {
    const byReason = {
      'roster-full': '🚧 this wave is full — spectating',
      'wallet-unsupported': evt.walletType
        ? `💸 can’t join — this wave needs a ${evt.walletType} wallet`
        : '💸 can’t join — no compatible wallet',
      pending: '⏳ verifying the wave’s start payment…',
      rejected: '⚠ the wave’s start payment was rejected'
    };
    return byReason[evt.reason] || '🚫 can’t join this wave';
  },
  joined: () => '✋ you’re on the roster',
  'wave-active': (evt) =>
    evt.joined ? '📸 here comes the wave!' : '👀 spectating this wave',
  busy: () => '⏳ a wave is already forming — wait for it to finish',
  started: () => '⚡ the wave is off!',
  holding: (evt) =>
    `📸 your moment joins the wave! — hop ${evt.hopCount ?? ''}`,
  // My moment couldn't be posted yet (the engine holds it and retries): the feed's write-gate
  // needs my join attestation. Without this beat the only symptom would be my own moment quietly
  // missing from my own feed.
  'entry-deferred': () => '⏳ your moment is waiting on your join signature…',
  position: (evt) => `wave rolling — hop ${evt.hopCount ?? ''}`,
  completed: (evt) => `✅ wave completed — ${evt.hops} hops`,
  'wave-idle': () => null, // the last beat (completed) deliberately stays on screen
  dm: (evt) =>
    evt.note?.kind === 'tip' && evt.note?.token
      ? `🎉 you got tipped ${evt.note.amount}!`
      : null,
  note: (evt) =>
    evt.note?.kind === 'tip'
      ? `💸 a moment was tipped ${evt.note.amount}`
      : null
};

// `dm`/`note` touch MY wallet regardless of which wave I'm viewing (a tip can arrive for a wave
// I've navigated away from), so they narrate unconditionally; every other beat is about the wave
// on screen — same rule as the desktop renderer.
const WAVE_AGNOSTIC_EVENTS = new Set(['dm', 'note']);

export function useEngine(config = {}) {
  const coreRef = useRef(null);
  const clientRef = useRef(null);
  // Set by the host (the capture sheet) — run before the active wave changes; see the core's
  // onBeforeSwitchWave below.
  const beforeSwitchRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  // {text, at} rather than a bare string: the same beat firing twice must still re-show.
  const [toast, setToast] = useState(null);
  // The last wave event for the ACTIVE wave, so the ring can trigger its sweep + flourish off the
  // protocol rather than guessing from phase transitions. {event, waveId, at}.
  const [lastEvent, setLastEvent] = useState(null);
  // Wallet-screen results. Request/response replies (transactions) are ALSO surfaced through
  // onEvent by the rpc client, so every one of these arrives on the same path.
  const [fundResult, setFundResult] = useState(null);
  const [cashOutResult, setCashOutResult] = useState(null);
  const [transactions, setTransactions] = useState([]);

  useEffect(() => {
    const worklet = new Worklet();
    let closed = false;

    worklet.start('/app.bundle', bundle);

    // Wrap the IPC duplex in the SAME framing the worklet uses (FramedStream(BareKit.IPC)), then
    // speak the bare-rpc host<->UI seam over it.
    const pipe = new FramedStream(worklet.IPC);
    const client = createRpcClient({
      stream: pipe,
      onEvent: (msg) => {
        if (closed || !msg) {
          return;
        }
        // The core FIRST (it owns the directory, active wave, redeem-on-dm and the tip
        // choreography), then this host's narration — the ordering rule the core documents.
        coreRef.current?.handle(msg);
        // READY means "the engine has spoken", not "we sent init". A command issued between those
        // two points is swallowed by the host's onBootstrap (which consumes anything arriving
        // before the engine exists) — and a request/response command like fetch-transactions would
        // then never get a reply, leaving the wallet's history silently empty.
        setReady(true);
        const say = (text) => {
          if (text) {
            setToast({ text, at: Date.now() });
          }
        };
        if (msg.type === 'wallet') {
          if (msg.error) {
            say(`⚠ wallet: ${msg.error}`);
          } else if (typeof msg.mint === 'string') {
            writeMint(msg.mint); // survive a restart, like desktop's cashu.mint file
          }
          return;
        }
        if (msg.type === 'engine-error' || msg.type === 'error') {
          say(`⚠ ${msg.error}`);
          return;
        }
        if (msg.type === 'transactions') {
          setTransactions(msg.list || []);
          return;
        }
        if (msg.type === 'fund-result') {
          setFundResult(msg);
        } else if (msg.type === 'cash-out-result') {
          setCashOutResult(msg);
        }
        // Money moved (and settled — a pending fund-result is just the invoice): pull the ledger
        // again so the wallet's history is current without the user reopening the screen.
        const settled =
          !msg.pending &&
          (msg.type === 'fund-result' ||
            msg.type === 'cash-out-result' ||
            msg.type === 'redeem-result');
        if (settled) {
          coreRef.current?.fetchTransactions();
        }
        const resultToast = RESULT_TOASTS[msg.type];
        if (resultToast) {
          say(resultToast(msg));
          return;
        }
        if (msg.type !== 'event') {
          return;
        }
        // Narrate (and drive the ring) only for the wave on screen — a background wave must not
        // clobber the view — except the wave-agnostic money events.
        const activeWaveId = coreRef.current?.getSnapshot().activeWaveId;
        const forActive = msg.waveId && msg.waveId === activeWaveId;
        if (!WAVE_AGNOSTIC_EVENTS.has(msg.event) && !forActive) {
          return;
        }
        if (forActive) {
          setLastEvent({
            event: msg.event,
            waveId: msg.waveId,
            at: Date.now()
          });
        }
        say(EVENT_TOASTS[msg.event]?.(msg));
      }
    });
    clientRef.current = client;

    const core = createAppCore({
      send: (type, args) => client.call(type, args),
      // app-core invariant 3: if the user is framing a moment for the wave they're leaving, it
      // must be staged to the OLD wave BEFORE the switch — otherwise a wave that starts while
      // they browse elsewhere posts nothing. The capture sheet registers itself here (the ref is
      // indirection because the sheet mounts long after the core is built).
      onBeforeSwitchWave: () => beforeSwitchRef.current?.()
    });
    coreRef.current = core;
    core.subscribe((next) => {
      if (!closed) {
        setSnapshot(next);
      }
    });
    setSnapshot(core.getSnapshot());

    // One-time init: a PERSISTENT storage dir + the keychain-held seeds + the peer's chosen mint.
    // Async (keychain + fs are async on RN), so the engine is built a tick after mount. `ready`
    // flips when the engine first speaks back (see onEvent), not here.
    (async () => {
      const storageDir = resolveStorageDir();
      const seeds = await resolveSeeds();
      if (closed) {
        return;
      }
      client.call('init', {
        storageDir,
        config: { ...config, ...seeds, walletOptions: { mint: readMint() } }
      });
    })();

    // Cooperate with the OS lifecycle: react-native-bare-kit's Worklet.update() takes an RN
    // AppStateStatus and suspends/resumes the Bare runtime accordingly, so we don't burn battery
    // (or get killed ungracefully) running the swarm full-tilt in the background. (Sockets still
    // suspend in the background — fine for a foreground "watch the wave" app.)
    worklet.update(AppState.currentState);
    const appSub = AppState.addEventListener('change', (state) => {
      try {
        worklet.update(state);
      } catch {}
    });

    return () => {
      closed = true;
      core.close();
      try {
        appSub.remove();
      } catch {}
      try {
        pipe.end();
      } catch {}
      try {
        worklet.terminate();
      } catch {}
    };
  }, []); // boot once on mount

  const action = useCallback(
    (name, ...args) => coreRef.current?.[name]?.(...args),
    []
  );

  return {
    ready,
    toast,
    lastEvent,
    fundResult,
    cashOutResult,
    transactions,
    /**
     * Register what must happen before the active wave changes (staging a pending capture).
     * @param {(() => void)|null} fn - The hook, or null to clear it.
     * @returns {void}
     */
    setBeforeWaveSwitch: (fn) => {
      beforeSwitchRef.current = fn;
    },
    // the core's snapshot, flattened for the UI
    me: snapshot?.me || null,
    peers: snapshot?.peers || [],
    waves: snapshot?.waveList || [],
    activeWaveId: snapshot?.activeWaveId || null,
    activeWave: snapshot?.activeWave || null,
    gallery: snapshot?.feed || [],
    wallet: snapshot?.wallet || null,
    // wave lifecycle
    // The message must be FORWARDED: app-core maps it to the engine's opaque announce `meta`.
    // Dropping the argument here (which this did) silently sends a wave with nothing to say —
    // the UI looks right, the field clears, and every peer sees `meta: null`.
    startWave: (message) => action('startWave', message),
    joinWave: (waveId) => action('joinWave', waveId),
    selectWave: (waveId) => action('selectWave', waveId),
    // Push a wave away for good (app-core invariant 6 — it stays gone despite the engine's
    // continuing gossip about it). Frees its cores, like the desktop ring's ✕.
    dismissWave: (waveId) => action('dismissWave', waveId),
    setCountry: (country) => action('setCountry', country),
    stageMoment: (moment, waveId) => action('stageMoment', moment, waveId),
    // money
    tip: (target) => action('tip', target),
    redeem: (token) => action('redeem', token),
    fundWallet: (amount) => action('fundWallet', amount),
    cashOut: (invoice) => action('cashOut', invoice),
    setMint: (mint) => action('setMint', mint),
    refreshWallet: () => action('refreshWallet'),
    fetchTransactions: () => action('fetchTransactions'),
    // the same-network filter, for hiding cross-network waves
    waveMatchesNetwork: (wave) => action('waveMatchesNetwork', wave)
  };
}
