// HyperWave renderer — orchestrator. Wires worker events (ipc) to the views:
// ring (canvas), gallery (centre selfie + progress), lobby, proof (webcam), hud.
import * as ipc from './lib/ipc.js'
import * as ring from './lib/ring.js'
import * as gallery from './lib/gallery.js'
import * as lobby from './lib/lobby.js'
import * as proof from './lib/proof.js'
import * as hud from './lib/hud.js'

ring.start()

let waveActive = false
let countrySent = false
let peerCount = 0
let lobbyDeadline = 0 // ~when the lobby closes (kickoff), for the capture countdown

// Swap the join panel for the camera and start framing the lobby selfie.
function beginCapture() {
  lobby.close()
  proof.open(Math.max(0, lobbyDeadline - performance.now()))
}

function idleStatus() {
  return peerCount === 0
    ? 'in the ring — waiting for peers…'
    : `${peerCount} peer${peerCount === 1 ? '' : 's'} in the ring — kick off a wave`
}

ipc.on('state', (msg) => {
  if (!countrySent) {
    countrySent = true
    hud.sendCountry() // worker is up — tell it the nation we support
  }
  ring.setState(msg)
  peerCount = msg.peers.length
  if (!waveActive) hud.status(idleStatus())
})

ipc.on('gallery', (msg) => {
  gallery.handle(msg.items)
  if (!waveActive) hud.dockStart(gallery.count() > 0) // keep the button off the gallery
})

ipc.on('wallet', (msg) => hud.wallet(msg)) // self-custodial USDT wallet address + balance

ipc.on('token', (e) => {
  switch (e.event) {
    case 'wave-announce':
      waveActive = true
      hud.showStart(false)
      gallery.hideProgress()
      lobbyDeadline = performance.now() + (e.lobbyMs || 15000)
      // I'm already in (e.g. the initiator) -> start framing; else show the join panel
      if (e.joined) beginCapture()
      else lobby.open(e)
      break
    case 'joined':
      beginCapture() // opted in — swap the join panel for the camera
      break
    case 'roster':
      lobby.update(e.count)
      break
    case 'wave-active':
      waveActive = true
      hud.showStart(false)
      gallery.setExpected(e.count || 1)
      gallery.setActive(true)
      lobby.close()
      proof.captureAndStage() // snap + stage the lobby selfie, then free the centre
      hud.status(e.joined ? '📸 captured — here comes the wave!' : '👀 spectating this wave')
      break
    case 'wave-idle':
      waveActive = false
      hud.showStart(true)
      hud.dockStart(gallery.count() > 0)
      gallery.setActive(false)
      lobby.close()
      proof.close()
      hud.status(idleStatus())
      break
    case 'busy':
      hud.status('⏳ a wave is already forming — wait for it to finish')
      break
    case 'started':
      hud.status('⚽ the wave is off!')
      break
    case 'holding':
      // the ball reached me — my staged selfie posts now (worker-side); just animate
      hud.status(
        e.canSelfie
          ? `📸 your selfie joins the wave! — hop ${e.hopCount ?? ''}`
          : `wave passing you — hop ${e.hopCount ?? ''}`
      )
      ring.setBall(e.angle)
      break
    case 'position':
      hud.status(`wave rolling — hop ${e.hopCount ?? ''}`)
      ring.setBall(e.angle)
      break
    case 'completed':
      hud.status(`✅ wave completed — ${e.hops} hops, chain ${e.chainHash.slice(0, 8)}…`)
      ring.setBall(e.angle)
      break
    case 'healed':
      hud.status('🩹 routing around a dropped peer…')
      break
    case 'gallery-error':
      hud.status(`⚠️ couldn't post your selfie (${e.reason})`)
      break
    case 'stalled':
      hud.status(`⚠️ wave stalled (${e.reason})`)
      break
  }
})

// OTA updater worker (kept from the template)
const bridge = window.bridge
const decoder = new TextDecoder('utf-8')
bridge.startWorker('/workers/main.js')
bridge.onWorkerIPC('/workers/main.js', (d) => {
  if (decoder.decode(d) === 'updating') hud.status('updating…')
})
