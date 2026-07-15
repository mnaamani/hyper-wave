// HyperWave desktop worker: the Electron host for the shared engine (the hyperwave
// package's createEngine). Started by the renderer via bridge.startWorker('/workers/hyperwave.js');
// the storage dir arrives as Bare.argv[2] (see electron/main.js getWorker) and optional config
// via bare-env. A mobile react-native-bare-kit worklet (hyperwave/worklet/app.js) hosts
// the SAME engine over its own IPC + an init message instead — this file is the desktop half.
const FramedStream = require('framed-stream');
const goodbye = require('graceful-goodbye');
const env = require('bare-env');
const { createEngine } = require('hyperwave-engine');
const { serveEngine } = require('hyperwave-engine/lib/rpc');

const pipe = new FramedStream(Bare.IPC);

// The bare-rpc host<->UI seam owns the pipe (Electron main runs the matching client). This is an
// EAGER host: the storage dir arrives synchronously as argv[2], so we build the engine right away
// and attach — no onBootstrap needed (that's the mobile worklet's lazy-init path).
const seam = serveEngine({ stream: pipe });
const engine = createEngine({
  storageDir: Bare.argv[2],
  config: {
    bootstrap: env.HYPERWAVE_BOOTSTRAP,
    topicId: env.HYPERWAVE_TOPIC || undefined
  },
  emit: seam.emit // engine -> host: raised over the seam's EVENT channel
});
seam.attach(engine);

goodbye(async () => {
  seam.close();
  await engine.close();
});
