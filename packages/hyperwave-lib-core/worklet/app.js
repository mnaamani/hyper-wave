/* global BareKit */
// HyperWave mobile worklet entry: the react-native-bare-kit host for the shared engine
// (lib/core.js) — the mobile counterpart of workers/hyperwave.js. It is NOT run in this repo
// (there's no RN host here); it's the bundle target `bare-pack` compiles for iOS/Android, e.g.
//   bare-pack -p ios --linked --out bundles/app-ios.bundle.js worklet/app.js
// The RN side boots it with `new Worklet().start('/app.js', bundle)`, then sends one
// { type:'init', storageDir, config } message; everything after is the same message protocol the
// desktop renderer speaks. Kept in-repo so the host seam is a single source of truth.
const os = require('bare-os');
const path = require('bare-path');
const FramedStream = require('framed-stream');
const hyperwave = require('../lib/core');

// On mobile the process cwd is the (read-only) app bundle, so a relative storageDir like
// 'hyperwave' resolves somewhere bare-fs can't write — Corestore then fails with "Corestore is
// closed" and Bare aborts. Resolve any non-absolute storageDir under the writable tmp dir. (The
// per-run store is ephemeral anyway — wiped on startup; a persistent Documents path is future
// work for the wallet seed.)
function resolveStorage(dir) {
  const d = dir || 'hyperwave';
  return path.isAbsolute(d) ? d : path.join(os.tmpdir(), d);
}

const pipe = new FramedStream(BareKit.IPC); // bare-kit's worklet-side IPC (cf. Bare.IPC on desktop)
// Sends a message Worker -> Host (React Native app)
const send = (msg) => pipe.write(JSON.stringify(msg));

// Resilience: a mobile app must not die on a stray async rejection deep in the engine. Bare
// aborts the process on an unhandled rejection by default — catch them and report instead.
if (typeof Bare !== 'undefined' && Bare.on) {
  Bare.on('unhandledRejection', (err) => {
    try {
      send({ type: 'engine-error', error: String((err && err.message) || err) });
    } catch {}
  });
}

// RN host -> Worker commands.
let core = null;
pipe.on('data', (data) => {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }
  // First message from the RN host should be the init: storageDir + config (matchId, seed, ...)
  if (msg.type === 'init' && !core) {
    core = hyperwave.init({
      storageDir: resolveStorage(msg.storageDir),
      config: msg.config || {},
      send
    });
  } else if (core) {
    core.onMessage(msg);
  } else {
    // RN host did not yet send an init message, so whatever this message is, its too early to be sending.
    console.warn(`Dropped message of type ${msg.type}. Init message not yet received`);
  }
});
