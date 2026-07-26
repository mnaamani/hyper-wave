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

// Narration for the wave events the UI wants to say something about. Everything else is reflected
// by the snapshot (phase, roster count, …) and needs no toast.
const EVENT_TOASTS = {
  'join-blocked': (evt) => {
    const byReason = {
      'roster-full': '🚧 this wave is full — spectating',
      'wallet-unsupported': '💸 this wave needs a different wallet',
      pending: '⏳ verifying the wave’s start payment…',
      rejected: '⚠ the wave’s start payment was rejected'
    };
    return byReason[evt.reason] || '🚫 can’t join this wave';
  },
  'wave-unpaid': () => '⚠ ignored an unpaid wave',
  started: () => '⚡ the wave is off!',
  holding: (evt) =>
    `📸 your moment joins the wave! — hop ${evt.hopCount ?? ''}`,
  completed: (evt) => `✅ wave completed — ${evt.hops} hops`,
  dm: (evt) =>
    evt.note?.kind === 'tip' && evt.note?.token
      ? `🎉 you got tipped ${evt.note.amount}!`
      : null,
  note: (evt) =>
    evt.note?.kind === 'tip'
      ? `💸 a moment was tipped ${evt.note.amount}`
      : null
};

export function useEngine(config = {}) {
  const coreRef = useRef(null);
  const clientRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [toast, setToast] = useState(null);

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
        if (msg.type === 'wallet') {
          if (msg.error) {
            setToast(`⚠ wallet: ${msg.error}`);
          } else if (typeof msg.mint === 'string') {
            writeMint(msg.mint); // survive a restart, like desktop's cashu.mint file
          }
          return;
        }
        if (msg.type === 'engine-error' || msg.type === 'error') {
          setToast(`⚠ ${msg.error}`);
          return;
        }
        const resultToast = RESULT_TOASTS[msg.type];
        if (resultToast) {
          setToast(resultToast(msg));
          return;
        }
        if (msg.type === 'event') {
          const text = EVENT_TOASTS[msg.event]?.(msg);
          if (text) {
            setToast(text);
          }
        }
      }
    });
    clientRef.current = client;

    const core = createAppCore({
      send: (type, args) => client.call(type, args),
      // No webcam preview to lock in yet (capture is Phase 4) — when it lands, stage the pending
      // frame here so a wave that starts while the user browses elsewhere still posts (invariant 3).
      onBeforeSwitchWave: () => {}
    });
    coreRef.current = core;
    core.subscribe((next) => {
      if (!closed) {
        setSnapshot(next);
      }
    });
    setSnapshot(core.getSnapshot());

    // One-time init: a PERSISTENT storage dir + the keychain-held seeds + the peer's chosen mint.
    // Async (keychain + fs are async on RN), so the engine is built a tick after mount — `ready`
    // gates the UI.
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
      setReady(true);
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
    // the core's snapshot, flattened for the UI
    me: snapshot?.me || null,
    peers: snapshot?.peers || [],
    waves: snapshot?.waveList || [],
    activeWaveId: snapshot?.activeWaveId || null,
    activeWave: snapshot?.activeWave || null,
    gallery: snapshot?.feed || [],
    wallet: snapshot?.wallet || null,
    // wave lifecycle
    startWave: () => action('startWave'),
    joinWave: (waveId) => action('joinWave', waveId),
    selectWave: (waveId) => action('selectWave', waveId),
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
