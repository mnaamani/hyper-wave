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
//
// Host parity with workers/hyperwave.js (the desktop half): same wallet (Cashu), same
// network -> directory-topic policy, same browse-then-pick subscription budget. The RN side owns
// custody + durability (it passes a persistent storageDir and keychain-held seeds in `init`),
// exactly as Electron main does on desktop.
const os = require('bare-os');
const path = require('bare-path');
const FramedStream = require('framed-stream');
const { createEngine } = require('../lib/engine');
const { DEFAULT_TOPIC } = require('../lib/wave');
const { serveEngine } = require('../lib/rpc');
// The engine ships no wallet — this host picks one. Mobile uses Cashu (ecash on a Lightning mint),
// the same default as the desktop; a separate package, so it's a host (bundle) dependency, not an
// engine one.
const { createCashuWallet } = require('hyperwave-wallet-cashu');

// Mints this APP adds beyond the package's built-in list — `{ url, label, network }`. Mirrors
// workers/hyperwave.js's APP_EXTRA_MINTS: feeds both the cross-network paid-gate filter (via
// walletOptions.knownMints) and the UI's mint picker. Empty by default.
const APP_EXTRA_MINTS = [];

// On mobile the process cwd is the (read-only) app bundle, so a relative storageDir like
// 'hyperwave' resolves somewhere bare-fs can't write — Corestore then fails with "Corestore is
// closed" and Bare aborts. The RN side passes an ABSOLUTE, persistent app directory (expo-file-
// system's document dir) — bearer Cashu proofs (`cashu-proofs.json`) live there and must survive
// an app restart, so tmpdir is only a last-resort fallback for a host that sends no path.
function resolveStorage(dir) {
  const resolved = dir || 'hyperwave';
  return path.isAbsolute(resolved)
    ? resolved
    : path.join(os.tmpdir(), resolved);
}

// App policy (identical to workers/hyperwave.js): which DIRECTORY TOPIC this peer sits on, per its
// wallet's settlement network. The engine is network-agnostic — it exposes a generic `set-topic`
// command and never decides this. Mainnet (real sats) and testnet (test ecash) peers live in
// SEPARATE directories so they never even discover each other; testnet / unknown / wallet-less stay
// on the base topic. NOTE: this duplicates the desktop host's copy until it moves into the shared
// app-core package (implement-mobile-app.md D1/Phase 2) — keep the two in sync meanwhile.
function topicForNetwork(baseTopic, network) {
  if (network === 'mainnet') {
    return baseTopic + ':mainnet';
  }
  return baseTopic;
}

const pipe = new FramedStream(BareKit.IPC); // bare-kit's worklet-side IPC (cf. Bare.IPC on desktop)

// The bare-rpc seam owns the pipe: it routes RN -> engine commands and streams engine -> RN
// notifications. `onBootstrap` builds the engine the first time a command arrives (the `init`),
// since the storageDir isn't known before then.
let engine = null;
let baseTopic = DEFAULT_TOPIC;
let lastNetwork = null;

// Wallet-network -> directory-topic policy, host-side (the desktop host does the same). We tap the
// engine's outbound `wallet` events (which carry the wallet's settlement `network`) and, on a
// change, issue a generic `set-topic` so this peer moves to that network's directory. Wrapping the
// seam's emit keeps the engine network-agnostic — every message still flows to the seam untouched.
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
      topicId: topicForNetwork(baseTopic, msg.network)
    });
  }
  seam.emit(msg); // engine -> RN: raised over the seam's EVENT channel
}

const seam = serveEngine({
  stream: pipe,
  onBootstrap: (command) => {
    if (command.type !== 'init' || engine) {
      return;
    }
    const injected = command.config || {};
    baseTopic = injected.topicId || DEFAULT_TOPIC;
    engine = createEngine({
      storageDir: resolveStorage(command.storageDir),
      config: {
        ...injected,
        // Start on the base topic; a mainnet wallet moves us to its topic on the first `wallet`
        // event (the emit tap above -> set-topic). The host owns the base, so pass it explicitly.
        topicId: baseTopic,
        // Cashu is the mobile default too. The active mint rides in walletOptions (the RN side
        // persists the peer's chosen mint); `knownMints` gives the cross-network filter this app's
        // extra mints beyond the package's built-in list.
        walletOptions: {
          ...(injected.walletOptions || {}),
          knownMints: APP_EXTRA_MINTS
        },
        // Browse-then-pick (scaling.md Phase 2): stay merely AWARE of every announced wave and
        // hold cores only for waves the user opens/joins -> O(subscribed). The RN UI drives
        // subscribe-wave / unsubscribe-wave from the wave directory.
        autoSubscribe: false
      },
      deps: { createPayments: createCashuWallet }, // the engine ships no wallet
      emit // host-wrapped seam.emit (taps `wallet` events for the network -> topic switch)
    });
    seam.attach(engine);
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
