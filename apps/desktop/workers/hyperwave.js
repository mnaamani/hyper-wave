// HyperWave desktop worker: the Electron host for the shared engine (the hyperwave-lib-core
// package's init). Started by the renderer via bridge.startWorker('/workers/hyperwave.js');
// the storage dir arrives as Bare.argv[2] (see electron/main.js getWorker) and optional config
// via bare-env. A mobile react-native-bare-kit worklet (hyperwave-lib-core/worklet/app.js) hosts
// the SAME core over its own IPC + an init message instead — this file is the desktop half.
const FramedStream = require('framed-stream')
const goodbye = require('graceful-goodbye')
const env = require('bare-env')
const hyperwave = require('hyperwave-lib-core')

const pipe = new FramedStream(Bare.IPC)

// Send a message Worker -> Host (Electron Renderer)
const send = (msg) => pipe.write(JSON.stringify(msg))

const core = hyperwave.init({
  storageDir: Bare.argv[2],
  config: {
    bootstrap: env.HYPERWAVE_BOOTSTRAP, // optional host:port -> local DHT (instant same-machine discovery)
    matchId: env.HYPERWAVE_MATCH || undefined // isolate the ring
    // lobby length is the engine's fixed 15s constant; the wallet is always on (fees/tips/paid-gate)
  },
  send
})

// Renderer -> Worker commands.
pipe.on('data', (data) => {
  let msg
  try {
    msg = JSON.parse(data.toString())
  } catch {
    return
  }
  core.onMessage(msg)
})

goodbye(() => core.close())
