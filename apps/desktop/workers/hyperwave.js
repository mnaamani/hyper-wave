// HyperWave desktop worker: the Electron host for the shared engine (the hyperwave-lib-core
// package's createCore). Started by the renderer via bridge.startWorker('/workers/hyperwave.js');
// the storage dir arrives as Bare.argv[2] (see electron/main.js getWorker) and optional config
// via bare-env. A mobile react-native-bare-kit worklet (hyperwave-lib-core/worklet/app.js) hosts
// the SAME core over its own IPC + an init message instead — this file is the desktop half.
const FramedStream = require('framed-stream')
const goodbye = require('graceful-goodbye')
const env = require('bare-env')
const { createCore } = require('hyperwave-lib-core')

const pipe = new FramedStream(Bare.IPC)
const send = (msg) => pipe.write(JSON.stringify(msg))

const core = createCore({
  storageDir: Bare.argv[2],
  config: {
    bootstrap: env.HYPERWAVE_BOOTSTRAP, // host:port -> local DHT (instant same-machine discovery)
    matchId: env.HYPERWAVE_MATCH || undefined, // isolate the ring
    lobbyMs: env.HYPERWAVE_LOBBY_MS ? Number(env.HYPERWAVE_LOBBY_MS) : undefined,
    role: env.HYPERWAVE_ROLE || 'peer', // 'validator'/'seed' = gallery archivist
    raffleTrx: env.HYPERWAVE_RAFFLE_TRX ? Number(env.HYPERWAVE_RAFFLE_TRX) : 0 // seed-only prize
  },
  send
})

// Renderer -> worker commands.
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
