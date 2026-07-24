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
const { createEngine, DEFAULT_TOPIC } = require('hyperwave-engine');
const { serveEngine } = require('hyperwave-engine/lib/rpc');
// The engine ships no wallet — the desktop host picks Cashu (a separate package).
const { createCashuWallet } = require('hyperwave-wallet-cashu');

// App policy: which DIRECTORY TOPIC this peer sits on, per its wallet's settlement network. The
// engine is network-agnostic — it exposes a generic `set-topic` command and never decides this; the
// mapping is the consumer's. We keep mainnet (real sats) and testnet (test ecash) peers in SEPARATE
// directories — a first, coarse separation layer in front of the per-burn cross-network filter — so
// they never even discover each other. Testnet / unknown / wallet-less stay on the base topic (the
// current demo topic, unchanged); mainnet moves to a distinct `<base>:mainnet` topic.
const BASE_TOPIC = env.HYPERWAVE_TOPIC || DEFAULT_TOPIC;
function topicForNetwork(network) {
  if (network === 'mainnet') {
    return BASE_TOPIC + ':mainnet';
  }
  return BASE_TOPIC;
}

// Mints this APP adds beyond the package's built-in list — `{ url, label, network }`. This ONE list
// feeds both (a) the cross-network paid-gate filter (via walletOptions.knownMints → the wallet
// classifies burns against these, so an app-added mainnet mint is filtered from testnet peers and
// vice versa) and (b) the renderer's mint picker (the wallet reports its full known list, which the
// engine relays on the `wallet` message → no duplicated list in the renderer). Empty by default —
// the package already knows the demo's mints.
const APP_EXTRA_MINTS = [];

const pipe = new FramedStream(Bare.IPC);

let engine = null;
// Wallet-network → directory-topic policy, host-side. We tap the engine's outbound `wallet` events
// (which carry the wallet's settlement `network`) and, on a network change, issue a generic
// `set-topic` so this peer moves to that network's directory (topicForNetwork above). Wrapping the
// seam's emit keeps the engine network-agnostic — every message still flows to the seam untouched.
let lastNetwork = null;
function emit(msg) {
  if (
    msg &&
    msg.type === 'wallet' &&
    msg.network &&
    msg.network !== lastNetwork
  ) {
    lastNetwork = msg.network;
    engine?.exec({
      type: 'set-topic',
      topicId: topicForNetwork(msg.network)
    });
  }
  seam.emit(msg); // engine -> host: raised over the seam's EVENT channel
}
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
        // Start on the base topic; a mainnet wallet moves us to its topic on the first `wallet`
        // event (the emit tap above → set-topic). The host owns the base, so pass it explicitly.
        topicId: BASE_TOPIC,
        // Injected by main from the keychain-encrypted store; undefined → the engine persists its
        // own plaintext seed files (headless/dev fallback), same as before secure storage.
        seed: injected.seed,
        swarmSeed: injected.swarmSeed,
        // Cashu (ecash) is the desktop's default payment mechanism. The active mint rides here
        // (persisted by main as the peer's chosen mint; undefined → the wallet's default test
        // mint). A `set-wallet-options {mint}` command switches it live at runtime. `knownMints`
        // gives the cross-network filter this app's extra mints (beyond the package's built-in list).
        walletOptions: {
          mint: injected.mint || env.HYPERWAVE_MINT || undefined,
          knownMints: APP_EXTRA_MINTS
        },
        // Browse-then-pick (scaling.md Phase 2): stay merely AWARE of every announced wave
        // (the directory) and hold cores only for waves the user opens/joins → O(subscribed).
        // The renderer drives subscribe-wave / unsubscribe-wave from the wave directory UI.
        autoSubscribe: false
      },
      // Inject Cashu as the payment factory (createEngine's default is the Tron wallet). The
      // engine wires it through the same `Wallet` interface — burns, tips, and the paid gate are
      // mechanism-agnostic.
      deps: { createPayments: createCashuWallet },
      emit // host-wrapped seam.emit (taps `wallet` events for the network → topic switch)
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
