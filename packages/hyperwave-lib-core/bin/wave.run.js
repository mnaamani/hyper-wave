#!/usr/bin/env bare
// One wave instance per process (the real topology: each worker is its own process).
// Runs under Bare:  bare bin/wave.run.js <name> <storageDir>  (or, if installed: hyperwave-wave)
// Needs `bare` on PATH — it's a separate runtime, not an npm dependency.
//   env HYPERWAVE_BOOTSTRAP=host:port  -> local DHT (fast same-machine discovery)
//   env HYPERWAVE_MATCH=<id>           -> isolated match topic
//   env START=<n>                      -> announce a wave once >= n peers are present
//   env AUTOJOIN=1                     -> auto opt-in when a wave is announced
//   env AUTOSELFIE=1                   -> stage a fake selfie in the lobby (posted when the ball arrives, if joined)
//   env HYPERWAVE_LOBBY_MS=<ms>        -> shorten the lobby for tests
const env = require('bare-env');
const path = require('bare-path');
const { createWave, parseBootstrap } = require('../lib/wave.js');
const { nodeIdOfHex, RING } = require('../lib/chord.js');
const { FEE_TRX, payFee, confirmBurn, wireWallet } = require('../lib/fees.js');

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
let payments = null; // set by the WALLET=1 block below (if enabled)
const wave = createWave({
  storageDir,
  bootstrap,
  matchId: env.HYPERWAVE_MATCH || undefined,
  lobbyMs: env.HYPERWAVE_LOBBY_MS ? Number(env.HYPERWAVE_LOBBY_MS) : undefined,
  onState: (state) => {
    console.log(
      `[${name}] peers=${state.peers.length} me=${state.me.id.slice(0, 8)}@${state.me.angle.toFixed(1)} ` +
        `succ=${state.successor ? state.successor.id.slice(0, 8) + '@' + state.successor.angle.toFixed(1) : 'none'}`
    );
    if (env.START && !started && state.peers.length >= Number(env.START)) {
      // With WALLET=1, wait for the wallet before kicking off — else startWave runs with the
      // paid-gate still off and announces an UNPAID wave (races wallet init vs discovery).
      if (env.WALLET && !payments) {
        return;
      }
      started = true;
      setTimeout(() => kickOff(), 500);
    }
  },
  onEvent: (evt) => {
    console.log(`[${name}] TOKEN`, JSON.stringify(evt));
    // AUTOJOIN: try on announce (no-wallet path: already 'verified') and on wave-verified
    // (wallet path: after the kick-off burn confirms). join() dedupes + gates on paid.
    if (
      env.AUTOJOIN &&
      !evt.mine &&
      (evt.event === 'wave-announce' || evt.event === 'wave-verified')
    ) {
      joinAndBurn();
    }
    // stage a (fake) selfie during the lobby, exactly like the renderer does at kickoff;
    // the worker posts it to the gallery when the token reaches this peer.
    if (env.AUTOSELFIE && evt.event === 'wave-active' && evt.joined) {
      wave.stageSelfie({ caption: `${name} was here`, image: `fake-image-${name}` });
    }
  },
  onGallery: (items) =>
    console.log(
      `[${name}] GALLERY size=${items.length} [${items
        .map((item) => item.caption + (item.address ? ' $' + item.address.slice(0, 5) : ''))
        .join(', ')}]`
    ),
  log: (...args) => console.log(`[]`, ...args)
});

// Burn the participation fee (fees.js: memo + ring attestation), logging the result.
async function burnFee(waveId, reason) {
  const result = await payFee(wave, payments, waveId, reason);
  console.log(`[${name}] ${reason.toUpperCase()}-BURNED ${FEE_TRX} TRX hash=`);
  return result;
}

// Initiator: start (deferred announce when enforcing), pay, wait for the burn to confirm
// on-chain, then announce. Without a wallet, startWave announces immediately (unpaid path).
async function kickOff() {
  const waveId = wave.startWave();
  if (!waveId || !payments) {
    return;
  }
  try {
    const { hash, proof } = await burnFee(waveId, 'kickoff');
    if (await confirmBurn(payments, waveId, hash)) {
      wave.announcePaid(proof);
    } else {
      console.log(`[${name}] kick-off burn not confirmed`);
    }
  } catch (err) {
    console.log(`[${name}] kickoff FAIL`, err.message);
  }
}

// Joiner: join() gates on the kick-off being verified (null otherwise), so we only pay for
// a proven-paid wave. Guarded so a double event (announce + verified) burns once.
let joining = false;
async function joinAndBurn() {
  if (joining) {
    return;
  }
  const waveId = wave.join();
  if (!waveId) {
    return;
  }
  if (!payments) {
    return;
  }
  joining = true;
  try {
    await burnFee(waveId, 'join');
  } catch (err) {
    console.log(`[${name}] join burn FAIL`, err.message);
  }
}

// env PROBE=1 -> after peers converge, exercise the distributed findSuccessor RPC by
// looking up the successor of the position just after me (my true successor).
if (env.PROBE) {
  setTimeout(async () => {
    const succ = await wave.findSuccessor((nodeIdOfHex(wave.me.id) + 1n) % RING);
    console.log(`[${name}] FINDSUCC my-successor = ${succ ? succ.slice(0, 8) : 'null'}`);
  }, 8000);
}

// env WALLET=1 -> bring up the WDK wallet and print address + balances (needs network).
// WALLET_SEND=<addr>:<amt> -> also do a one-off TRX transfer (funded wallets only).
if (env.WALLET) {
  const { createPayments } = require('../lib/pay.js');
  createPayments({ storageDir, log: (...args) => console.log(`[] wallet`, ...args) })
    .then(async (pay) => {
      payments = pay;
      wireWallet(wave, pay); // paid-wave gate (on-chain burn verifier)
      const b = await pay.balances();
      console.log(`[${name}] WALLET ${b.address} trx=${b.trx} storage=${absStorageDir}`);
      if (env.WALLET_SEND) {
        const [to, amt] = env.WALLET_SEND.split(':');
        const result = await pay.send(to, Number(amt));
        console.log(`[${name}] WALLET SENT ${amt} -> ${to} hash=`);
      }
    })
    .catch((err) => console.log(`[${name}] wallet FAIL`, err.message));
}
