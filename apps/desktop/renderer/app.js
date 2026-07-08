// HyperWave renderer - orchestrator. Wires worker events (ipc) to the views:
// ring (canvas), gallery (centre selfie + progress), lobby, proof (webcam), hud.
import * as ipc from './lib/ipc.js'
import * as ring from './lib/ring.js'
import * as gallery from './lib/gallery.js'
import * as scrubber from './lib/scrubber.js'
import * as lobby from './lib/lobby.js'
import * as proof from './lib/proof.js'
import * as hud from './lib/hud.js'

// Start frame animation loop for the ring (2d canvas) + the circular scrubber (drag the ⚽
// around the ring to browse the gallery once the completion replay has run).
ring.start()
scrubber.init()

// The orchestrator's UI state - a single source of truth. Mutate only via setState() so updates
// are explicit and in one place; the views below are still driven imperatively off the ipc events.
const state = {
  countrySent: false, // one-shot: pushed our saved team to the worker once it came up
  peers: 0, // number of live peers in the ring (drives the status line)
  lobbyDeadline: 0 // ~when the lobby closes (kickoff), for the capture countdown
}
const setState = (patch) => Object.assign(state, patch)

// Dev-only console handle (`hw` = HyperWave): reach the orchestrator state + view modules from the
// DevTools console, e.g. `hw.state`, `hw.gallery.count()`, `hw.hud.waveStatus('test')`. ES modules
// don't expose their bindings globally, so nothing is reachable unless we put it here — which is
// exactly why we DON'T in a packaged build (keeps a shipped app's global scope clean). `npm start`
// is unpackaged, so the handle is present in dev only.
if (window.bridge?.isPackaged && !window.bridge.isPackaged()) {
  window.hw = { state, ring, gallery, scrubber, lobby, proof, hud, ipc }
}

// Fade the ring + gallery (a new wave's lobby is up) so the countdown reads clearly; the lobby
// countdown is an HTML overlay above the canvas, so it stays crisp.
const fieldEl = document.querySelector('.field')
function setDim(on) {
  fieldEl.classList.toggle('dim', on)
}
// "Not now" in the lobby: un-dim and let the peer keep browsing the gallery they were viewing.
lobby.onCancel(() => setDim(false))

// Swap the join panel for the camera and start framing the lobby selfie. Leaving the old wave's
// gallery to take part in a new one: close its view and clear the frozen replay/scrubber.
function beginCapture() {
  setDim(false)
  ring.stopSweep()
  gallery.cancelReplay()
  gallery.clearView()
  lobby.close()
  proof.open(Math.max(0, state.lobbyDeadline - performance.now()))
}

// Update the HUD's persistent chrome from state: the network status line (peer count) + the
// docked kick-off button. The live wave narration is a separate element (hud.waveStatus /
// #wave-status), so this runs freely — even mid-wave — without clobbering it.
function updateHud() {
  hud.networkStatus(
    state.peers === 0
      ? 'in the ring - waiting for peers...'
      : `${state.peers} peer${state.peers === 1 ? '' : 's'} in the ring.`
  )
  // keep the kickoff button off the gallery
  hud.dockStart(gallery.count() > 0)
}

ipc.on('state', (msg) => {
  if (!state.countrySent) {
    setState({ countrySent: true })
    hud.sendCountry() // worker is up - tell it the nation we support
  }
  ring.setState(msg)
  setState({ peers: msg.peers.length })
  updateHud()
})

ipc.on('gallery', (msg) => {
  gallery.handle(msg.items)
  updateHud() // dock the kick-off button below a non-empty gallery (when idle)
})

ipc.on('wallet', (msg) => {
  hud.walletStatus(msg) // self-custodial TRX wallet address + balance
  gallery.setMyAddress(msg.address) // so we don't offer to tip our own selfie
})
ipc.on('tip-result', (msg) => gallery.tipResult(msg))
ipc.on('burn-result', (msg) => {
  // participation fee (kick-off or join), burned to the black hole (skin in the game). `stage`
  // keeps us from claiming "burned" before the tx is actually confirmed on-chain.
  const what = msg.reason === 'join' ? 'join' : 'kick-off'
  const tx = msg.hash ? ` (tx ${msg.hash.slice(0, 8)}…)` : ''
  if (msg.stage === 'confirming') hud.waveStatus(`⏳ confirming ${what} burn on-chain…${tx}`)
  else if (msg.stage === 'failed') hud.waveStatus(`⚠️ ${what} fee burn failed: ${msg.error}`)
  else hud.waveStatus(`🔥 ${what} fee burned - ${msg.amount} TRX${tx}`)
})

ipc.on('event', (e) => {
  switch (e.event) {
    case 'wave-announce':
      setState({ lobbyDeadline: performance.now() + (e.lobbyMs || 15000) })
      hud.showStart(false)
      hud.waveStatus('') // clear the previous wave's narration; this wave's fills in below
      gallery.hideProgress()
      if (e.mine) {
        // initiator: kicking off leaves the old gallery behind — close its view now, then
        // capture once the wave is live (immediately if paid, else wait for wave-verified)
        ring.stopSweep()
        gallery.cancelReplay()
        gallery.clearView()
        setDim(false)
        if (e.paid === 'verified') beginCapture()
        else hud.waveStatus('🔥 paying the kick-off fee…')
      } else {
        // joiner-candidate: fade the previous gallery so the countdown reads clearly, but keep
        // it browsable underneath. Join → capture (clears it); "Not now" → un-dim + keep browsing.
        // The join button stays disabled until the kick-off payment verifies (anti-spam).
        setDim(true)
        lobby.open(e)
        lobby.setJoinable(e.paid === 'verified')
      }
      break
    case 'paying':
      hud.waveStatus('🔥 paying the kick-off fee…')
      break
    case 'wave-verified':
      if (e.mine) {
        beginCapture()
      } // initiator's wave is now live + paid
      else {
        lobby.setJoinable(true)
      } // safe to join - kick-off is proven paid
      break
    case 'wave-unpaid':
      hud.waveStatus('⚠️ ignored an unpaid wave')
      setDim(false)
      lobby.close()
      break
    case 'join-blocked':
      hud.waveStatus('⏳ verifying the wave’s kick-off payment…')
      break
    case 'joined':
      beginCapture() // opted in - swap the join panel for the camera
      break
    case 'roster':
      lobby.update(e.count)
      break
    case 'wave-active':
      hud.showStart(false)
      gallery.setExpected(e.count || 1)
      gallery.setActive(true)
      setDim(false) // wave is racing — restore the ring (lobby may have timed out still dimmed)
      lobby.close()
      proof.captureAndStage() // snap + stage the lobby selfie, then free the centre
      hud.waveStatus(e.joined ? '📸 captured - here comes the wave!' : '👀 spectating this wave')
      break
    case 'wave-idle':
      hud.showStart(true)
      gallery.setActive(false)
      setDim(false) // safety: never leave the ring faded if the lobby exited without a race
      // NB: do NOT stop the replay here — `completed` fires immediately before `wave-idle`, and
      // the frozen replay + scrubber are meant to persist through idle so the gallery stays
      // browsable. The replay is cleared when the NEXT wave forms (wave-announce).
      lobby.close()
      proof.close()
      // refresh the status line + dock button now the wave is over. We deliberately DON'T clear
      // the wave-status here — it keeps the last result (completed / raffle winner) on screen
      // until the next wave's wave-announce clears it.
      updateHud()
      break
    case 'busy':
      hud.waveStatus('⏳ a wave is already forming - wait for it to finish')
      break
    case 'started':
      hud.waveStatus('⚽ the wave is off!')
      break
    case 'holding':
      // the ball reached me - my staged selfie posts now (worker-side). The race is near-instant
      // (HOP_DELAY_MS = 0); the visible ⚽ roll is the completion replay below, not this event.
      hud.waveStatus(
        e.canSelfie
          ? `📸 your selfie joins the wave! - hop ${e.hopCount ?? ''}`
          : `wave passing you - hop ${e.hopCount ?? ''}`
      )
      break
    case 'position':
      // live protocol progress only — ball animation is the replay sweep, not per-hop events
      hud.waveStatus(`wave rolling - hop ${e.hopCount ?? ''}`)
      break
    case 'completed':
      // a completed wave always has ≥1 selfie (the initiator's) — it may land a beat after this
      // event, so gallery.startReplay() defers until it arrives. Show the browse hint regardless.
      hud.waveStatus(
        `✅ wave completed - ${e.hops} hops · 🔎 drag the ⚽ around the ring to browse`
      )
      gallery.startReplay() // roll the ⚽ once around the ring, featuring selfies in hop order
      break
    case 'healed':
      hud.waveStatus('🩹 routing around a dropped peer…')
      break
    case 'gallery-error': {
      const msg =
        e.reason === 'fee-unpaid'
          ? "⚠️ your selfie wasn't added — the participation fee wasn't paid/confirmed in time"
          : e.reason === 'admit-timeout'
            ? "⚠️ your selfie wasn't added — gallery admission timed out (network); try again"
            : e.reason === 'no-gallery-yet'
              ? "⚠️ your selfie wasn't added — the gallery wasn't ready yet"
              : `⚠️ couldn't post your selfie (${e.reason})`
      hud.waveStatus(msg)
      break
    }
    case 'stalled':
      hud.waveStatus(`⚠️ wave stalled (${e.reason})`)
      gallery.startReplay() // still replay whatever selfies were collected before the stall
      break
    case 'raffle-win':
      // the wave's initiator drew a winner among the gallery participants (commit-reveal draw)
      hud.waveStatus(
        `🎉 raffle winner: ${e.winner.slice(0, 8)}… - ${e.amount} TRX (of ${e.tickets} tickets, tx ${e.hash.slice(0, 8)}…)`
      )
      break
  }
})
