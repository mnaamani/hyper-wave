// HyperWave renderer - orchestrator. Wires worker events (ipc) to the views:
// ring (canvas), gallery (centre moment + progress), lobby, proof (webcam), hud.
import * as ipc from './lib/ipc.js';
import * as ring from './lib/ring.js';
import * as gallery from './lib/gallery.js';
import * as scrubber from './lib/scrubber.js';
import * as lobby from './lib/lobby.js';
import * as proof from './lib/proof.js';
import * as hud from './lib/hud.js';
import * as wallet from './lib/wallet.js';
import * as directory from './lib/directory.js';
import { getActiveWave, setActiveWave } from './lib/active.js';
import {
  setWalletMeta,
  unitLabel,
  isCashu,
  activeNetwork,
  networkMatches
} from './lib/wallet-meta.js';
import { txLink } from './lib/explorer.js';

// Start frame animation loop for the ring (2d canvas) + the circular scrubber (drag the spark
// around the ring to browse the gallery once the completion replay has run).
ring.start();
scrubber.init();

// The orchestrator's UI state - a single source of truth. Mutate only via setState() so updates
// are explicit and in one place; the views below are still driven imperatively off the ipc events.
const state = {
  countrySent: false, // one-shot: pushed our saved country to the worker once it came up
  peers: 0, // number of live peers in the ring (drives the status line)
  lobbyDeadline: 0, // ~when the lobby closes (wave start), for the capture countdown
  myAddress: null // my wallet address — to recognise a tip note addressed to me
};
const setState = (patch) => Object.assign(state, patch);

const fieldEl = document.querySelector('.field'); // the ring + gallery canvas area (dimmable)

// Dev-only console handle (`hw` = HyperWave): reach the orchestrator state + view modules from the
// DevTools console, e.g. `hw.state`, `hw.gallery.count()`, `hw.hud.waveStatus('test')`. ES modules
// don't expose their bindings globally, so nothing is reachable unless we put it here — which is
// exactly why we DON'T in a packaged build (keeps a shipped app's global scope clean). `npm start`
// is unpackaged, so the handle is present in dev only.
if (window.bridge?.isPackaged && !window.bridge.isPackaged()) {
  window.hw = {
    state,
    ring,
    gallery,
    scrubber,
    lobby,
    proof,
    hud,
    ipc,
    directory,
    getActiveWave
  };
}

// Fade the ring + gallery (a new wave's lobby is up) so the countdown reads clearly; the lobby
// countdown is an HTML overlay above the canvas, so it stays crisp.
function setDim(on) {
  fieldEl.classList.toggle('dim', on);
}
// "Not now" in the lobby: un-dim and let the peer keep browsing the gallery they were viewing.
lobby.onCancel(() => setDim(false));

// Capturing the moment closes the camera preview, so confirm it on the status line (it'll post to
// the gallery when this peer's sweep slot fires).
proof.onCaptured(() => {
  hud.waveStatus('📸 moment captured — get ready for the wave!');
  // fill the ring centre while the lobby finishes + moments sync (instead of a blank centre)
  gallery.setWaiting('📸 captured — waiting for the wave…');
});

// Swap the join panel for the camera and start framing the lobby moment. Leaving the old wave's
// gallery to take part in a new one: close its view and clear the frozen replay/scrubber.
function beginCapture() {
  setDim(false);
  ring.stopSweep();
  gallery.cancelReplay();
  gallery.close();
  lobby.close();
  proof.open(Math.max(0, state.lobbyDeadline - performance.now()));
}

// Update the HUD's persistent chrome from state: the network status line (peer count) + the
// docked start button. The live wave narration is a separate element (hud.waveStatus /
// #wave-status), so this runs freely — even mid-wave — without clobbering it.
function updateHud() {
  hud.networkStatus({ peers: state.peers });
  // keep the start button off the gallery
  hud.dockStart(gallery.count() > 0);
}

// The engine is theme-agnostic: a peer's cosmetic `tag` is this app's country code, and a
// feed entry carries an opaque `payload` this app fills with a {image, caption} moment.
// Map the engine's generic shape back to the app UI's shape right here at the inbound
// boundary, so the rest of the UI keeps reading `.country` / `.image` / `.caption`.
function withCountry(peer) {
  return { ...peer, country: peer.tag };
}
function asMoment(item) {
  return {
    ...item,
    image: item.payload?.image || '',
    caption: item.payload?.caption || '',
    country: item.tag
  };
}

// --- concurrent waves: directory + active wave (scaling.md browse-then-pick) ----------------
// The engine is aware of many waves at once (autoSubscribe:false → no cores until we pick one).
// We keep lightweight metadata for every announced wave (the directory) and a cached feed per
// wave; only the ACTIVE wave drives the ring centre (gallery / lobby / capture). Selecting a
// directory row subscribes to that wave (holds its cores) and makes it active.
const waves = new Map(); // waveId -> { waveId, by, mine, joined, subscribed, phase, count, fee, walletType, paid, network, lobbyDeadline }
const feedByWave = new Map(); // waveId -> raw feed items (rendered when its wave is active)
let ringState = { me: null, peers: [] }; // the global heartbeat ring, for the directory's flags

// The directory shows the initiator's country flag; derive it from the global ring by id.
directory.setCountryLookup((id) => {
  if (ringState.me && ringState.me.id === id) {
    return ringState.me.country;
  }
  const peer = ringState.peers.find((one) => one.id === id);
  return peer ? peer.country : '';
});
directory.onSelect((waveId) => selectWave(waveId));

// Merge a metadata patch into a wave and re-render the directory panel.
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
  directory.render(waves, getActiveWave());
}

// Make a wave active (engine already subscribed it, e.g. my own started wave). No view repaint —
// the caller's event handler paints. Use selectWave() for a user-initiated directory pick.
function activateWave(waveId) {
  setActiveWave(waveId);
  directory.render(waves, waveId);
}

// User picked a wave in the directory: subscribe (hold its cores) if not already, make it active,
// and paint its current state (its gallery, or its lobby if it's still forming and I haven't joined).
function selectWave(waveId) {
  const wave = waves.get(waveId);
  if (!wave || waveId === getActiveWave()) {
    return;
  }
  // If I'm framing a moment for the wave I'm leaving, lock it in now (stage to the OLD active
  // wave, before switching) — otherwise a wave that starts while I'm away would post nothing.
  proof.captureAndStage();
  setActiveWave(waveId);
  if (!wave.subscribed) {
    ipc.subscribeWave(waveId); // browse-then-pick: hold this wave's feed cores + control gossip
    wave.subscribed = true; // optimistic; the 'subscribed' event confirms
  }
  directory.render(waves, waveId);
  renderActiveWave();
}

// Paint the ring centre for whatever the active wave is right now (used when switching waves).
function renderActiveWave() {
  ring.stopSweep();
  gallery.cancelReplay();
  gallery.close();
  lobby.close();
  proof.close();
  setDim(false);
  hud.waveStatus('');
  const wave = getActiveWave() ? waves.get(getActiveWave()) : null;
  if (!wave) {
    hud.showStart(true);
    gallery.setActive(false);
    updateHud();
    return;
  }
  if (wave.phase === 'lobby') {
    setState({
      lobbyDeadline: wave.lobbyDeadline || performance.now() + 15000
    });
    hud.showStart(false);
    if (wave.joined) {
      // I'm in this lobby (my own wave, or one I joined) — reopen the camera so I can keep
      // framing my moment until it starts (this is what was lost when switching away + back).
      beginCapture();
    } else {
      // a forming lobby I only selected — offer to join it
      setDim(true);
      lobby.open({
        count: wave.count,
        mine: wave.mine,
        joined: wave.joined,
        fee: wave.fee,
        lobbyMs: Math.max(0, (wave.lobbyDeadline || 0) - performance.now())
      });
      lobby.setJoinable(wave.paid === 'verified');
    }
  } else {
    // racing / ended — show its (cached) gallery
    const items = feedByWave.get(wave.waveId) || [];
    gallery.handle(items.map(asMoment));
    gallery.setActive(wave.phase === 'racing');
    hud.showStart(wave.phase !== 'racing');
  }
  updateHud();
}

// An ended wave lingers in the orbit (its gallery still browsable) for a grace period, then
// fades out and is dropped from the directory — and its cores are freed (O(subscribed)).
const ENDED_TTL_MS = 180000; // ~3 minutes
const FADE_MS = 600; // matches the bubble's CSS fade-out
const expiryTimers = new Map(); // waveId -> one-shot timeout handle

// Drop a wave from the UI now: free its cores, forget its metadata + cached feed, and if I was
// viewing it, fall back to the empty ring. Used both by the grace-period fade and when my own
// new wave supersedes a prior one.
function removeWave(waveId) {
  const wave = waves.get(waveId);
  clearTimeout(expiryTimers.get(waveId));
  expiryTimers.delete(waveId);
  if (wave && wave.subscribed) {
    ipc.unsubscribeWave(waveId); // free its feed cores now the wave is gone
  }
  waves.delete(waveId);
  feedByWave.delete(waveId);
  if (getActiveWave() === waveId) {
    setActiveWave(null);
    renderActiveWave(); // the wave I was viewing is gone → empty ring + Start
  } else {
    directory.render(waves, getActiveWave());
  }
}

// Fade the bubble out (CSS), then remove the wave once the animation has run.
function fadeOutWave(waveId) {
  const wave = waves.get(waveId);
  if (!wave) {
    return;
  }
  wave.fading = true; // directory.render adds a .fading class → the CSS fade-out plays
  directory.render(waves, getActiveWave());
  setTimeout(() => removeWave(waveId), FADE_MS);
}

// Start the grace-period countdown for an ended wave (re-armed if wave-idle fires again).
function scheduleWaveExpiry(waveId) {
  clearTimeout(expiryTimers.get(waveId));
  expiryTimers.set(
    waveId,
    setTimeout(() => fadeOutWave(waveId), ENDED_TTL_MS)
  );
}

// Per-event metadata patch for the directory (missing kinds = no directory change).
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
    network: evt.network, // settlement network (from the start burn) — for the same-network filter
    phase: 'lobby',
    lobbyDeadline: performance.now() + (evt.lobbyMs || 15000)
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

function updateDirectory(evt) {
  const patch = DIRECTORY_PATCH[evt.event]?.(evt);
  // Only wave-announce (the authoritative "aware" event — the only one carrying `by`) may CREATE
  // a directory entry; every other event only UPDATES a wave we already know. Otherwise an echoed
  // `unsubscribed` (after we removed a wave), a late `roster`, or a racing-sync `wave-active` —
  // none of which carry `by` — would spawn a phantom by-less bubble at the top of the ring.
  if (
    evt.waveId &&
    patch &&
    (evt.event === 'wave-announce' || waves.has(evt.waveId))
  ) {
    upsertWave(evt.waveId, patch);
  }
  if (evt.event === 'wave-idle' && waves.has(evt.waveId)) {
    scheduleWaveExpiry(evt.waveId); // ended → linger, then fade out after the grace period
  }
}

// Auto-engage a wave I just started (the engine already subscribed it as the initiator), and
// supersede my PRIOR own wave immediately — kicking off a new one drops the last one from the UI.
function maybeAutoSelect(evt) {
  if (evt.event !== 'wave-announce' || !evt.mine || !evt.waveId) {
    return;
  }
  const priorMine = [...waves.values()]
    .filter((wave) => wave.mine && wave.waveId !== evt.waveId)
    .map((wave) => wave.waveId);
  for (const waveId of priorMine) {
    removeWave(waveId);
  }
  activateWave(evt.waveId);
}

ipc.on('state', (msg) => {
  if (!state.countrySent) {
    setState({ countrySent: true });
    hud.sendCountry(); // worker is up - tell it the nation we support
  }
  ringState = { me: withCountry(msg.me), peers: msg.peers.map(withCountry) };
  ring.setState(ringState);
  setState({ peers: msg.peers.length });
  updateHud();
  directory.render(waves, getActiveWave()); // flags resolve as peers appear on the ring
});

ipc.on('feed', (msg) => {
  feedByWave.set(msg.waveId, msg.items); // cache every subscribed wave's feed
  if (msg.waveId === getActiveWave()) {
    gallery.handle(msg.items.map(asMoment)); // only the active wave paints the ring centre
    updateHud();
  }
});

ipc.on('wallet', (msg) => {
  const prevNetwork = activeNetwork();
  setWalletMeta(msg); // active mechanism + unit + mint + network, for labels + the same-network filter
  wallet.walletStatus(msg); // self-custodial wallet address + balance (wallet-view modal)
  gallery.setMyAddress(msg.address); // so we do not offer to tip our own moment
  setState({ myAddress: msg.address }); // to recognise a tip note addressed to me
  // A live mint switch can change my network — re-render the directory so now-cross-network waves are
  // hidden, and DESELECT the active wave if it's become cross-network (its gallery + tip must go away,
  // a cross-network tip is meaningless). Only when the network actually changed.
  if (activeNetwork() !== prevNetwork) {
    const activeId = getActiveWave();
    const activeWave = activeId ? waves.get(activeId) : null;
    if (activeWave && !activeWave.mine && !networkMatches(activeWave.network)) {
      setActiveWave(null);
    }
    directory.render(waves, getActiveWave());
    renderActiveWave();
  }
});
// Cashu top-up (fund-wallet) and tip redeem (receive) results — surfaced as toasts.
ipc.on('fund-result', (msg) => wallet.fundResult(msg));
ipc.on('redeem-result', (msg) => {
  if (!msg.error && msg.amount > 0) {
    hud.waveStatus(`🎉 tip redeemed — +${msg.amount} ${unitLabel()}`);
  }
});
// The seed's BIP-44 accounts (for the wallet-view picker); a distinct address per index.
ipc.on('accounts', (msg) => wallet.setAccounts(msg));
ipc.on('tip-result', (msg) => {
  gallery.tipResult(msg);
  if (msg.hash) {
    wallet.record({ kind: 'tip', hash: msg.hash, amount: msg.amount });
  }
});
ipc.on('send-result', (msg) => wallet.sendResult(msg));
ipc.on('transactions', (msg) => wallet.setTransactions(msg.list));
ipc.on('burn-result', (msg) => {
  // participation fee (start or join), burned to the black hole (skin in the game). `stage`
  // keeps us from claiming "burned" before the tx is actually confirmed on-chain.
  const what = msg.reason === 'join' ? 'join' : 'start';
  // A chain burn links to its block explorer + confirms on-chain; a Cashu burn is a
  // bearer token (no explorer) that settles instantly, so drop both for ecash.
  const tx = msg.hash && !isCashu() ? [' (', txLink(msg.hash), ')'] : [];
  const onChain = isCashu() ? '' : ' on-chain';
  if (msg.stage === 'confirming') {
    hud.waveStatusNodes(`⏳ confirming ${what} burn${onChain}…`, ...tx);
  } else if (msg.stage === 'failed') {
    hud.waveStatus(`⚠️ ${what} fee burn failed: ${msg.error}`);
  } else {
    hud.waveStatusNodes(
      `🔥 ${what} fee burned - ${msg.amount} ${unitLabel()}`,
      ...tx
    );
    wallet.record({ kind: 'burn', hash: msg.hash, amount: msg.amount }); // 'burned' stage
  }
});

// One handler per engine event — a lookup table instead of a switch (CLAUDE.md Code Style).
const EVENT_HANDLERS = {
  'wave-announce': (evt) => {
    setState({ lobbyDeadline: performance.now() + (evt.lobbyMs || 15000) });
    hud.showStart(false);
    hud.waveStatus(''); // clear the previous wave's narration; this wave's fills in below
    gallery.hideProgress();
    if (evt.mine) {
      // initiator: kicking off leaves the old gallery behind — close its view now (and keep it
      // closed through paying/capture so a lingering feed can't repaint behind the capture modal),
      // then capture once the wave is live (immediately if paid, else wait for wave-verified)
      ring.stopSweep();
      gallery.cancelReplay();
      gallery.close();
      setDim(false);
      if (evt.paid === 'verified') {
        beginCapture();
      } else {
        hud.waveStatus('🔥 paying the start fee…');
      }
    } else {
      // joiner-candidate: fade the previous gallery so the countdown reads clearly, but keep
      // it browsable underneath. Join → capture (clears it); "Not now" → un-dim + keep browsing.
      // The join button stays disabled until the start payment verifies (anti-spam).
      setDim(true);
      lobby.open(evt);
      lobby.setJoinable(evt.paid === 'verified');
    }
  },

  paying: () => {
    hud.waveStatus('🔥 paying the start fee…');
  },

  'wave-verified': (evt) => {
    if (evt.mine) {
      beginCapture(); // initiator's wave is now live + paid
    } else {
      lobby.setJoinable(true); // safe to join - the start fee is proven paid
    }
  },

  'wave-unpaid': () => {
    hud.waveStatus('⚠️ ignored an unpaid wave');
    setDim(false);
    lobby.close();
  },

  // The engine refused a join and says WHY (reason). `pending` is transient — the join button
  // re-enables when `wave-verified` fires, so keep the lobby open. Every other reason is terminal
  // (I can’t take a seat), so drop the lobby and let the peer keep browsing (spectate), like "Not now".
  'join-blocked': (evt) => {
    const messageByReason = {
      'roster-full': '🚧 this wave is full — spectating',
      'wallet-unsupported': evt.walletType
        ? `💸 can’t join — this wave needs a ${evt.walletType} wallet`
        : '💸 can’t join — no compatible wallet',
      pending: '⏳ verifying the wave’s start payment…',
      rejected: '⚠️ the wave’s start payment was rejected'
    };
    hud.waveStatus(messageByReason[evt.reason] || '🚫 can’t join this wave');
    if (evt.reason !== 'pending') {
      setDim(false);
      lobby.close();
    }
  },

  // opted in - swap the join panel for the camera
  joined: () => {
    beginCapture();
  },

  roster: (evt) => {
    lobby.update(evt.count);
  },

  'wave-active': (evt) => {
    hud.showStart(false);
    setDim(false); // wave is racing — restore the ring (lobby may have timed out still dimmed)
    lobby.close();
    // Free the ring centre FIRST (snap + stage the lobby moment, then close the capture modal),
    // THEN reopen the gallery for the racing wave — so the gallery can't repaint behind a still-open
    // capture in the gap.
    proof.captureAndStage();
    gallery.setExpected(evt.count || 1);
    gallery.setActive(true);
    // Start the spark tracing NOW (the wave is racing) so it sweeps the ring as moments sync in,
    // featuring each as it passes — rather than as a replay after the wave has already completed.
    // startReplay is pending-safe: it begins the moment the first entry lands.
    gallery.startReplay();
    hud.waveStatus(
      evt.joined
        ? '📸 captured — here comes the wave!'
        : '👀 spectating this wave'
    );
  },

  'wave-idle': () => {
    hud.showStart(true);
    gallery.setActive(false);
    setDim(false); // safety: never leave the ring faded if the lobby exited without a race
    // NB: do NOT stop the replay here — `completed` fires immediately before `wave-idle`, and
    // the frozen replay + scrubber are meant to persist through idle so the gallery stays
    // browsable. The replay is cleared when the NEXT wave forms (wave-announce).
    lobby.close();
    proof.close();
    // refresh the status line + dock button now the wave is over. We deliberately DON'T clear
    // the wave-status here — it keeps the last result (completed) on screen
    // until the next wave's wave-announce clears it.
    updateHud();
  },

  busy: () => {
    hud.waveStatus('⏳ a wave is already forming - wait for it to finish');
  },

  started: () => {
    hud.waveStatus('⚡ the wave is off!');
  },

  // the spark reached me - my staged moment posts now (worker-side). The race is near-instant
  // (network speed); the visible spark roll is the completion replay below, not this event.
  holding: (evt) => {
    hud.waveStatus(
      `📸 your moment joins the wave! — hop ${evt.hopCount ?? ''}`
    );
  },

  // live protocol progress only — ball animation is the replay sweep, not per-hop events
  position: (evt) => {
    hud.waveStatus(`wave rolling - hop ${evt.hopCount ?? ''}`);
  },

  // A DIRECTED (private) note addressed to me — the engine already checked it's for me. Used to
  // deliver a Cashu tip: a bearer token (P2PK-locked to me) I redeem to credit the funds. This is
  // the private counterpart of the flooded `note` — the token + who-tipped-whom never hit the flood.
  dm: (evt) => {
    const payload = evt.note || {};
    if (payload.kind !== 'tip' || !payload.token) {
      return;
    }
    hud.waveStatus(`🎉 you got tipped ${payload.amount} ${unitLabel()}!`);
    ring.startFlourish(); // golden pulse + confetti — same celebration as a completed wave
    ipc.redeem(payload.token); // Cashu bearer token, locked to me — swap it into my wallet
    ipc.refreshWallet();
  },

  // A roster member broadcast a note on the wave (flooded). For a CHAIN wallet (Tron) the tip is
  // public anyway, so the note carries `to` + `hash`: if addressed to my wallet I got tipped
  // (celebrate + refresh). For CASHU the note is a stripped social-proof announcement (no token, no
  // recipient — the token comes via `dm`), so it falls through to the "a moment was tipped" line.
  note: (evt) => {
    const payload = evt.note || {};
    if (payload.kind !== 'tip') {
      return;
    }
    if (payload.to && payload.to === state.myAddress) {
      hud.waveStatus(`🎉 you got tipped ${payload.amount} ${unitLabel()}!`);
      ring.startFlourish();
      if (payload.hash) {
        ipc.redeem(payload.hash); // chain tip: redeem is a no-op; settled on-chain
      }
      ipc.refreshWallet();
    } else {
      hud.waveStatus(`💸 a moment was tipped ${payload.amount} ${unitLabel()}`);
    }
  },

  // a completed wave always has ≥1 moment (the initiator's) — it may land a beat after this
  // event, so gallery.startReplay() defers until it arrives.
  completed: (evt) => {
    hud.waveStatus(`✅ wave completed - ${evt.hops} hops`);
    ring.startFlourish(); // orange ring pulse + confetti — the wave made it all the way around
    // The spark is already sweeping (started at wave-active); ensure it's running in case the
    // wave completed instantly before any moment landed to kick it off.
    gallery.startReplay();
  }
};

// Wallet/celebration events touch MY wallet regardless of which wave I'm viewing (e.g. redeeming
// a Cashu tip received on a wave I've since navigated away from), so they run unconditionally.
const WAVE_AGNOSTIC_EVENTS = new Set(['dm', 'note']);

// Route every engine event: keep the directory in sync for ALL waves, auto-engage my own new wave,
// then drive the ring-centre view ONLY for the active wave (a background wave can't clobber it).
ipc.on('event', (evt) => {
  updateDirectory(evt);
  maybeAutoSelect(evt);
  const forActive = evt.waveId && evt.waveId === getActiveWave();
  if (WAVE_AGNOSTIC_EVENTS.has(evt.event) || forActive) {
    EVENT_HANDLERS[evt.event]?.(evt);
  }
});
