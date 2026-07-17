#!/usr/bin/env bare
// One wave instance per process (the real topology: each worker is its own process).
// Runs under Bare:  bare bin/wave.run.js <name> <storageDir>  (or, if installed: hyper-wave)
// Needs `bare` on PATH — it's a separate runtime, not an npm dependency.
//   env HYPERWAVE_BOOTSTRAP=host:port  -> local DHT (fast same-machine discovery)
//   env HYPERWAVE_TOPIC=<id>           -> isolated topic
//   env START=<n>                      -> announce a wave once >= n peers are present
//   env AUTOJOIN=1                     -> auto opt-in when a wave is announced
//   env AUTOENTRY=1                   -> stage a fake entry in the lobby (posted at my sweep slot, if joined)
//   env SPECTATE=1                    -> subscribe to an announced wave WITHOUT joining (non-member)
//   env NOTE=1                        -> broadcast a wave-note on `completed` (roster-gated); logs NOTE-SENT ok=<bool>
//   env HYPERWAVE_LOBBY_MS=<ms>        -> shorten the lobby for tests
//   env HYPERWAVE_MAX_PEERS=<n>        -> Hyperswarm connection cap (lower to force a partial mesh)
const env = require('bare-env');
const path = require('bare-path');
const { createWave, parseBootstrap } = require('../lib/wave.js');
const { payFee, confirmBurn, wireWallet } = require('../lib/payments.js');

const name = Bare.argv[2] || 'peer';
const storageDir = Bare.argv[3];
if (!storageDir) {
  console.error('usage: bare bin/wave.run.js <name> <storageDir>');
  Bare.exit(1);
}
// Echo the resolved storage dir (and thus where wallet.seed lives) — a mis-quoted or relative
// path on the command line silently lands in the wrong dir, so make the ABSOLUTE one (resolved
// against cwd, same as bare-fs/Corestore downstream) visible at startup.
const absStorageDir = path.resolve(storageDir);
console.log(`[${name}] storage dir: ${absStorageDir}`);

const bootstrap = parseBootstrap(env.HYPERWAVE_BOOTSTRAP);

let started = false;
let settleTimer = null; // armed when connected to START peers; fires start once it holds SETTLE_MS
let payments = null; // set by the WALLET=1 block below (if enabled)

// Hold the start gate this long before firing. Reaching the gate means *I* (the initiator)
// finished meshing, but the other peers' gossip channels may still be forming — flooding the
// announce the instant I hit the gate could miss a peer whose channels aren't wired yet,
// dropping it from the wave (seen on a constrained runner: initiator fully connected, yet 2 of
// 5 peers never joined). A brief settle lets the rest of the mesh finish wiring.
const SETTLE_MS = 4000;
// Connectivity floor for the start gate. At small N a full mesh forms naturally and we wait
// for all of it — the strictest start condition. But a full mesh is IMPOSSIBLE at scale
// (Hyperswarm caps connections at maxPeers, and the protocol only needs the flood graph), so
// require full connectivity only up to this floor; past it, `discovered >= START` (the whole
// roster seen on the DHT) plus a well-connected initiator is the start condition.
const CONNECTED_FLOOR = 16;
const wave = createWave({
  storageDir,
  bootstrap,
  topicId: env.HYPERWAVE_TOPIC || undefined,
  lobbyMs: env.HYPERWAVE_LOBBY_MS ? Number(env.HYPERWAVE_LOBBY_MS) : undefined,
  maxPeers: env.HYPERWAVE_MAX_PEERS
    ? Number(env.HYPERWAVE_MAX_PEERS)
    : undefined,
  // Phase 2 subscription policy. HYPERWAVE_AUTO_SUBSCRIBE=0 → stay merely AWARE of announced waves
  // (hold no cores) until this peer explicitly subscribes/joins — the browse-then-pick path.
  autoSubscribe: env.HYPERWAVE_AUTO_SUBSCRIBE === '0' ? false : undefined,
  // One host sink: the wave emits typed messages ({type:'state'|'event'|'feed', …}); dispatch on
  // the type. (Replaces the former onState/onEvent/onFeed trio — see createWave.)
  emit: (msg) => {
    if (msg.type === 'state') {
      const state = msg;
      console.log(
        `[${name}] peers=${state.peers.length} connected=${state.connected} me=${state.me.id.slice(0, 8)}@${state.me.angle.toFixed(1)}`
      );
      // Start once the whole roster is DISCOVERED and we're CONNECTED to min(START,
      // CONNECTED_FLOOR) of them, held for SETTLE_MS. At small N that means the full mesh (the
      // strictest condition — discovery alone races ahead of the Protomux gossip channels the
      // flood rides, and racing a half-wired mesh dropped peers); at
      // large N a full mesh can't exist (Hyperswarm maxPeers, see CONNECTED_FLOOR) and the
      // flood over the topic mesh is what carries the lifecycle.
      if (!env.START || started) {
        return;
      }
      // With WALLET=1, wait for the wallet before arming — else startWave runs with the paid-gate
      // still off and announces an UNPAID wave (races wallet init vs discovery).
      const startTarget = Number(env.START);
      const discovered = Math.max(state.discovered || 0, state.peers.length);
      const ready =
        discovered >= startTarget &&
        state.connected >= Math.min(startTarget, CONNECTED_FLOOR) &&
        !(env.WALLET && !payments);
      if (ready && settleTimer === null) {
        settleTimer = setTimeout(() => {
          started = true;
          startWaveFlow();
        }, SETTLE_MS);
      } else if (!ready && settleTimer !== null) {
        clearTimeout(settleTimer); // connectivity regressed before settling — re-arm on the next
        settleTimer = null;
      }
    } else if (msg.type === 'event') {
      console.log(`[${name}] EVENT`, JSON.stringify(msg));
      // AUTOJOIN: try on announce (no-wallet path: already 'verified') and on wave-verified
      // (wallet path: after the start burn confirms). join() dedupes + gates on paid.
      if (
        env.AUTOJOIN &&
        !msg.mine &&
        (msg.event === 'wave-announce' || msg.event === 'wave-verified')
      ) {
        joinAndBurn();
      }
      // SPECTATE: subscribe (hold the feed + watch the sweep) WITHOUT joining/posting — the
      // browse-then-pick path (Phase 2). Meaningful with HYPERWAVE_AUTO_SUBSCRIBE=0, where
      // awareness alone holds no cores; subscribe() engages the feed on demand.
      if (env.SPECTATE && !msg.mine && msg.event === 'wave-announce') {
        wave.subscribe(msg.waveId);
      }
      // stage a (fake) entry payload during the lobby, exactly like a host does at start;
      // the engine posts it to the feed when this peer's sweep slot fires. The payload is
      // opaque to the engine — this CLI puts a {caption} object in it.
      if (env.AUTOENTRY && msg.event === 'wave-active' && msg.joined) {
        wave.stageEntry({ payload: { caption: `${name} was here` } });
      }
      // NOTE=1: broadcast a wave-note on `wave-idle` — emitted by goIdle AFTER it deletes the
      // WaveState, so this is the real tip-note timing (post-wave, browsing the idle gallery) and
      // it exercises the feed-lifetime roster (the FSM's writers are already gone). Log whether the
      // engine accepted it: the roster gate returns true for a participant, false for a spectator.
      // The received note surfaces on other peers as a `note` EVENT (asserted by the e2e).
      if (env.NOTE && msg.event === 'wave-idle') {
        const ok = wave.note({
          waveId: msg.waveId,
          note: { kind: 'test', from: name }
        });
        console.log(`[${name}] NOTE-SENT ok=${ok} waveId=${msg.waveId}`);
      }
    } else if (msg.type === 'feed') {
      console.log(
        `[${name}] FEED size=${msg.items.length} [${msg.items
          .map(
            (item) =>
              (item.payload?.caption ?? '') +
              (item.address ? ' $' + item.address.slice(0, 5) : '')
          )
          .join(', ')}]`
      );
    }
  },
  log: (...args) => console.log(`[${name}]`, ...args)
});

// Burn the participation fee (wallet.js: memo + ring attestation), logging the result.
async function burnFee(waveId, reason) {
  const result = await payFee({ wave, payments, waveId, reason });
  console.log(
    `[${name}] ${reason.toUpperCase()}-BURNED ${payments.fee} hash=${result.hash}`
  );
  return result;
}

// Initiator: start (deferred announce when enforcing), pay, wait for the burn to confirm
// on-chain, then announce. Without a wallet, startWave announces immediately (unpaid path).
async function startWaveFlow() {
  const waveId = wave.startWave();
  if (!waveId || !payments) {
    return;
  }
  try {
    const { hash, proof } = await burnFee(waveId, 'start');
    if (await confirmBurn(payments, waveId, hash)) {
      wave.announcePaid(proof);
    } else {
      console.log(`[${name}] start burn not confirmed`);
    }
  } catch (err) {
    console.log(`[${name}] start FAIL`, err.message);
  }
}

// Joiner: join() gates on the start being verified (null otherwise) and returns null
// once already joined, so a double event (announce + verified) burns once.
async function joinAndBurn() {
  const waveId = wave.join();
  if (!waveId || !payments) {
    return;
  }
  try {
    await burnFee(waveId, 'join');
  } catch (err) {
    console.log(`[${name}] join burn FAIL`, err.message);
  }
}

// env WALLET=1 -> bring up the WDK wallet and print address + balances (needs network).
// WALLET_TYPE=usdt (+ USDT_CONTRACT=<addr>) -> use the USDT/TRC-20 wallet instead of native TRX
// (the same seed/address holds both — USDT for fees, TRX for gas). TRON_NETWORK=<name> (nile
// default, mainnet, shasta) + optional TRON_PROVIDER=<url> -> pick the network (mainnet = real
// funds). WALLET_FEE=<amt> -> override the participation fee. WALLET_SEND=<addr>:<amt> -> also do a
// one-off transfer (funded wallets only).
if (env.WALLET) {
  const walletLog = (...args) => console.log(`[${name}] wallet`, ...args);
  const walletOpts = {
    storageDir,
    network: env.TRON_NETWORK, // undefined -> the wallet's default (nile)
    provider: env.TRON_PROVIDER, // undefined -> the network's default RPC
    fee: env.WALLET_FEE ? Number(env.WALLET_FEE) : undefined, // -> default fee
    log: walletLog
  };
  const ready =
    env.WALLET_TYPE === 'usdt'
      ? require('../lib/tron-usdt-wallet.js').createTronUsdtWallet({
          ...walletOpts,
          usdtContract: env.USDT_CONTRACT
        })
      : require('../lib/tron-wallet.js').createPayments(walletOpts);
  ready
    .then(async (pay) => {
      payments = pay;
      wireWallet(wave, pay); // paid-wave gate (on-chain burn verifier)
      const b = await pay.balances();
      // Format kept stable (the on-chain e2e matches `WALLET T… trx=`): `trx` is the fee-currency
      // balance (USDT for the usdt wallet). The `pay.type` disambiguates the payment mechanism.
      console.log(
        `[${name}] WALLET ${b.address} trx=${b.trx} type=${pay.type} storage=${absStorageDir}`
      );
      if (env.WALLET_SEND) {
        const [to, amt] = env.WALLET_SEND.split(':');
        const result = await pay.send(to, Number(amt));
        console.log(
          `[${name}] WALLET SENT ${amt} -> ${to} hash=${result.hash}`
        );
      }
    })
    .catch((err) => console.log(`[${name}] wallet FAIL`, err.message));
}
