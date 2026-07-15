/* global BareKit */
// HyperWave mobile worklet entry: the react-native-bare-kit host for the shared engine
// (lib/engine.js) — the mobile counterpart of workers/hyperwave.js. It is NOT run in this repo
// (there's no RN host here); it's the bundle target `bare-pack` compiles for iOS/Android, e.g.
//   bare-pack -p ios --linked --out bundles/app-ios.bundle.js worklet/app.js
// The RN side boots it with `new Worklet().start('/app.js', bundle)`, then speaks the bare-rpc
// host<->UI seam (lib/rpc.js) over the pipe — the same seam the desktop uses. Its first message is
// an `init` command carrying { storageDir, config }; because the worklet learns its storageDir only
// then, the engine is built lazily via serveEngine's `onBootstrap` hook. Kept in-repo so the host
// seam is a single source of truth.
const os = require('bare-os');
const path = require('bare-path');
const FramedStream = require('framed-stream');
const { createEngine } = require('../lib/engine');
const { serveEngine } = require('../lib/rpc');

// On mobile the process cwd is the (read-only) app bundle, so a relative storageDir like
// 'hyperwave' resolves somewhere bare-fs can't write — Corestore then fails with "Corestore is
// closed" and Bare aborts. Resolve any non-absolute storageDir under the writable tmp dir. (The
// per-run store is ephemeral anyway — wiped on startup; a persistent Documents path is future
// work for the wallet seed.)
function resolveStorage(dir) {
  const resolved = dir || 'hyperwave';
  return path.isAbsolute(resolved)
    ? resolved
    : path.join(os.tmpdir(), resolved);
}

const pipe = new FramedStream(BareKit.IPC); // bare-kit's worklet-side IPC (cf. Bare.IPC on desktop)

// The bare-rpc seam owns the pipe: it routes RN -> engine commands and streams engine -> RN
// notifications. `onBootstrap` builds the engine the first time a command arrives (the `init`),
// since the storageDir isn't known before then.
let engine = null;
const seam = serveEngine({
  stream: pipe,
  onBootstrap: (command) => {
    if (command.type === 'init' && !engine) {
      engine = createEngine({
        storageDir: resolveStorage(command.storageDir),
        config: command.config || {},
        emit: seam.emit // engine -> RN: raised over the seam's EVENT channel
      });
      seam.attach(engine);
    }
  }
});

// Resilience: a mobile app must not die on a stray async rejection deep in the engine. Bare
// aborts the process on an unhandled rejection by default — catch them and report as an event.
if (typeof Bare !== 'undefined' && Bare.on) {
  Bare.on('unhandledRejection', (err) => {
    try {
      seam.emit({
        type: 'engine-error',
        error: String((err && err.message) || err)
      });
    } catch {}
  });
}
