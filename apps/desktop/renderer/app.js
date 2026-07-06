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

ipc.on('wallet', (msg) => {
  hud.wallet(msg) // self-custodial TRX wallet address + balance
  gallery.setMyAddress(msg.address) // so we don't offer to tip our own selfie
})
ipc.on('tip-result', (msg) => gallery.tipResult(msg))
ipc.on('burn-result', (msg) => {
  // participation fee (kick-off or join), burned to the black hole (skin in the game)
  const what = msg.reason === 'join' ? 'join' : 'kick-off'
  hud.status(
    msg.hash
      ? `🔥 ${what} fee burned — ${msg.amount} TRX (tx ${msg.hash.slice(0, 8)}…)`
      : `⚠️ ${what} fee burn failed: ${msg.error}`
  )
})

ipc.on('token', (e) => {
  switch (e.event) {
    case 'wave-announce':
      waveActive = true
      hud.showStart(false)
      gallery.hideProgress()
      lobbyDeadline = performance.now() + (e.lobbyMs || 15000)
      if (e.mine) {
        // initiator: capture once the wave is live (immediately if already paid, else
        // wait for wave-verified after the kick-off burn confirms)
        if (e.paid === 'verified') beginCapture()
        else hud.status('🔥 paying the kick-off fee…')
      } else {
        // joiner: show the join panel; the join button stays disabled until the wave's
        // kick-off payment is verified (anti-spam — never pay into an unpaid wave)
        lobby.open(e)
        lobby.setJoinable(e.paid === 'verified')
      }
      break
    case 'paying':
      hud.status('🔥 paying the kick-off fee…')
      break
    case 'wave-verified':
      if (e.mine) {
        beginCapture()
      } // initiator's wave is now live + paid
      else {
        lobby.setJoinable(true)
      } // safe to join — kick-off is proven paid
      break
    case 'wave-unpaid':
      hud.status('⚠️ ignored an unpaid wave')
      lobby.close()
      break
    case 'join-blocked':
      hud.status('⏳ verifying the wave’s kick-off payment…')
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
    case 'raffle-win':
      // the wave's initiator drew a winner among the gallery participants (commit-reveal draw)
      hud.status(
        `🎉 raffle winner: ${e.winner.slice(0, 8)}… — ${e.amount} TRX (of ${e.tickets} tickets, tx ${e.hash.slice(0, 8)}…)`
      )
      break
  }
})
