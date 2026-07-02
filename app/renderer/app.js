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

ipc.on('token', (e) => {
  switch (e.event) {
    case 'wave-announce':
      waveActive = true
      hud.showStart(false)
      gallery.hideProgress()
      lobby.open(e)
      break
    case 'joined':
      lobby.markJoined()
      lobby.update(e.count)
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
      hud.status(e.joined ? '📣 you are in — get ready!' : '👀 spectating this wave')
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
      hud.status(
        e.canSelfie
          ? `📸 your turn! — hop ${e.hopCount ?? ''}`
          : `wave passing you — hop ${e.hopCount ?? ''}`
      )
      ring.setBall(e.angle)
      if (e.canSelfie) proof.open(e)
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
