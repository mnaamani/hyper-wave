// HyperWave renderer - orchestrator. Wires worker events (ipc) to the views:
// ring (canvas), gallery (centre selfie + progress), lobby, proof (webcam), hud.
import * as ipc from './lib/ipc.js';
import * as ring from './lib/ring.js';
import * as gallery from './lib/gallery.js';
import * as scrubber from './lib/scrubber.js';
import * as lobby from './lib/lobby.js';
import * as proof from './lib/proof.js';
import * as hud from './lib/hud.js';
import * as wallet from './lib/wallet.js';
import { txLink } from './lib/explorer.js';

// Start frame animation loop for the ring (2d canvas) + the circular scrubber (drag the ⚽
// around the ring to browse the gallery once the completion replay has run).
ring.start();
scrubber.init();

// The orchestrator's UI state - a single source of truth. Mutate only via setState() so updates
// are explicit and in one place; the views below are still driven imperatively off the ipc events.
const state = {
  countrySent: false, // one-shot: pushed our saved team to the worker once it came up
  peers: 0, // number of live peers in the ring (drives the status line)
  lobbyDeadline: 0 // ~when the lobby closes (kickoff), for the capture countdown
};
const setState = (patch) => Object.assign(state, patch);

const fieldEl = document.querySelector('.field'); // the ring + gallery canvas area (dimmable)

// Dev-only console handle (`hw` = HyperWave): reach the orchestrator state + view modules from the
// DevTools console, e.g. `hw.state`, `hw.gallery.count()`, `hw.hud.waveStatus('test')`. ES modules
// don't expose their bindings globally, so nothing is reachable unless we put it here — which is
// exactly why we DON'T in a packaged build (keeps a shipped app's global scope clean). `npm start`
// is unpackaged, so the handle is present in dev only.
if (window.bridge?.isPackaged && !window.bridge.isPackaged()) {
  window.hw = { state, ring, gallery, scrubber, lobby, proof, hud, ipc };
}

// Fade the ring + gallery (a new wave's lobby is up) so the countdown reads clearly; the lobby
// countdown is an HTML overlay above the canvas, so it stays crisp.
function setDim(on) {
  fieldEl.classList.toggle('dim', on);
}
// "Not now" in the lobby: un-dim and let the peer keep browsing the gallery they were viewing.
lobby.onCancel(() => setDim(false));

// Swap the join panel for the camera and start framing the lobby selfie. Leaving the old wave's
// gallery to take part in a new one: close its view and clear the frozen replay/scrubber.
function beginCapture() {
  setDim(false);
  ring.stopSweep();
  gallery.cancelReplay();
  gallery.clearView();
  lobby.close();
  proof.open(Math.max(0, state.lobbyDeadline - performance.now()));
}

// Update the HUD's persistent chrome from state: the network status line (peer count) + the
// docked kick-off button. The live wave narration is a separate element (hud.waveStatus /
// #wave-status), so this runs freely — even mid-wave — without clobbering it.
function updateHud() {
  hud.networkStatus(
    state.peers === 0
      ? 'in the ring - waiting for peers...'
      : `${state.peers} peer${state.peers === 1 ? '' : 's'} in the ring.`
  );
  // keep the kickoff button off the gallery
  hud.dockStart(gallery.count() > 0);
}

// The engine is theme-agnostic: a peer's cosmetic `tag` is this app's country code, and a
// feed entry carries an opaque `payload` this app fills with a {image, caption} selfie.
// Map the engine's generic shape back to the football UI's shape right here at the inbound
// boundary, so the rest of the UI keeps reading `.country` / `.image` / `.caption`.
function asFootballPeer(peer) {
  return { ...peer, country: peer.tag };
}
function asSelfie(item) {
  return {
    ...item,
    image: item.payload?.image || '',
    caption: item.payload?.caption || '',
    country: item.tag
  };
}

ipc.on('state', (msg) => {
  if (!state.countrySent) {
    setState({ countrySent: true });
    hud.sendCountry(); // worker is up - tell it the nation we support
  }
  ring.setState({
    ...msg,
    me: asFootballPeer(msg.me),
    peers: msg.peers.map(asFootballPeer)
  });
  setState({ peers: msg.peers.length });
  updateHud();
});

ipc.on('feed', (msg) => {
  gallery.handle(msg.items.map(asSelfie));
  updateHud(); // dock the kick-off button below a non-empty gallery (when idle)
});

ipc.on('wallet', (msg) => {
  wallet.walletStatus(msg); // self-custodial TRX wallet address + balance (wallet-view modal)
  gallery.setMyAddress(msg.address); // so we don't offer to tip our own selfie
});
ipc.on('tip-result', (msg) => {
  gallery.tipResult(msg);
  if (msg.hash) {
    wallet.record({ kind: 'tip', hash: msg.hash, amount: msg.amount });
  }
});
ipc.on('send-result', (msg) => wallet.sendResult(msg));
ipc.on('transactions', (msg) => wallet.setTransactions(msg.list));
ipc.on('burn-result', (msg) => {
  // participation fee (kick-off or join), burned to the black hole (skin in the game). `stage`
  // keeps us from claiming "burned" before the tx is actually confirmed on-chain.
  const what = msg.reason === 'join' ? 'join' : 'kick-off';
  const tx = msg.hash ? [' (', txLink(msg.hash), ')'] : [];
  if (msg.stage === 'confirming') {
    hud.waveStatusNodes(`⏳ confirming ${what} burn on-chain…`, ...tx);
  } else if (msg.stage === 'failed') {
    hud.waveStatus(`⚠️ ${what} fee burn failed: ${msg.error}`);
  } else {
    hud.waveStatusNodes(`🔥 ${what} fee burned - ${msg.amount} TRX`, ...tx);
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
      // initiator: kicking off leaves the old gallery behind — close its view now, then
      // capture once the wave is live (immediately if paid, else wait for wave-verified)
      ring.stopSweep();
      gallery.cancelReplay();
      gallery.clearView();
      setDim(false);
      if (evt.paid === 'verified') {
        beginCapture();
      } else {
        hud.waveStatus('🔥 paying the kick-off fee…');
      }
    } else {
      // joiner-candidate: fade the previous gallery so the countdown reads clearly, but keep
      // it browsable underneath. Join → capture (clears it); "Not now" → un-dim + keep browsing.
      // The join button stays disabled until the kick-off payment verifies (anti-spam).
      setDim(true);
      lobby.open(evt);
      lobby.setJoinable(evt.paid === 'verified');
    }
  },

  paying: () => {
    hud.waveStatus('🔥 paying the kick-off fee…');
  },

  'wave-verified': (evt) => {
    if (evt.mine) {
      beginCapture(); // initiator's wave is now live + paid
    } else {
      lobby.setJoinable(true); // safe to join - kick-off is proven paid
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
      pending: '⏳ verifying the wave’s kick-off payment…',
      rejected: '⚠️ the wave’s kick-off payment was rejected'
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
    gallery.setExpected(evt.count || 1);
    gallery.setActive(true);
    setDim(false); // wave is racing — restore the ring (lobby may have timed out still dimmed)
    lobby.close();
    proof.captureAndStage(); // snap + stage the lobby selfie, then free the centre
    hud.waveStatus(
      evt.joined
        ? '📸 captured - here comes the wave!'
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
    hud.waveStatus('⚽ the wave is off!');
  },

  // the ball reached me - my staged selfie posts now (worker-side). The race is near-instant
  // (network speed); the visible ⚽ roll is the completion replay below, not this event.
  holding: (evt) => {
    hud.waveStatus(
      `📸 your selfie joins the wave! - hop ${evt.hopCount ?? ''}`
    );
  },

  // live protocol progress only — ball animation is the replay sweep, not per-hop events
  position: (evt) => {
    hud.waveStatus(`wave rolling - hop ${evt.hopCount ?? ''}`);
  },

  // a completed wave always has ≥1 selfie (the initiator's) — it may land a beat after this
  // event, so gallery.startReplay() defers until it arrives. Show the browse hint regardless.
  completed: (evt) => {
    hud.waveStatus(
      `✅ wave completed - ${evt.hops} hops · 🔎 drag the ⚽ around the ring to browse`
    );
    ring.startFlourish(); // golden ring pulse + confetti — the wave made it all the way around
    gallery.startReplay(); // roll the ⚽ once around the ring, featuring selfies in hop order
  }
};

ipc.on('event', (evt) => EVENT_HANDLERS[evt.event]?.(evt));
