// The app core: the framework-agnostic view-model both HyperWave hosts drive (the Electron
// renderer and the React Native app). It owns STATE + RULES, never presentation — no DOM, no
// React, no timers a host can't override, and no engine import (it talks to the engine only
// through the injected `send`).
//
// What it owns (extracted from the desktop renderer, which had no test coverage):
//   - the wave directory (every announced wave) + a per-wave feed cache
//   - active-wave selection, and superseding my own prior wave
//   - the ended-wave lifecycle: linger → fade → drop → unsubscribe
//   - wallet metadata + the same-network filter
//   - the tip choreography: tip → dm the bearer token + note the announcement; redeem on an
//     inbound dm
//
// The five invariants below are each a fixed bug, and each has a test in this package. If you
// change this file, read them first — a re-implementation re-breaks all five:
//
//   1. Only `wave-announce` may CREATE a directory entry. Every other event updates a wave we
//      already know, or a late `roster` / echoed `unsubscribed` spawns a phantom by-less wave.
//   2. `dm` and `note` are WAVE-AGNOSTIC. A `dm` carries a P2PK-locked Cashu token and must be
//      redeemed even when it arrives for a wave the user has navigated away from. Routing it "for
//      the active wave only" silently destroys received sats.
//   3. The pending capture is staged BEFORE switching waves (`onBeforeSwitchWave`) — otherwise a
//      wave that starts while the user browses elsewhere posts nothing.
//   4. A network change deselects a now-cross-network active wave.
//   5. Ended waves are UNSUBSCRIBED when dropped — this is what keeps the core budget
//      O(subscribed).
import { withCountry, asMoment, asEntry } from './theme.js';
import { networksMatch, mergeWalletMeta } from './wallet-meta.js';

const DEFAULT_ENDED_TTL_MS = 180000; // ~3 minutes an ended wave lingers, still browsable
const DEFAULT_FADE_MS = 600; // matches the desktop bubble's CSS fade-out
const DEFAULT_LOBBY_MS = 15000; // fallback when an announce carries no lobbyMs

// Per-event metadata patch for the directory (an event kind that's missing here changes nothing).
const DIRECTORY_PATCH = {
  'wave-announce': (evt, { now, defaultLobbyMs }) => ({
    by: evt.by,
    mine: !!evt.mine,
    joined: !!evt.joined,
    subscribed: !!evt.subscribed,
    count: evt.count,
    fee: evt.fee,
    walletType: evt.walletType,
    paid: evt.paid,
    network: evt.network, // settlement network (from the start burn) — same-network filter
    phase: 'lobby',
    lobbyDeadline: now() + (evt.lobbyMs || defaultLobbyMs)
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

/**
 * Create the app core.
 *
 * Hosts must honour two ordering rules the store cannot enforce for them:
 *   - Feed EVERY engine message to `handle(msg)` BEFORE running the host's own narration for that
 *     message, so the directory and active wave are current when the host paints.
 *   - Presentation-coupled sequencing stays in the host (e.g. the desktop's
 *     `gallery.setActive()` before `gallery.handle()`); the snapshot carries enough state for it.
 *
 * @param {Object} options - Options.
 * @param {(type: string, args?: Object) => any} options.send - Transport to the engine (the
 *   desktop's `ipc` sender / the mobile rpc client's `call`).
 * @param {() => number} [options.now] - Clock, in ms. Injectable so the ended-wave TTL is testable;
 *   the desktop passes `performance.now()` to match its other deadlines.
 * @param {(fn: () => void, ms: number) => any} [options.setTimer] - Timer scheduler.
 * @param {(handle: any) => void} [options.clearTimer] - Timer canceller.
 * @param {number} [options.endedTtlMs] - How long an ended wave lingers before fading.
 * @param {number} [options.fadeMs] - Fade duration between marking a wave `fading` and dropping it.
 * @param {number} [options.defaultLobbyMs] - Lobby length assumed when an announce omits it.
 * @param {() => void} [options.onBeforeSwitchWave] - Called synchronously before the active wave
 *   changes to another wave (invariant 3: the host stages its pending capture here).
 * @returns {Object} The app core.
 */
export function createAppCore({
  send,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  endedTtlMs = DEFAULT_ENDED_TTL_MS,
  fadeMs = DEFAULT_FADE_MS,
  defaultLobbyMs = DEFAULT_LOBBY_MS,
  onBeforeSwitchWave = () => {}
}) {
  const waves = new Map(); // waveId -> directory metadata
  const feeds = new Map(); // waveId -> raw engine feed items
  const expiryTimers = new Map(); // waveId -> one-shot handle (linger, then fade)
  const subscribers = new Set();
  const patchContext = { now, defaultLobbyMs };

  let ring = { me: null, peers: [] };
  let wallet = { unit: 'sat', mint: '', network: '' };
  let activeWaveId = null;
  let lastTip = null; // the in-flight tip, remembered for the post-confirmation choreography
  let snapshot = null; // cached; invalidated on every change

  // --- snapshot + notification ---------------------------------------------------------------

  function buildSnapshot() {
    const directory = new Map();
    for (const [waveId, wave] of waves) {
      directory.set(waveId, { ...wave });
    }
    const activeWave = activeWaveId ? directory.get(activeWaveId) : null;
    return {
      me: ring.me,
      peers: ring.peers,
      waves: directory, // waveId -> metadata (a fresh Map of fresh objects, safe to render from)
      waveList: [...directory.values()],
      activeWaveId,
      activeWave: activeWave || null,
      feed: (feeds.get(activeWaveId) || []).map(asMoment),
      wallet: { ...wallet }
    };
  }

  /**
   * The current state. Cheap to call — rebuilt only after a change.
   * @returns {Object} The snapshot.
   */
  function getSnapshot() {
    if (!snapshot) {
      snapshot = buildSnapshot();
    }
    return snapshot;
  }

  // `kind` tells a host WHAT changed so it can skip repaints it doesn't need (hosts may ignore it):
  //   'ring'        the global peer ring (a `state` message)
  //   'waves'       directory metadata only
  //   'feed'        a wave's feed cache
  //   'wallet'      wallet metadata, same network
  //   'network'     the wallet's settlement network changed (the active wave still stands)
  //   'select'      the user opened a wave — the host re-owns its main view
  //   'auto-select' MY new wave was auto-engaged; the host's own announce handling paints it
  //   'deselect'    the active wave went away (dropped, or became cross-network)
  function notify(kind) {
    snapshot = null;
    const current = getSnapshot();
    for (const subscriber of subscribers) {
      subscriber(current, kind);
    }
  }

  // --- directory -----------------------------------------------------------------------------

  function upsertWave(waveId, patch) {
    const wave = waves.get(waveId) || {
      waveId,
      phase: 'lobby',
      count: 1,
      joined: false,
      subscribed: false
    };
    Object.assign(wave, patch);
    waves.set(waveId, wave);
  }

  // Drop a wave: free its cores (invariant 5), forget its metadata + cached feed, and deselect it
  // if it was active. Used by the grace-period fade and when my own new wave supersedes a prior one.
  function removeWave(waveId) {
    const wave = waves.get(waveId);
    let activeChanged = false;
    clearTimer(expiryTimers.get(waveId));
    expiryTimers.delete(waveId);
    if (wave && wave.subscribed) {
      send('unsubscribe-wave', { waveId });
    }
    waves.delete(waveId);
    feeds.delete(waveId);
    if (activeWaveId === waveId) {
      activeWaveId = null;
      activeChanged = true;
    }
    notify(activeChanged ? 'deselect' : 'waves');
  }

  // Mark the bubble fading (the host plays its animation), then drop it once the fade has run.
  function fadeOutWave(waveId) {
    if (!waves.has(waveId)) {
      return;
    }
    upsertWave(waveId, { fading: true });
    notify('waves');
    setTimer(() => removeWave(waveId), fadeMs);
  }

  // Start the grace-period countdown for an ended wave (re-armed if `wave-idle` fires again).
  function scheduleWaveExpiry(waveId) {
    clearTimer(expiryTimers.get(waveId));
    expiryTimers.set(
      waveId,
      setTimer(() => fadeOutWave(waveId), endedTtlMs)
    );
  }

  function updateDirectory(evt) {
    const patch = DIRECTORY_PATCH[evt.event]?.(evt, patchContext);
    // INVARIANT 1: only `wave-announce` (the authoritative "aware" event — the only one carrying
    // `by`) may CREATE an entry; every other event only UPDATES a wave we already know. Otherwise
    // an echoed `unsubscribed`, a late `roster`, or a racing-sync `wave-active` — none of which
    // carry `by` — spawns a phantom by-less wave.
    if (
      evt.waveId &&
      patch &&
      (evt.event === 'wave-announce' || waves.has(evt.waveId))
    ) {
      upsertWave(evt.waveId, patch);
      notify('waves');
    }
    if (evt.event === 'wave-idle' && waves.has(evt.waveId)) {
      scheduleWaveExpiry(evt.waveId); // ended → linger, then fade after the grace period
    }
  }

  // Auto-engage a wave I just started (the engine already subscribed it as the initiator) and
  // supersede my PRIOR own wave — kicking off a new one drops the last one from the UI.
  function maybeAutoSelect(evt) {
    const priorMine = [];
    if (evt.event !== 'wave-announce' || !evt.mine || !evt.waveId) {
      return;
    }
    for (const wave of waves.values()) {
      if (wave.mine && wave.waveId !== evt.waveId) {
        priorMine.push(wave.waveId);
      }
    }
    for (const waveId of priorMine) {
      removeWave(waveId);
    }
    activeWaveId = evt.waveId;
    notify('auto-select');
  }

  // --- inbound engine messages ---------------------------------------------------------------

  // INVARIANT 2: `dm` (and `note`) are wave-agnostic — a tip token must be redeemed even when it
  // arrives for a wave the user has navigated away from, or received sats are silently destroyed.
  function handleDirectedNote(evt) {
    const payload = evt.note || {};
    if (payload.kind !== 'tip' || !payload.token) {
      return;
    }
    send('redeem', { token: payload.token }); // P2PK-locked to me — swap it into my wallet
    send('refresh-wallet');
  }

  function handleEvent(evt) {
    updateDirectory(evt);
    maybeAutoSelect(evt);
    if (evt.event === 'dm') {
      handleDirectedNote(evt);
    }
  }

  function handleWallet(message) {
    const previousNetwork = wallet.network;
    let deselected = false;
    if (message.error) {
      return; // a wallet error carries no metadata to merge; hosts surface it from the raw message
    }
    wallet = mergeWalletMeta(wallet, message);
    if (wallet.network === previousNetwork) {
      notify('wallet');
      return;
    }
    // INVARIANT 4: a live mint switch can change my network — deselect the active wave if it has
    // become cross-network (its gallery + tip must go away; a cross-network tip is meaningless).
    const activeWave = activeWaveId ? waves.get(activeWaveId) : null;
    if (
      activeWave &&
      !activeWave.mine &&
      !networksMatch(wallet.network, activeWave.network)
    ) {
      activeWaveId = null;
      deselected = true;
    }
    notify(deselected ? 'deselect' : 'network');
  }

  // On a confirmed tip, deliver the bearer token PRIVATELY (unicast) so the token and the
  // who-tipped-whom never hit the flood — Chaumian privacy at the network layer too — then flood a
  // STRIPPED social-proof note (no token, no recipient) for the celebration.
  function handleTipResult(message) {
    const tipped = lastTip;
    lastTip = null;
    if (!message.hash || !tipped) {
      return;
    }
    send('dm', {
      waveId: tipped.waveId,
      to: tipped.peerId,
      note: { kind: 'tip', token: message.hash, amount: tipped.amount }
    });
    send('note', {
      waveId: tipped.waveId,
      note: { kind: 'tip', amount: tipped.amount }
    });
  }

  const MESSAGE_HANDLERS = {
    state: (message) => {
      ring = {
        me: message.me ? withCountry(message.me) : null,
        peers: (message.peers || []).map(withCountry)
      };
      notify('ring');
    },
    feed: (message) => {
      feeds.set(message.waveId, message.items || []); // cache EVERY subscribed wave's feed
      notify('feed');
    },
    event: handleEvent,
    wallet: handleWallet,
    'tip-result': handleTipResult
  };

  /**
   * Feed the core one engine message. Call this for every message, before the host's own handling
   * of it. Unknown message types are ignored (hosts handle their own narration).
   * @param {Object} message - An engine message ({type, …}).
   * @returns {void}
   */
  function handle(message) {
    if (!message || typeof message.type !== 'string') {
      return;
    }
    MESSAGE_HANDLERS[message.type]?.(message);
  }

  // --- actions ------------------------------------------------------------------------------

  /**
   * Make a wave active, subscribing to it (holding its feed cores) if we aren't already.
   * @param {string} waveId - The wave to open.
   * @returns {void}
   */
  function selectWave(waveId) {
    const wave = waves.get(waveId);
    if (!wave || waveId === activeWaveId) {
      return;
    }
    // INVARIANT 3: if the host is framing a moment for the wave we're leaving, it must stage it
    // NOW — to the OLD active wave, before the switch — or a wave that starts while we're away
    // posts nothing.
    onBeforeSwitchWave();
    activeWaveId = waveId;
    if (!wave.subscribed) {
      send('subscribe-wave', { waveId }); // browse-then-pick: hold its cores + control gossip
      wave.subscribed = true; // optimistic; the `subscribed` event confirms
    }
    notify('select');
  }

  /**
   * Tip a moment. Remembers the target so the post-confirmation choreography (dm the token, note
   * the announcement) survives the user scrubbing to another moment meanwhile.
   * @param {Object} options - Options.
   * @param {string} options.waveId - The wave the moment belongs to.
   * @param {string} options.peerId - The recipient's ring id (for the private dm).
   * @param {string} options.address - The recipient's payment address.
   * @param {number} options.amount - Amount in the wallet's unit.
   * @returns {any} Whatever the transport's `tip` returns (the desktop/mobile promise).
   */
  function tip({ waveId, peerId, address, amount }) {
    lastTip = { waveId, peerId, address, amount };
    return send('tip', { to: address, amount, peerId });
  }

  return {
    // state
    getSnapshot,
    /**
     * Subscribe to snapshots. The callback runs on every change with (snapshot, kind).
     * @param {(snapshot: Object, kind: string) => void} fn - The subscriber.
     * @returns {() => void} Unsubscribe.
     */
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    handle,
    // wave lifecycle
    selectWave,
    startWave: () => send('start-wave'),
    joinWave: (waveId) => send('join-wave', { waveId: waveId || activeWaveId }),
    removeWave,
    stageMoment: (moment, waveId) =>
      send('stage-entry', {
        waveId: waveId || activeWaveId,
        entry: asEntry(moment)
      }),
    setCountry: (country) => send('set-tag', { tag: country }),
    // money
    tip,
    redeem: (token) => send('redeem', { token }),
    fundWallet: (amount) => send('fund-wallet', { amount }),
    cashOut: (invoice) => send('cash-out', { invoice }),
    setMint: (mint) => send('set-wallet-options', { walletOptions: { mint } }),
    refreshWallet: () => send('refresh-wallet'),
    fetchTransactions: () => send('fetch-transactions'),
    /**
     * Whether a wave can transact with the active wallet (the same-network filter).
     * @param {Object} wave - A directory entry.
     * @returns {boolean} Whether it matches.
     */
    waveMatchesNetwork: (wave) => networksMatch(wallet.network, wave?.network),
    /**
     * Cancel every pending timer. Call when the host tears down.
     * @returns {void}
     */
    close() {
      for (const handleId of expiryTimers.values()) {
        clearTimer(handleId);
      }
      expiryTimers.clear();
      subscribers.clear();
    }
  };
}
