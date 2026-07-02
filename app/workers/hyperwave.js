// HyperWave Bare worker: bridges the P2P engine (lib/wave.js) to the renderer.
// Started by the renderer via bridge.startWorker('/workers/hyperwave.js').
// Storage dir arrives as Bare.argv[2] (see electron/main.js getWorker), so each
// --storage instance gets its own identity + Corestore.

const FramedStream = require('framed-stream')
const goodbye = require('graceful-goodbye')
const { createWave } = require('./lib/wave')

const pipe = new FramedStream(Bare.IPC)
const storageDir = Bare.argv[2]

function send (msg) {
  pipe.write(JSON.stringify(msg))
}

const wave = createWave({
  storageDir,
  onState: (state) => send({ type: 'state', ...state }),
  onToken: (event) => send({ type: 'token', ...event }),
  onGallery: (items) => send({ type: 'gallery', items }),
  log: (...a) => console.log('[hyperwave]', ...a)
})

console.log('[hyperwave] worker up, me=', wave.me.id.slice(0, 8), 'angle=', wave.me.angle.toFixed(1))

// Renderer -> worker commands.
pipe.on('data', (data) => {
  let msg
  try {
    msg = JSON.parse(data.toString())
  } catch {
    return
  }
  if (msg.type === 'start-wave') wave.startWave()
  else if (msg.type === 'post-selfie') wave.postSelfie(msg.selfie)
})

goodbye(async () => {
  await wave.close()
})
