# hyper-wave — usage & examples

Worked examples for the HyperWave engine and its submodules. For _what_ the pieces are and how
they interact, see [`docs/architecture.md`](../../docs/architecture.md) and
[`docs/protocol.md`](../../docs/protocol.md); this file is all _how do I call it_.

> **Runs under [Bare](https://github.com/holepunchto/bare), not Node.** Examples assume `bare`.
> The pure submodules (`ring`/`token`/`chord`/`flood`/`gallery`) do no I/O and also run fine under
> Node if you just want to play with the math/crypto.

**Two import surfaces:**

```js
// 1. The package entry re-exports the host-level building blocks:
const {
  createEngine,
  createWave,
  createPayments,
  parseBootstrap,
  loadOrCreateSwarmSeed
} = require('hyper-wave');
const { FEE_TRX, payFee, confirmBurn, wireWallet } = require('hyper-wave'); // fees.js

// 2. The pure submodules are imported by subpath (not re-exported from the index):
const ring = require('hyper-wave/lib/ring');
const token = require('hyper-wave/lib/token');
const chord = require('hyper-wave/lib/chord');
const { createFlood } = require('hyper-wave/lib/flood');
const gallery = require('hyper-wave/lib/gallery');
```

Contents: [Host the engine](#1-host-the-whole-engine-createengine) · [Drive it headless](#2-drive-a-wave-headless-createwave) ·
[ring.js](#3-ringjs--seats--successors) · [chord.js](#4-chordjs--topology-math) · [token.js](#5-tokenjs--receipts--attestations) ·
[flood.js](#6-floodjs--gossip-dedup) · [gallery.js](#7-galleryjs--the-autobase-selfie-gallery) ·
[payments](#8-payments--feesjs--payjs) · [seeds & bootstrap](#9-seed--bootstrap-helpers)

---

## 1. Host the whole engine (`createEngine`)

The host-agnostic entry. Give it a `storageDir`, an optional `config`, and a `send` callback; feed
it commands via `onMessage`. This is the entire surface a host (the desktop worker / mobile
worklet) needs.

```js
const { createEngine } = require('hyper-wave');

const engine = createEngine({
  storageDir: '/tmp/hyperwave/a', // one dir per peer (the hyperwave/ store is wiped on startup)
  config: {
    matchId: 'hyperwave:my-match:v1', // peers on the same matchId share one ring
    bootstrap: '127.0.0.1:49737', // optional host:port → local DHT (instant same-machine discovery)
    wallet: true // default; false → wallet-less (receipt-only gallery, no fees/tips)
  },
  send: (msg) => {
    // engine → host events, e.g. { type: 'state' | 'event' | 'gallery' | 'wallet' | 'burn-result' }
    if (msg.type === 'state') {
      console.log(
        'ring:',
        msg.peers.length,
        'me:',
        msg.me.id.slice(0, 8),
        '@',
        msg.me.angle.toFixed(1)
      );
    }
  }
});

// host → engine commands:
engine.onMessage({ type: 'set-country', country: 'BR' });
engine.onMessage({ type: 'start-wave' }); // burns the kick-off fee, then announces + opens the lobby
engine.onMessage({ type: 'join-wave' }); // opt into an announced wave (+ burns the join fee)
engine.onMessage({ type: 'stage-selfie', selfie: { image: '<jpeg-data-url>', caption: 'hi' } });
engine.onMessage({ type: 'tip', to: 'T...', amount: 5 }); // real testnet TRX to a selfie owner
engine.onMessage({ type: 'send-trx', to: 'T...', amount: 10 });
engine.onMessage({ type: 'fetch-transactions' }); // → { type:'transactions', list }
engine.onMessage({ type: 'refresh-wallet' }); // → a fresh { type:'wallet', address, trx }

await engine.close();
```

Command / event reference: `docs/protocol.md` §5; the state-machine `event` names (`started`,
`holding`, `position`, `forwarded`, `healed`, `completed`, …) in §5 as well.

---

## 2. Drive a wave headless (`createWave`)

`createEngine` wraps `createWave` + the wallet. If you want the engine without the payment layer (tests,
a custom host), call `createWave` directly. It builds the Hyperswarm/Corestore transport and
returns the wave controls.

```js
const { createWave, parseBootstrap } = require('hyper-wave');

const wave = createWave({
  storageDir: '/tmp/hw/a',
  matchId: 'demo',
  bootstrap: parseBootstrap('127.0.0.1:49737'), // or null for the public DHT
  onState: ({ me, peers, successor }) => {
    console.log(
      'me',
      me.id.slice(0, 8),
      '@',
      me.angle.toFixed(1),
      'succ',
      successor?.id.slice(0, 8)
    );
  },
  onEvent: (ev) => console.log('event', ev.event, ev.waveId),
  onGallery: (items) => console.log('gallery', items.length)
  // swarmSeed: '<hex>'  // optional injected identity seed; else <storage>/swarm.seed (see §9)
});

console.log('my seat:', wave.me); // { id, angle, country }
const waveId = wave.startWave(); // announce + open the lobby; returns the new waveId (or null if busy)
wave.setCountry('BR');
wave.stageSelfie({ image: 'fake', caption: 'me' }); // staged; posts when the ball arrives
const succId = await wave.findSuccessor(BigInt('0x' + wave.me.id.slice(0, 16)) + 1n); // distributed Chord lookup
await wave.close();
```

`createWave` returns: `{ me, startWave, join, setCountry, stageSelfie, setWallet, announcePaid,
recordBurn, findSuccessor, close }`. The payment methods (`setWallet`/`announcePaid`/`recordBurn`)
are wired by `fees.js` — see §8.

---

## 3. `ring.js` — seats & successors

Pure geometry: a peer's key deterministically maps to a **seat angle**; the ring is the live peers
sorted clockwise. No state, no I/O.

```js
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const {
  angleOf,
  angleOfId,
  liveRing,
  nextClockwise,
  pickReachable
} = require('hyper-wave/lib/ring');

// a seat angle is derived from the public key — never trusted from the wire
const me = crypto.keyPair();
const myId = b4a.toString(me.publicKey, 'hex');
const myAngle = angleOf(me.publicKey); // 0..360
angleOfId(myId) === myAngle; // true — same value from the hex id

// build a live, clockwise-sorted ring from heartbeat entries { id, angle, lastSeen }
const now = Date.now();
const entries = [
  { id: 'aa'.repeat(32), angle: 12.3, lastSeen: now },
  { id: 'bb'.repeat(32), angle: 300.1, lastSeen: now - 60_000 } // stale
];
const STALE_MS = 30_000;
const live = liveRing(entries, now, STALE_MS); // drops the stale peer, sorts by angle

const successor = nextClockwise(myAngle, live); // next seat clockwise (wraps to the first)

// healing: the next seat clockwise that's reachable and not already skipped
const reachable = new Set(live.map((peer) => peer.id));
const skipped = new Set([successor?.id]); // pretend the successor went silent
const alternate = pickReachable(live, myAngle, reachable, skipped);
```

---

## 4. `chord.js` — topology math

Pure Chord pointer math over a 64-bit id ring (`nodeId = top 8 bytes of the key`). `wave.js` uses
it to decide which peers to physically connect to (`joinPeer`) so the logical ring's edges become
real. All ids are lowercase hex; keyspace positions are `BigInt` mod `2^64`.

```js
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const chord = require('hyper-wave/lib/chord');

const ids = Array.from({ length: 8 }, () => b4a.toString(crypto.keyPair().publicKey, 'hex'));
const myId = ids[0];

// neighbourhood (pass the full id list — it injects/dedupes myId internally)
chord.successors(ids, myId, 3); // up to 3 successor ids clockwise (the successor-list)
chord.predecessor(ids, myId); // the one id counter-clockwise
chord.fingers(ids, myId); // Set of O(log N) finger ids spanning the ring
chord.pinTargets(ids, myId, 3); // Set: successors + predecessor + fingers → what wave.js joinPeer()s

// find the successor of any keyspace position
const target = (chord.nodeIdOfHex(myId) + 1n) % chord.RING;
chord.findSuccessor(ids, target); // hex id of the first node clockwise of target

// one hop of the DISTRIBUTED lookup, using only what THIS node knows (converges in O(log N) hops)
const succId = chord.successors(ids, myId, 3)[0] ?? null;
const known = [...chord.fingers(ids, myId), ...chord.successors(ids, myId, 3)];
const step = chord.findSuccessorStep(myId, succId, known, target);
// → { done: true, successor } (answer found) | { done: false, next } (forward to `next`, repeat)

// stabilize: adopt my successor's predecessor if it slotted in between us
chord.stabilizeStep(myId, succId, /* succPredId */ ids[3]); // → the id to use as successor
```

Interval predicates are exported too if you need them directly: `inOpenInterval(x, a, b)`,
`inHalfOpenInterval(x, a, b)`, `ringForward(a, b)`, `closestPrecedingNode(known, myId, target)`.

---

## 5. `token.js` — receipts & attestations

The pure crypto behind the racing token and the paid-wave gates. Every function is stateless.

**Receipt chain** — each hop signs a receipt; a constant-size accumulator rolls forward (never a
growing `hops[]`):

```js
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const {
  ZERO_HASH,
  signReceipt,
  verifyReceipt,
  advanceChain,
  verifyToken
} = require('hyper-wave/lib/token');

const kp = crypto.keyPair();
const peerId = b4a.toString(kp.publicKey, 'hex');
const waveId = 'w1';
const hop = 1;
const ts = Date.now();

const sig = signReceipt(kp, waveId, hop, ZERO_HASH, ts); // ZERO_HASH = the genesis accumulator
verifyReceipt(peerId, waveId, hop, ZERO_HASH, ts, sig); // → true
const chainHash = advanceChain(ZERO_HASH, sig); // blake2b(prev || sig) — constant size

// verifyToken() checks the receipt the SENDER stamped on a forwarded token
const tokenMsg = {
  senderPeerId: peerId,
  waveId,
  hopCount: hop,
  prevChainHash: ZERO_HASH,
  timestamp: ts,
  senderReceiptSig: sig
};
verifyToken(tokenMsg); // → true
```

**Burn attestation** — bridges a peer's ring identity to its on-chain fee burn; authorizes a
gallery write:

```js
const { signBurn, verifyBurn, burnAuthorizes } = require('hyper-wave/lib/token');

const fields = {
  waveId,
  peerId,
  reason: 'kickoff',
  amount: 1,
  txHash: 'deadbeef…',
  tronAddress: 'T…',
  burnTs: ts
};
const proof = { ...fields, sig: signBurn(kp, fields) };
verifyBurn(fields, proof.sig); // → true
burnAuthorizes(proof, peerId, waveId); // → true (signature valid AND bound to this peer + wave)
```

**Gallery-key & wave-end attestations** — the originator signs the gallery key and the completion
so a relay can't swap either:

```js
const {
  signGalleryKey,
  verifyGalleryKey,
  signWaveEnd,
  verifyWaveEnd
} = require('hyper-wave/lib/token');

const keySig = signGalleryKey(kp, waveId, /* autobaseKey */ 'ab12…');
verifyGalleryKey(peerId, waveId, 'ab12…', keySig); // → true (peerId = the originator)

const endSig = signWaveEnd(kp, waveId, /* hops */ 8, chainHash);
verifyWaveEnd(peerId, waveId, 8, chainHash, endSig); // → true
```

---

## 6. `flood.js` — gossip dedup

One rule turns a one-hop broadcast into an epidemic across a partial mesh: relay each message id on
**first sight only**. Size-capped so the set can't grow unbounded.

```js
const { createFlood } = require('hyper-wave/lib/flood');

const flood = createFlood({ cap: 4096 });

function onGossip(msg, fromPeer) {
  if (!flood.firstSight(msg.mid)) {
    return; // already seen → drop (kills loops + duplicate work)
  }
  handle(msg);
  for (const peer of neighboursExcept(fromPeer)) {
    peer.send(msg); // relay onward
  }
}

flood.size; // current number of remembered ids
```

---

## 7. `gallery.js` — the Autobase selfie gallery

`galleryConfig()` is the Autobase apply/open config; `readGallery(base)` reads the ordered view.
`apply()` deterministically enforces the write-gate (valid receipt), byte caps, one-entry-per-peer,
and the burn-backed tip address — so every peer converges on the same gallery.

```js
const Corestore = require('corestore');
const Autobase = require('autobase');
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const { galleryConfig, readGallery, buildGallery } = require('hyper-wave/lib/gallery');
const { signReceipt } = require('hyper-wave/lib/token');

const store = new Corestore('/tmp/hw-gallery');
const base = new Autobase(store.namespace('wave-gallery'), null, galleryConfig());
await base.ready();

// build a receipt-valid wave-selfie op (an invalid/unsigned one is silently dropped by apply())
const kp = crypto.keyPair();
const peerId = b4a.toString(kp.publicKey, 'hex');
const waveId = 'w1';
const chainHash = b4a.toString(b4a.alloc(32), 'hex');
const receiptTs = Date.now();
const op = {
  type: 'wave-selfie',
  waveId,
  peerId,
  hopCount: 0,
  chainHash,
  receiptTs,
  receiptSig: signReceipt(kp, waveId, 0, chainHash, receiptTs),
  image: '<jpeg-data-url>',
  caption: 'hello',
  timestamp: receiptTs
};

await base.append(op);
await base.update();
const items = await readGallery(base); // ordered by hop, one entry per peer
await base.close();
await store.close();

// buildGallery(entries) is the same pure ordering/dedup over an array you already have
buildGallery([op]); // → [op]
```

To admit another writer, append `{ type: 'add-writer', key: '<hex writer key>' }` — `apply()` calls
`host.addWriter` for it.

---

## 8. Payments — `fees.js` + `pay.js`

`createPayments` is the self-custodial WDK wallet (Tron Nile testnet). It's `async` because WDK is
ESM-only. `fees.js` composes it into the wave (fee burns + the paid-wave gate).

```js
const { createPayments } = require('hyper-wave');

const pay = await createPayments({ storageDir: '/tmp/hw/a' /*, seed: '<mnemonic>' */ });
console.log(pay.address); // T… (derived offline from the seed at <storage>/wallet.seed)

await pay.balances(); // → { address, trx }  (network call)
await pay.send('T…recipient', 5); // → { hash, fee }  a real testnet transfer
await pay.burn(1, `hyperwave:${'w1'}:${pay.address}`); // → { hash, fee }  send to the black hole + memo
await pay.verifyBurnTx('deadbeef…', { waveId: 'w1', from: pay.address, minTrx: 1 }); // → { ok, reason? }
await pay.transactions(10); // → recent on-chain txs, both directions
pay.dispose();
```

Wire it into a `createWave` instance and run the fee flow with `fees.js`:

```js
const { createWave, FEE_TRX, payFee, confirmBurn, wireWallet } = require('hyper-wave');

const wave = createWave({ storageDir: '/tmp/hw/a', onState() {} });
wireWallet(wave, pay); // sets the wallet address (tips) + the on-chain burn verifier (paid gate)

// kick-off: start → burn the fee → wait for on-chain confirmation → announce the (now-paid) wave
const waveId = wave.startWave();
const { hash, proof } = await payFee(wave, pay, waveId, 'kickoff'); // FEE_TRX burned + attestation signed
if (await confirmBurn(pay, waveId, hash)) {
  wave.announcePaid(proof); // peers verify this before they'll join
}
```

`FEE_TRX` is the fixed participation fee (1 TRX). `payFee(wave, payments, waveId, reason)` burns it
and returns `{ hash, proof }`; `confirmBurn` polls the chain until the burn is readable.

> `engine.js` already composes exactly this (`handleStartWave`/`handleJoin`) — read it for the
> reference wiring, including the fail-fast balance checks and the `burn-result` staging.

---

## 9. Seed & bootstrap helpers

```js
const { parseBootstrap, loadOrCreateSwarmSeed } = require('hyper-wave');

// "host:port[,host:port…]" → Hyperswarm's bootstrap option (a local DHT); '' → null (public DHT)
parseBootstrap('127.0.0.1:49737'); // → [{ host: '127.0.0.1', port: 49737 }]

// the persisted 32-byte swarm-identity seed → a stable ring seat/id across restarts.
// Creates + writes <storage>/swarm.seed on first run; an injected hex seed is used verbatim.
const seed = loadOrCreateSwarmSeed('/tmp/hw/a'); // Buffer(32)
const crypto = require('hypercore-crypto');
const keyPair = crypto.keyPair(seed); // the same identity every run (see docs/protocol.md §1)
```

`createWave` calls `loadOrCreateSwarmSeed` for you; pass `createWave({ swarmSeed })` only to inject
an identity (e.g. from mobile secure storage). It is a **separate** seed from the wallet seed
(`createPayments({ seed })`) — see [`docs/secure-seed-storage.md`](../../docs/secure-seed-storage.md).

---

## Running the examples & tests

```bash
bare bin/wave.run.js A /tmp/hw/a     # a headless wave host (dev CLI)
bare bin/dht-local.js                # a local DHT bootstrap (prints host:port)
npm test                             # unit suites (from repo root; delegates here)
bare lib/chord.test.js               # a single suite
```
