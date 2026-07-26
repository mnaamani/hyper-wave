// useEngine — the mobile host for the shared engine. This is the RN counterpart of the desktop
// renderer's worker bridge: it boots the Bare worklet (hyperwave-engine's worklet/app.js, bundled
// by bare-pack) and speaks the SAME bare-rpc host<->UI seam (hyperwave-engine/lib/rpc) over the IPC
// stream that the desktop uses, exposing engine state + actions to React. The engine itself (the
// sweep, feed, Cashu wallet) runs unchanged inside the worklet — this file never touches
// Hyperswarm/Corestore/cashu-ts directly.
//
// Custody + durability live on THIS side (src/custody.js), mirroring Electron main: the seeds come
// from the OS keychain and the storage dir is the persistent document directory, both injected in
// the one-time `init` command.
//
// NOTE: the per-wave bookkeeping below (the directory map, the active wave, the ended-wave TTL)
// duplicates renderer/app.js on purpose for now; implement-mobile-app.md D1 extracts it into a
// shared `hyperwave-app-core` package that both hosts drive, at which point this hook thins out to
// transport + snapshot.
import { useEffect, useRef, useState, useCallback } from 'react';
import { AppState } from 'react-native';
import { Worklet } from 'react-native-bare-kit';
import FramedStream from 'framed-stream';
import { createRpcClient } from 'hyperwave-engine/lib/rpc';
import bundle from '../bundles/app.bundle.mjs'; // produced by `npm run bundle` (bare-pack)
import {
  resolveStorageDir,
  resolveSeeds,
  readMint,
  writeMint
} from './custody';

// An ended wave lingers (its gallery still browsable), then is dropped + unsubscribed so the core
// budget stays O(subscribed) — same grace period as the desktop renderer.
const ENDED_TTL_MS = 180000;
const DEFAULT_LOBBY_MS = 15000;

// Per-event metadata patch for the wave directory (missing kinds = no directory change). Mirrors
// renderer/app.js's DIRECTORY_PATCH.
const DIRECTORY_PATCH = {
  'wave-announce': (evt) => ({
    by: evt.by,
    mine: !!evt.mine,
    joined: !!evt.joined,
    subscribed: !!evt.subscribed,
    count: evt.count,
    fee: evt.fee,
    walletType: evt.walletType,
    paid: evt.paid,
    network: evt.network,
    phase: 'lobby',
    lobbyDeadline: Date.now() + (evt.lobbyMs || DEFAULT_LOBBY_MS)
  }),
  subscribed: (evt) => ({ subscribed: true, joined: !!evt.joined }),
  unsubscribed: () => ({ subscribed: false, joined: false }),
  joined: (evt) => ({ joined: true, count: evt.count }),
  roster: (evt) => ({ count: evt.count }),
  'wave-active': (evt) => ({
    phase: 'racing',
    count: evt.count,
    joined: !!evt.joined,
    ...(evt.network ? { network: evt.network } : {})
  }),
  'wave-idle': () => ({ phase: 'ended' }),
  'wave-verified': (evt) => ({
    paid: 'verified',
    ...(evt.network ? { network: evt.network } : {})
  })
};

// The engine is theme-agnostic: an entry carries an opaque `payload` this app fills with a
// {image, caption} moment, and a peer's cosmetic `tag` is its country. Map back at the boundary.
function asMoment(item) {
  return {
    ...item,
    image: item.payload?.image || '',
    caption: item.payload?.caption || '',
    country: item.tag
  };
}

export function useEngine(config = {}) {
  const clientRef = useRef(null);
  const wavesRef = useRef(new Map()); // waveId -> directory metadata
  const feedsRef = useRef(new Map()); // waveId -> mapped moments
  const expiryRef = useRef(new Map()); // waveId -> one-shot drop timer
  const activeRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [me, setMe] = useState(null);
  const [peers, setPeers] = useState([]);
  const [waves, setWaves] = useState([]);
  const [activeWaveId, setActiveWaveId] = useState(null);
  const [gallery, setGallery] = useState([]);
  const [wallet, setWallet] = useState(null);
  const [toast, setToast] = useState(null);

  const call = useCallback((type, args) => {
    if (!clientRef.current) {
      return undefined;
    }
    return clientRef.current.call(type, args);
  }, []);

  useEffect(() => {
    const worklet = new Worklet();
    const timers = expiryRef.current;
    let closed = false;

    // --- view-model helpers (all read/write the refs, then publish to React state) ---------

    function publishWaves() {
      setWaves([...wavesRef.current.values()]);
    }

    function publishGallery() {
      const items = activeRef.current
        ? feedsRef.current.get(activeRef.current)
        : null;
      setGallery(items || []);
    }

    function upsertWave(waveId, patch) {
      const wave = wavesRef.current.get(waveId) || {
        waveId,
        phase: 'lobby',
        count: 1,
        joined: false,
        subscribed: false
      };
      Object.assign(wave, patch);
      wavesRef.current.set(waveId, wave);
      publishWaves();
    }

    // Drop a wave from the UI: free its cores (invariant — this is what keeps the core budget
    // O(subscribed)), forget its metadata + cached feed, and deselect it if it was active.
    function removeWave(waveId) {
      const wave = wavesRef.current.get(waveId);
      clearTimeout(timers.get(waveId));
      timers.delete(waveId);
      if (wave && wave.subscribed) {
        call('unsubscribe-wave', { waveId });
      }
      wavesRef.current.delete(waveId);
      feedsRef.current.delete(waveId);
      if (activeRef.current === waveId) {
        activeRef.current = null;
        setActiveWaveId(null);
        publishGallery();
      }
      publishWaves();
    }

    function scheduleWaveExpiry(waveId) {
      clearTimeout(timers.get(waveId));
      timers.set(
        waveId,
        setTimeout(() => removeWave(waveId), ENDED_TTL_MS)
      );
    }

    function updateDirectory(evt) {
      const patch = DIRECTORY_PATCH[evt.event]?.(evt);
      // Only wave-announce (the authoritative "aware" event — the only one carrying `by`) may
      // CREATE a directory entry; every other event only UPDATES a wave we already know, or a
      // late `roster` / echoed `unsubscribed` would spawn a phantom by-less wave.
      const known = wavesRef.current.has(evt.waveId);
      if (evt.waveId && patch && (evt.event === 'wave-announce' || known)) {
        upsertWave(evt.waveId, patch);
      }
      if (evt.event === 'wave-idle' && wavesRef.current.has(evt.waveId)) {
        scheduleWaveExpiry(evt.waveId);
      }
    }

    // Auto-engage a wave I just started (the engine already subscribed it as the initiator) and
    // supersede my PRIOR own wave — kicking off a new one drops the last from the UI.
    function maybeAutoSelect(evt) {
      if (evt.event !== 'wave-announce' || !evt.mine || !evt.waveId) {
        return;
      }
      const priorMine = [...wavesRef.current.values()]
        .filter((wave) => wave.mine && wave.waveId !== evt.waveId)
        .map((wave) => wave.waveId);
      for (const waveId of priorMine) {
        removeWave(waveId);
      }
      activeRef.current = evt.waveId;
      setActiveWaveId(evt.waveId);
      publishGallery();
    }

    // --- engine -> UI --------------------------------------------------------------------

    const handlers = {
      state: (msg) => {
        if (msg.me) {
          setMe(msg.me);
        }
        setPeers(msg.peers || []);
      },
      event: (msg) => {
        updateDirectory(msg);
        maybeAutoSelect(msg);
        if (msg.event === 'join-blocked') {
          setToast(`⚠ can't join: ${msg.reason || 'blocked'}`);
        }
      },
      feed: (msg) => {
        const waveId = msg.waveId;
        feedsRef.current.set(waveId, (msg.items || []).map(asMoment));
        if (waveId === activeRef.current) {
          publishGallery();
        }
      },
      wallet: (msg) => {
        if (msg.error) {
          setToast(`⚠ wallet: ${msg.error}`);
          return;
        }
        if (typeof msg.mint === 'string') {
          writeMint(msg.mint); // survive a restart, like desktop's cashu.mint file
        }
        setWallet({
          address: msg.address,
          amount: msg.amount,
          unit: msg.unit,
          mint: msg.mint,
          mints: msg.mints || [],
          network: msg.network,
          walletType: msg.walletType,
          accountIndex: msg.accountIndex
        });
      },
      'engine-error': (msg) => setToast(`⚠ engine: ${msg.error}`),
      error: (msg) => setToast(`⚠ ${msg.error}`)
    };

    const RESULT_TYPES = new Set([
      'burn-result',
      'tip-result',
      'fund-result',
      'cash-out-result',
      'redeem-result',
      'send-result'
    ]);

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
        const handler = handlers[msg.type];
        if (handler) {
          handler(msg);
          return;
        }
        if (RESULT_TYPES.has(msg.type)) {
          setToast(
            msg.error
              ? `⚠ ${msg.error}`
              : `✓ ${msg.type.replace('-result', '')}`
          );
        }
      }
    });
    clientRef.current = client;

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
        config: {
          ...config,
          ...seeds,
          walletOptions: { mint: readMint() }
        }
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
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
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

  // Browse-then-pick: opening a wave subscribes to it (holds its feed cores + control gossip).
  const selectWave = useCallback(
    (waveId) => {
      const wave = wavesRef.current.get(waveId);
      if (!wave || waveId === activeRef.current) {
        return;
      }
      activeRef.current = waveId;
      setActiveWaveId(waveId);
      if (!wave.subscribed) {
        call('subscribe-wave', { waveId });
        wave.subscribed = true; // optimistic; the `subscribed` event confirms
      }
      setWaves([...wavesRef.current.values()]);
      setGallery(feedsRef.current.get(waveId) || []);
    },
    [call]
  );

  return {
    ready,
    me,
    peers,
    waves,
    activeWaveId,
    activeWave: activeWaveId ? wavesRef.current.get(activeWaveId) : null,
    gallery,
    wallet,
    toast,
    // wave lifecycle
    startWave: () => call('start-wave'),
    joinWave: (waveId) => call('join-wave', { waveId: waveId || activeWaveId }),
    selectWave,
    unsubscribeWave: (waveId) => call('unsubscribe-wave', { waveId }),
    // the app's "country" is the engine's cosmetic peer `tag`; a moment {image, caption} is just
    // the engine entry's opaque `payload`
    setCountry: (country) => call('set-tag', { tag: country }),
    stageMoment: (moment, waveId) =>
      call('stage-entry', {
        waveId: waveId || activeWaveId,
        entry: { payload: moment }
      }),
    // money (request/response where the engine replies: tip / fetch-transactions)
    tip: (to, amount) => call('tip', { to, amount }),
    note: (note, waveId) =>
      call('note', { waveId: waveId || activeWaveId, note }),
    dm: (to, note, waveId) =>
      call('dm', { waveId: waveId || activeWaveId, to, note }),
    redeem: (token) => call('redeem', { token }),
    fundWallet: (amount) => call('fund-wallet', { amount }),
    cashOut: (invoice) => call('cash-out', { invoice }),
    setMint: (mint) => call('set-wallet-options', { walletOptions: { mint } }),
    refreshWallet: () => call('refresh-wallet'),
    fetchTransactions: () => call('fetch-transactions')
  };
}
