/* global BareKit */
// HyperWave mobile worklet entry: the react-native-bare-kit host for the shared engine
// (lib/core.js) — the mobile counterpart of workers/hyperwave.js. It is NOT run in this repo
// (there's no RN host here); it's the bundle target `bare-pack` compiles for iOS/Android, e.g.
//   bare-pack -p ios --linked --out bundles/app-ios.bundle.js workers/worklet/app.js
// The RN side boots it with `new Worklet().start('/app.js', bundle)`, then sends one
// { type:'init', storageDir, config } message (RN computes the app-sandbox path and loads the
// seed from Keychain/Keystore); everything after that is the same message protocol the desktop
// renderer speaks. Kept in-repo so the host seam is a single source of truth.
const FramedStream = require('framed-stream')
const { createCore } = require('../lib/core')

const pipe = new FramedStream(BareKit.IPC) // bare-kit's worklet-side IPC (cf. Bare.IPC on desktop)
const send = (msg) => pipe.write(JSON.stringify(msg))

let core = null
pipe.on('data', (data) => {
  let msg
  try {
    msg = JSON.parse(data.toString())
  } catch {
    return
  }
  // First message from the RN host is the init: storageDir + config (matchId, role, seed, …).
  if (msg.type === 'init' && !core) {
    core = createCore({ storageDir: msg.storageDir, config: msg.config || {}, send })
  } else if (core) {
    core.onMessage(msg)
  }
})
