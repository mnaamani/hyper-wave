// HyperWave desktop worker: the Electron host for the shared engine (the hyperwave
// package's createEngine). Started by the renderer via bridge.startWorker('/workers/hyperwave.js');
// the storage dir arrives as Bare.argv[2] (see electron/main.js getWorker) and optional config
// via bare-env. A mobile react-native-bare-kit worklet (hyperwave/worklet/app.js) hosts
// the SAME engine over its own IPC + an init message instead — this file is the desktop half.
const FramedStream = require('framed-stream');
const goodbye = require('graceful-goodbye');
const env = require('bare-env');
const { createEngine } = require('hyperwave-engine');

const pipe = new FramedStream(Bare.IPC);

// Worker -> Host message
const send = (msg) => pipe.write(JSON.stringify(msg));

const engine = createEngine({
  storageDir: Bare.argv[2],
  config: {
    bootstrap: env.HYPERWAVE_BOOTSTRAP,
    topicId: env.HYPERWAVE_TOPIC || undefined
  },
  notify: (msg) => {
    // engine -> host: the engine raises messages, we frame them onto the IPC pipe
    send(msg);
  }
});

// Host -> Worker commands
pipe.on('data', (data) => {
  let command;
  try {
    command = JSON.parse(data.toString());
  } catch (err) {
    console.log('Unable to parse command from renderer', err.toString());
    return;
  }
  engine.exec(command);
});

goodbye(() => engine.close());
