// HyperWave desktop worker: the Electron host for the shared engine (the hyperwave
// package's createEngine). Started by the renderer via bridge.startWorker('/workers/hyperwave.js').
// A mobile react-native-bare-kit worklet (hyperwave/worklet/app.js) hosts the SAME engine over its
// own IPC — this file is the desktop half, and both now share the init-message-driven shape.
//
// Init-driven (was eager from Bare.argv): Electron main owns the OS-keychain secret store
// (safeStorage) and delivers the decrypted wallet + swarm seeds over the IPC pipe in an `init`
// command — NEVER via argv/env, which `ps`/other processes can read (secure-seed-storage.md). So we
// wait for that command (serveEngine's `onBootstrap`) before building the engine, exactly like the
// mobile worklet. When main can't encrypt (no keyring backend), it sends `init` with no seeds and
// the engine falls back to its own plaintext seed files — the previous behaviour, no regression.
const FramedStream = require('framed-stream');
const goodbye = require('graceful-goodbye');
const env = require('bare-env');
const { createEngine, createCashuWallet } = require('hyperwave-engine');
const { serveEngine } = require('hyperwave-engine/lib/rpc');

const pipe = new FramedStream(Bare.IPC);

let engine = null;
const seam = serveEngine({
  stream: pipe,
  // Build the engine when main's `init` arrives with the storage dir + injected seeds. bootstrap /
  // topic stay dev/demo knobs read from bare-env (non-secret); only the seeds ride the pipe.
  onBootstrap: (command) => {
    if (command.type !== 'init' || engine) {
      return;
    }
    const injected = command.config || {};
    engine = createEngine({
      storageDir: command.storageDir || Bare.argv[2],
      config: {
        bootstrap: env.HYPERWAVE_BOOTSTRAP,
        topicId: env.HYPERWAVE_TOPIC || undefined,
        // Injected by main from the keychain-encrypted store; undefined → the engine persists its
        // own plaintext seed files (headless/dev fallback), same as before secure storage.
        seed: injected.seed,
        swarmSeed: injected.swarmSeed,
        // Cashu (ecash) is the desktop's default payment mechanism. The active mint rides here
        // (persisted by main as the peer's chosen mint; undefined → the wallet's default test
        // mint). A `set-wallet-options {mint}` command switches it live at runtime.
        walletOptions: {
          mint: injected.mint || env.HYPERWAVE_MINT || undefined
        }
      },
      // Inject Cashu as the payment factory (createEngine's default is the Tron wallet). The
      // engine wires it through the same `Wallet` interface — burns, tips, and the paid gate are
      // mechanism-agnostic.
      deps: { createPayments: createCashuWallet },
      emit: seam.emit // engine -> host: raised over the seam's EVENT channel
    });
    seam.attach(engine);
  }
});

goodbye(async () => {
  seam.close();
  if (engine) {
    await engine.close();
  }
});
