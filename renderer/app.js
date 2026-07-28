// HyperWave renderer - orchestrator. Wires worker events (ipc) to the views:
// ring (canvas), gallery (centre moment + progress), lobby, proof (webcam), hud.
//
// The STATE + RULES behind the views live in `hyperwave-app-core` (the wave directory, active-wave
// selection, the ended-wave lifecycle, wallet metadata + the same-network filter, and the tip
// choreography) — the same core the mobile host drives, so the two UIs can't drift on the rules.
// This file is the desktop's presentation half: it feeds every engine message to the core FIRST,
// then paints from the core's snapshots and its own per-event narration below.
import * as ipc from './lib/ipc.js';
import * as ring from './lib/ring.js';
import * as gallery from './lib/gallery.js';
import * as scrubber from './lib/scrubber.js';
import * as lobby from './lib/lobby.js';
import * as proof from './lib/proof.js';
import * as hud from './lib/hud.js';
import * as wallet from './lib/wallet.js';
import { getActiveWave, setActiveWave } from './lib/active.js';
import { setWalletMeta, unitLabel } from './lib/wallet-meta.js';
// The shared app core. Imported by PATH (not by package name): a file:// renderer has no bare
// specifier resolution, and the package is plain ESM precisely so no bundler step is needed.
import { createAppCore } from '../node_modules/hyperwave-app-core/index.js';

// Start frame animation loop for the ring (2d canvas) + the circular scrubber (drag the spark
// around the ring to browse the gallery once the completion replay has run).
ring.start();
scrubber.init();

// The orchestrator's UI state - a single source of truth. Mutate only via setState() so updates
// are explicit and in one place; the views below are still driven imperatively off the ipc events.
const state = {
  countrySent: false, // one-shot: pushed our saved country to the worker once it came up
  peers: 0, // number of live peers in the ring (drives the status line)
  lobbyDeadline: 0 // ~when the lobby closes (wave start), for the capture countdown
};
const setState = (patch) => Object.assign(state, patch);

const fieldEl = document.querySelector('.field'); // the ring + gallery canvas area (dimmable)

// The shared brain. `performance.now()` is the clock so the core's lobby deadlines and ended-wave
// TTL share this renderer's time base; `onBeforeSwitchWave` is how the core enforces "stage the
// pending capture BEFORE leaving a wave" (app-core invariant 3) without knowing about webcams.
const core = createAppCore({
  send: (type, args) => ipc.sendCommand(type, args),
  now: () => performance.now(),
  onBeforeSwitchWave: () => proof.captureAndStage()
});

// Dev-only console handle (`hw` = HyperWave): reach the orchestrator state + view modules from the
// DevTools console, e.g. `hw.state`, `hw.core.getSnapshot()`, `hw.gallery.count()`. ES modules
// don't expose their bindings globally, so nothing is reachable unless we put it here — which is
// exactly why we DON'T in a packaged build (keeps a shipped app's global scope clean). `npm start`
// is unpackaged, so the handle is present in dev only.
if (window.bridge?.isPackaged && !window.bridge.isPackaged()) {
  window.hw = {
    state,
    core,
    ring,
    gallery,
    scrubber,
    lobby,
    proof,
    hud,
    ipc,
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

// --- concurrent waves: the core's directory + active wave (scaling.md browse-then-pick) --------
// The engine is aware of many waves at once (autoSubscribe:false → no cores until we pick one).
// The core keeps the metadata for every announced wave and a cached feed per wave; only the ACTIVE
// wave drives the ring centre (gallery / lobby / capture). Each wave is a CONCENTRIC RING on the
// canvas (ring.js — this replaced the orbiting bubbles); clicking one asks the core to select it,
// which subscribes (holds its cores) and republishes.
ring.onWaveSelect((waveId) => core.selectWave(waveId));
// The ✕ on a ring: push that wave away for good (app-core invariant 6 — the engine keeps
// gossiping about a live wave, so the core remembers the dismissal and never re-admits it). This
// is the manual counterpart of the automatic linger → fade → drop, and it frees the wave's cores.
ring.onWaveDismiss((waveId) => core.dismissWave(waveId));

// Paint the wave rings from the core's snapshot. The ring module owns the cross-network filter and
// the initiator-flag lookup itself (it already holds the topic ring), so this is just a handoff.
// The active wave's ring also draws the seats of everyone whose moment has landed, so it fills in
// as the wave syncs — `snapshot.feed` is always the ACTIVE wave's feed (browse-then-pick holds no
// cores for the others, so there is nothing to draw for them).
function renderDirectory(snapshot) {
  ring.setWaves(snapshot.waves, snapshot.activeWaveId);
  ring.setActiveSeats(
    snapshot.activeWaveId
      ? snapshot.feed.map((moment) => ({
          id: moment.peerId,
          country: moment.country
        }))
      : []
  );
}

// Paint the ring centre for whatever the active wave is right now (used when switching waves).
function renderActiveWave() {
  const snapshot = core.getSnapshot();
  const wave = snapshot.activeWave;
  ring.stopSweep();
  gallery.cancelReplay();
  gallery.close();
  lobby.close();
  proof.close();
  setDim(false);
  hud.waveStatus('');
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
        message: wave.message, // what the initiator said this wave is about
        lobbyMs: Math.max(0, (wave.lobbyDeadline || 0) - performance.now())
      });
      lobby.setJoinable(wave.paid === 'verified');
    }
  } else {
    // racing / ended — show its (cached) gallery. setActive FIRST: the close() above left the
    // gallery closed, and handle() ignores feed repaints while closed (it would otherwise paint
    // nothing until the engine's next periodic re-emit).
    gallery.setActive(wave.phase === 'racing');
    gallery.handle(snapshot.feed);
    if (wave.phase !== 'racing') {
      gallery.restoreReplay(); // ended: bring the spark back, parked + draggable
    }
    hud.showStart(wave.phase !== 'racing');
  }
  updateHud();
}

// The core republishes on every change and says WHAT changed, so each kind repaints only what it
// must. `select`/`deselect`/`network` are the transitions that re-own the ring centre;
// `auto-select` (my own new wave) deliberately does NOT repaint here — its wave-announce handler
// below drives that, including the capture flow.
const SNAPSHOT_PAINTERS = {
  ring: (snapshot) => {
    ring.setState({ me: snapshot.me, peers: snapshot.peers });
    setState({ peers: snapshot.peers.length });
    updateHud();
    renderDirectory(snapshot); // flags resolve as peers appear on the ring
  },
  waves: renderDirectory,
  'auto-select': renderDirectory,
  select: (snapshot) => {
    renderDirectory(snapshot);
    renderActiveWave();
  },
  deselect: (snapshot) => {
    renderDirectory(snapshot);
    renderActiveWave(); // the wave I was viewing is gone → empty ring + Start
  },
  network: (snapshot) => {
    // A live mint switch changed my network: re-render so now-cross-network waves are hidden, and
    // repaint the centre (the core has already deselected a wave that became cross-network).
    renderDirectory(snapshot);
    renderActiveWave();
  },
  feed: (snapshot) => {
    if (!snapshot.activeWaveId) {
      return;
    }
    gallery.handle(snapshot.feed); // only the active wave paints the ring centre
    renderDirectory(snapshot); // its ring gains a seat as each moment lands
    updateHud();
  },
  wallet: () => {}
};

core.subscribe((snapshot, kind) => {
  setActiveWave(snapshot.activeWaveId); // mirror for the view modules (lobby/proof read it)
  SNAPSHOT_PAINTERS[kind]?.(snapshot);
});

// Every engine message reaches the core BEFORE this file's own handlers for it (ipc listeners run
// in registration order), so the directory + active wave are current when the views paint.
for (const type of ['state', 'event', 'feed', 'wallet', 'tip-result']) {
  ipc.on(type, (msg) => core.handle(msg));
}

ipc.on('state', () => {
  if (!state.countrySent) {
    setState({ countrySent: true });
    hud.sendCountry(); // worker is up - tell it the nation we support
  }
});

ipc.on('wallet', (msg) => {
  setWalletMeta(msg); // ambient unit + mint + network for the views' labels
  wallet.walletStatus(msg); // self-custodial wallet address + balance (wallet-view modal)
  gallery.setMyAddress(msg.address); // so we do not offer to tip our own moment
});
// Cashu top-up (fund-wallet) and tip redeem (receive) results — surfaced as toasts.
ipc.on('fund-result', (msg) => wallet.fundResult(msg));
// Cash out (melt ecash → Lightning) result — surfaced in the wallet modal's cash-out form.
ipc.on('cash-out-result', (msg) => wallet.cashOutResult(msg));
ipc.on('redeem-result', (msg) => {
  if (!msg.error && msg.amount > 0) {
    hud.waveStatus(`🎉 tip redeemed — +${msg.amount} ${unitLabel(msg.amount)}`);
  }
});
ipc.on('tip-result', (msg) => gallery.tipResult(msg));
ipc.on('transactions', (msg) => wallet.setTransactions(msg.list));
ipc.on('burn-result', (msg) => {
  // participation fee (start or join), burned to the NUMS black-hole pubkey (skin in the game).
  // `stage` keeps us from claiming "burned" before the burn is confirmed. A Cashu burn is a bearer
  // token that settles instantly — no block explorer, no on-chain wait.
  const what = msg.reason === 'join' ? 'join' : 'start';
  if (msg.stage === 'confirming') {
    hud.waveStatus(`⏳ confirming ${what} burn…`);
  } else if (msg.stage === 'failed') {
    hud.waveStatus(`⚠️ ${what} fee burn failed: ${msg.error}`);
  } else {
    hud.waveStatus(
      `🔥 ${what} fee burned - ${msg.amount} ${unitLabel(msg.amount)}`
    );
  }
});

// Starting a wave carries the initiator's own words: app-core maps the message to the engine's
// opaque announce `meta`, so every peer browsing the directory sees why to join.
hud.onStart((message) => core.startWave(message));

// The gallery's tip button goes through the core, which remembers the target and — once the tip
// confirms — delivers the bearer token privately + floods the stripped announcement.
gallery.onTip((target) => core.tip(target));

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
      // the raw event carries the engine's opaque `meta`; the core's snapshot has it mapped to
      // `message`, so read it from there rather than re-deriving the theme mapping here
      lobby.open({
        ...evt,
        message: core.getSnapshot().waves.get(evt.waveId)?.message || ''
      });
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
  // deliver a Cashu tip: a bearer token (P2PK-locked to me) the CORE redeems (wave-agnostically —
  // app-core invariant 2) while this handler runs the celebration. This is the private counterpart
  // of the flooded `note`: the token + who-tipped-whom never hit the flood.
  dm: (evt) => {
    const payload = evt.note || {};
    if (payload.kind !== 'tip' || !payload.token) {
      return;
    }
    hud.waveStatus(
      `🎉 you got tipped ${payload.amount} ${unitLabel(payload.amount)}!`
    );
    ring.startFlourish(); // golden pulse + confetti — same celebration as a completed wave
  },

  // A roster member broadcast a note on the wave (flooded). A Cashu tip note is a STRIPPED
  // social-proof announcement (no token, no recipient — the actual bearer token arrives privately
  // via `dm`), so this just celebrates that a moment was tipped.
  note: (evt) => {
    const payload = evt.note || {};
    if (payload.kind !== 'tip') {
      return;
    }
    hud.waveStatus(
      `💸 a moment was tipped ${payload.amount} ${unitLabel(payload.amount)}`
    );
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

// Wallet/celebration events touch MY wallet regardless of which wave I'm viewing (e.g. a Cashu tip
// received on a wave I've since navigated away from), so they run unconditionally.
const WAVE_AGNOSTIC_EVENTS = new Set(['dm', 'note']);

// Narration for the wave the user is watching. The core has already applied this event to the
// directory + active wave (its listener is registered first), so `getActiveWave()` is current.
ipc.on('event', (evt) => {
  const forActive = evt.waveId && evt.waveId === getActiveWave();
  if (WAVE_AGNOSTIC_EVENTS.has(evt.event) || forActive) {
    EVENT_HANDLERS[evt.event]?.(evt);
  }
});
