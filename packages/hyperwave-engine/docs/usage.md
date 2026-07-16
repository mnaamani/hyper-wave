# hyperwave-engine — usage & examples

Worked examples for the HyperWave engine and its submodules. For _what_ the pieces are and how
they interact, see [`protocol.md`](./protocol.md) (the engine spec) and the apps'
[`hosting.md`](../../../apps/docs/hosting.md); this file is all _how do I call it_.

> **The engine is theme-agnostic.** It provides a generic primitive: peers join a shared
> **topic**, map to seats on a DHT **ring**, and any peer triggers a **wave** that
> **sweeps** the ring on a deterministic schedule; each participant contributes one
> **entry** (an opaque `payload` the host owns) to a per-wave CRDT **feed**, optionally
> gated by proof-of-burn, and carries a cosmetic **tag**. The football "stadium wave" app
> (`apps/desktop`) is one host over this engine — it fills the payload with a selfie and
> uses the tag as a country. Build any turn-taking / coordinated-snapshot app the same way.

> **Runs under [Bare](https://github.com/holepunchto/bare), not Node.** Examples assume `bare`.
> The pure submodules (`ring`/`sweep`/`attest`/`messages`/`flood`/`feed`) do no I/O and
> also run fine under Node if you just want to play with the math/crypto.

**Two import surfaces:**

```js
// 1. The package entry re-exports the host-level building blocks:
const {
  createEngine,
  createWave,
  createPayments,
  parseBootstrap,
  loadOrCreateSwarmSeed,
  serveEngine,
  createRpcClient // the host<->UI IPC seam (rpc.js) — §12
} = require('hyperwave-engine');
const {
  FEE_TRX,
  payFee,
  confirmBurn,
  wireWallet
} = require('hyperwave-engine'); // wallet.js

// 2. The pure submodules are imported by subpath (not re-exported from the index):
const ring = require('hyperwave-engine/lib/ring');
const sweep = require('hyperwave-engine/lib/sweep');
const attest = require('hyperwave-engine/lib/attest');
const messages = require('hyperwave-engine/lib/messages');
const { Flood } = require('hyperwave-engine/lib/flood');
const feed = require('hyperwave-engine/lib/feed');

// 3. The stateful classes wave.js composes (also subpath imports — see §11):
const { PeerTable } = require('hyperwave-engine/lib/peer-table');
const { EntryPipeline } = require('hyperwave-engine/lib/entry');
const { CrdtFeed } = require('hyperwave-engine/lib/feed-crdt');
```

Contents: [Host the engine](#1-host-the-whole-engine-createengine) · [Drive it headless](#2-drive-a-wave-headless-createwave) ·
[ring.js](#3-ringjs--seats--the-ring) · [sweep.js](#4-sweepjs--the-deterministic-schedule) · [attest.js](#5-attestjs--attestations) ·
[messages.js](#6-messagesjs--the-gossip-message-seam) · [flood.js](#7-floodjs--the-flood-graph) · [feed.js](#8-feedjs--the-multicore-crdt-feed) ·
[payments](#9-payments--walletjs) · [seeds & bootstrap](#10-seed--bootstrap-helpers) ·
[stateful classes](#11-the-stateful-classes-wavejs-composes) ·
[rpc.js IPC seam](#12-rpcjs--the-hostui-ipc-seam-bare-rpc)

---

## 1. Host the whole engine (`createEngine`)

The host-agnostic entry. Think of it like a kernel: give it a `storageDir`, an optional `config`,
and an `emit` callback (engine → host events); feed it commands via `exec` (host → engine, like a
syscall). This is the entire surface a host (the desktop worker / mobile worklet) needs.

```js
const { createEngine } = require('hyperwave-engine');

const engine = createEngine({
  storageDir: '/tmp/hyperwave/a', // one dir per peer (the hyperwave/ store is wiped on startup)
  config: {
    topicId: 'hyperwave:my-match:v1', // peers on the same topicId share one ring
    bootstrap: '127.0.0.1:49737', // optional host:port → local DHT (instant same-machine discovery)
    wallet: true, // default; false → wallet-less (join-attestation feed, no fees/tips)
    autoSubscribe: true // default; false → browse-then-pick (hold cores only for waves you subscribe to)
  },
  emit: (msg) => {
    // engine → host events, e.g. { type: 'state' | 'event' | 'feed' | 'wallet' | 'burn-result' }
    // (a 'feed' message carries a `waveId` — several waves can update concurrently)
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
engine.exec({ type: 'set-tag', tag: 'BR' }); // cosmetic per-peer tag
engine.exec({ type: 'start-wave' }); // burns the start fee, then announces + opens the lobby
engine.exec({ type: 'join-wave' }); // opt into an announced wave (+ burns the join fee)
// subscription layer (scaling.md Phase 2/3): browse-then-pick when autoSubscribe:false.
engine.exec({ type: 'subscribe-wave', waveId: 'a1b2…' }); // hold a wave's feed without joining
engine.exec({ type: 'unsubscribe-wave', waveId: 'a1b2…' }); // free its cores (stay aware)
engine.exec({
  type: 'stage-entry',
  // payload is opaque application content — the host owns its shape
  entry: { payload: { image: '<jpeg-data-url>', caption: 'hi' } }
});
engine.exec({ type: 'tip', to: 'T...', amount: 5 }); // real testnet TRX to an entry owner
engine.exec({ type: 'send-trx', to: 'T...', amount: 10 });
engine.exec({ type: 'fetch-transactions' }); // → { type:'transactions', list }
engine.exec({ type: 'refresh-wallet' }); // → a fresh { type:'wallet', address, trx }

await engine.close();
```

Command / event reference: `protocol.md` §5; the state-machine `event` names (`started`,
`joined`, `roster`, `holding`, `position`, `completed`, …) in §5 as well.

---

## 2. Drive a wave headless (`createWave`)

`createEngine` wraps `createWave` + the wallet. If you want the engine without the payment layer (tests,
a custom host), call `createWave` directly. It builds the Hyperswarm/Corestore transport and
returns the wave controls.

```js
const { createWave, parseBootstrap } = require('hyperwave-engine');

const wave = createWave({
  storageDir: '/tmp/hw/a',
  topicId: 'demo',
  bootstrap: parseBootstrap('127.0.0.1:49737'), // or null for the public DHT
  // One host sink `emit(msg)` — every observable change is a typed message:
  //   { type: 'state', me, peers, connected, discovered } — the live ring, the direct-connection
  //     count, and the DHT-discovered count (hosts gate start triggers on `discovered`)
  //   { type: 'event', event, … } — lifecycle/UI events;  { type: 'feed', waveId, items } — feed updates
  emit: (msg) => {
    if (msg.type === 'state') {
      console.log('me', msg.me.id.slice(0, 8), 'peers', msg.peers.length);
    } else if (msg.type === 'event') {
      console.log('event', msg.event, msg.waveId);
    } else if (msg.type === 'feed') {
      console.log('feed', msg.waveId, msg.items.length);
    }
  }
  // swarmSeed: '<hex>'  // optional injected identity seed; else <storage>/swarm.seed (see §10)
});

console.log('my seat:', wave.me); // { id, angle, tag }
const waveId = wave.startWave(); // announce + open the lobby; always returns the new waveId
wave.setTag('BR');
wave.stageEntry({ payload: { label: 'me' } }); // opaque payload; posts at my sweep slot
await wave.close();
```

`createWave` returns: `{ me, startWave, subscribe, unsubscribe, join, setTag, stageEntry,
setWallet, announcePaid, recordBurn, close }`. Concurrent waves are allowed — `startWave()`
never returns null and there is no "busy" guard. `join(waveId?)` / `stageEntry({payload, waveId?})`
default to the newest joinable / joined wave; `subscribe(waveId)` / `unsubscribe(waveId)` open /
close a wave's feed (holding cores only for waves you subscribed to — see §11 CrdtFeed). There is
no routing surface — the wave is a deterministic sweep. The payment methods
(`setWallet`/`announcePaid`/`recordBurn`) are wired by `wallet.js` — see §9.

---

## 3. `ring.js` — seats & the ring

Pure geometry: a peer's key deterministically maps to a **seat angle**; the ring is the live peers
sorted clockwise. It defines the wave's semantics (sweep order, feed order) — it is **not** the
connection topology (that's Hyperswarm's own topic mesh). No state, no I/O.

```js
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const { angleOf, angleOfId, liveRing } = require('hyperwave-engine/lib/ring');

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
```

---

## 4. `sweep.js` — the deterministic schedule

The wave itself. A `wave-start` carries the canonical roster plus the sweep
parameters `t0` (epoch ms) and `lapMs`; every peer derives the **same** angle-ordered schedule
locally and self-triggers its entry at its own slot. A dead peer's slot simply passes — no
routing, no healing. Pure math, no transport.

```js
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const { sweepSchedule, mySlot } = require('hyperwave-engine/lib/sweep');

const rosterIds = Array.from({ length: 8 }, () =>
  b4a.toString(crypto.keyPair().publicKey, 'hex')
);
const t0 = Date.now();
const lapMs = 8000;

// the full schedule: ordered by ring angle (id tie-break), one evenly-spread slot each
const schedule = sweepSchedule({ rosterIds, t0, lapMs });
// → [{ id, angle, rank, at }, …] where `at` = t0 + round((rank / count) * lapMs)

// my slot (or null if I'm a spectator not in the roster)
const slot = mySlot(schedule, rosterIds[0]);
// self-trigger: setTimeout(fireMyEntry, slot.at - Date.now())
```

The ⚽ on every screen is rendered from this same schedule (renderer-local, no gossip), and the
wave ends deterministically on every peer at `t0 + lapMs + END_GRACE_MS` — there is no completion
message.

---

## 5. `attest.js` — attestations

The pure Ed25519 crypto behind the paid-wave gate and the feed write credential. Every function
is stateless.

**Burn attestation** — bridges a peer's ring identity to its on-chain fee burn; authorizes a
feed write and binds the tip address:

```js
const {
  signBurn,
  verifyBurn,
  burnAuthorizes
} = require('hyperwave-engine/lib/attest');

const kp = crypto.keyPair();
const peerId = b4a.toString(kp.publicKey, 'hex');
const waveId = 'w1';
const fields = {
  waveId,
  peerId,
  reason: 'start',
  amount: 1,
  txHash: 'deadbeef…',
  tronAddress: 'T…',
  burnTs: Date.now()
};
const proof = { ...fields, sig: signBurn(kp, fields) };
verifyBurn(fields, proof.sig); // → true
burnAuthorizes(proof, peerId, waveId); // → true (signature valid AND bound to this peer + wave)
```

**Join attestation** — a peer's signed opt-in, binding its identity to the feed writer core it
publishes. It rides `wave-join` (the join IS the write credential — self-certifying, no central
admission) and every feed entry carries it (`mergeFeed`'s write-gate):

```js
const { signJoin, verifyJoin } = require('hyperwave-engine/lib/attest');

const writerKey = 'ab12…'; // this peer's feed Hypercore key (hex)
const joinSig = signJoin(kp, { waveId, writerKey });
verifyJoin({ waveId, peerId, writerKey }, joinSig); // → true (peerId signed this join)
```

---

## 6. `messages.js` — the gossip message seam

The single definition point for the six on-wire message kinds (`protocol.md` §5: `heartbeat`,
`subs`, `wave-announce`, `wave-join`, `wave-start`, `wave-sync`): one `make*` factory per kind
(builds the KIND + PAYLOAD; the uniform envelope — `origin`/`ts`/`sig`, §5.0 — is stamped at
origination by wave.js via `attest.signMessage`) and one shape validator per kind, run once at the
receive edge via `validGossip` (which checks the envelope + payload shape) before the envelope-sig
verification (`attest.verifyMessage`), age check, and state work. Validation is shape only —
signatures / age / the paid gate stay in `attest.js` / the handlers. `FLOODED_KINDS` is the
flooded/direct classification the relay decision uses.

```js
const {
  FLOODED_KINDS,
  validGossip,
  makeHeartbeat,
  makeSubs,
  makeWaveJoin
} = require('hyperwave-engine/lib/messages');
const { signMessage } = require('hyperwave-engine/lib/attest');

// factories build the KIND + PAYLOAD (no author field — origin is the envelope). wave.js seals
// each ORIGINATED message with the envelope; here we do it by hand to satisfy validGossip:
const seal = (msg) => {
  const framed = { ...msg, origin: peerId, ts: Date.now() };
  return { ...framed, sig: signMessage(myKeyPair, framed) };
};

validGossip(makeHeartbeat({ tag: 'BR' })); // → false: no envelope yet
validGossip(seal(makeHeartbeat({ tag: 'BR' }))); // → true (direct kind — envelope, no mid)

const subs = makeSubs({ subs: [waveId] }); // my subscription set — scopes wave gossip (Phase 3)
validGossip(seal(subs)); // → true (one-hop, no mid)

const join = makeWaveJoin({ waveId, writerKey, joinSig }); // origin is the joiner
validGossip(seal(join)); // → false: flooded kinds ALSO need their flood mid...
validGossip(seal({ ...join, mid: 'ab12cd34ef56ab12' })); // → true (originateFlood stamps mid + envelope)

FLOODED_KINDS.has('wave-join'); // → true (relayed); heartbeat/subs/wave-sync are one-hop
validGossip(seal({ kind: 'token', waveId })); // → false — unknown kinds are dropped at the edge
```

---

## 7. `flood.js` — the flood graph

One rule turns a one-hop broadcast into an epidemic across a partial mesh: relay each message id on
**first sight only**. Size-capped so the set can't grow unbounded.

```js
const { Flood } = require('hyperwave-engine/lib/flood');

const flood = new Flood({ cap: 4096 });

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

Flood reach needs a connected graph; the graph is Hyperswarm's own topic mesh (a random
mesh of degree ≈ `maxPeers`, connected with overwhelming probability). Nothing is pinned.

---

## 8. `feed.js` — the multicore CRDT feed

The feed is a multicore CRDT. Each participant
owns **one** Hypercore and appends its single `wave-entry` op at block 0; its writer key rides
that peer's own `wave-join` (self-certified by the join attestation). Every peer **subscribed to
the wave** opens every participant's core, downloads block 0, and folds the bag with the pure
**`mergeFeed`** — every peer that has replicated the same set of cores computes a **byte-identical**
feed. No indexer, no admission, no consensus, no shared feed key. The stateful `CrdtFeed` that owns
the cores is in `feed-crdt.js` (§11); it holds one feed per subscribed wave concurrently.

```js
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const { mergeFeed, buildFeed } = require('hyperwave-engine/lib/feed');
const { signJoin } = require('hyperwave-engine/lib/attest');

// a wave-entry op self-authenticates via its join attestation (an unsigned/invalid one, or one
// whose serialized payload exceeds the byte cap, is silently dropped by mergeFeed)
const kp = crypto.keyPair();
const peerId = b4a.toString(kp.publicKey, 'hex');
const waveId = 'w1';
const writerKey = 'ab12…'; // this peer's feed core key (hex)
const op = {
  type: 'wave-entry',
  waveId,
  peerId,
  hopCount: 0, // rank in the sweep → feed order
  writerKey,
  joinSig: signJoin(kp, { waveId, writerKey }),
  payload: { anything: 'the host owns this shape' }, // opaque to the engine
  timestamp: Date.now()
};

// fold the bag of ops collected from every participant's core → the ordered feed
mergeFeed([op]); // → [op] (one entry per peer, hop order; tip address kept only if a burn backs it)

// buildFeed(entries) is the same ordering/dedup once you already have gated entries
buildFeed([op]); // → [op]
```

---

## 9. Payments — `wallet.js`

`createPayments` is the self-custodial WDK wallet (Tron Nile testnet). It's `async` because WDK is
ESM-only. The same module composes it into the wave (fee burns + the paid-wave gate).

```js
const { createPayments } = require('hyperwave-engine');

const pay = await createPayments({
  storageDir: '/tmp/hw/a' /*, seed: '<mnemonic>' */
});
console.log(pay.address); // T… (derived offline from the seed at <storage>/wallet.seed)

await pay.balances(); // → { address, trx }  (network call)
await pay.send('T…recipient', 5); // → { hash, fee }  a real testnet transfer
await pay.burn(1, `hyperwave:${'w1'}:${pay.address}`); // → { hash, fee }  send to the black hole + memo
await pay.verifyBurnTx('deadbeef…', {
  waveId: 'w1',
  from: pay.address,
  minTrx: 1
}); // → { ok, reason? }
await pay.transactions(10); // → recent on-chain txs, both directions
pay.dispose();
```

Wire it into a `createWave` instance and run the fee flow:

```js
const {
  createWave,
  FEE_TRX,
  payFee,
  confirmBurn,
  wireWallet
} = require('hyperwave-engine');

const wave = createWave({ storageDir: '/tmp/hw/a', emit() {} });
wireWallet(wave, pay); // sets the wallet address (tips) + the on-chain burn verifier (paid gate)

// start: start → burn the fee → wait for on-chain confirmation → announce the (now-paid) wave
const waveId = wave.startWave();
const { hash, proof } = await payFee({
  wave,
  payments: pay,
  waveId,
  reason: 'kickoff'
}); // FEE_TRX burned + attestation signed
if (await confirmBurn(pay, waveId, hash)) {
  wave.announcePaid(proof); // peers verify this before they'll join
}
```

`FEE_TRX` is the fixed participation fee (1 TRX). `payFee({ wave, payments, waveId, reason })`
burns it and returns `{ hash, proof }`; `confirmBurn(payments, waveId, hash)` polls the chain
until the burn is readable.

> `engine.js` already composes exactly this (`handleStartWave`/`handleJoin`) — read it for the
> reference wiring, including the fail-fast balance checks and the `burn-result` staging.

---

## 10. Seed & bootstrap helpers

```js
const { parseBootstrap, loadOrCreateSwarmSeed } = require('hyperwave-engine');

// "host:port[,host:port…]" → Hyperswarm's bootstrap option (a local DHT); '' → null (public DHT)
parseBootstrap('127.0.0.1:49737'); // → [{ host: '127.0.0.1', port: 49737 }]

// the persisted 32-byte swarm-identity seed → a stable ring seat/id across restarts.
// Creates + writes <storage>/swarm.seed on first run; an injected hex seed is used verbatim.
const seed = loadOrCreateSwarmSeed('/tmp/hw/a'); // Buffer(32)
const crypto = require('hypercore-crypto');
const keyPair = crypto.keyPair(seed); // the same identity every run (see protocol.md §1 (sibling))
```

`createWave` calls `loadOrCreateSwarmSeed` for you; pass `createWave({ swarmSeed })` only to inject
an identity (e.g. from mobile secure storage). It is a **separate** seed from the wallet seed
(`createPayments({ seed })`) — see [`docs/secure-seed-storage.md`](../../../apps/docs/secure-seed-storage.md).

---

## 11. The stateful classes wave.js composes

`createWave` is a composition root: the per-concern state machines live in their own classes,
each subpath-importable and unit-tested. `Flood` is shown in §7; the others:

- **`PeerTable`** (`lib/peer-table.js`) — live peer bookkeeping: ring seats (angle always
  derived from the id, never the wire) and direct-send channels; a direct disconnect drops
  the seat immediately. `bare examples/peer-table.js`
- **`EntryPipeline`** (`lib/entry.js`) — pairs the lobby-staged entry with my sweep slot
  (either order — the renderer can stage before or after my slot fires), posts exactly once
  per wave and only for the current wave, and owns the burn-proof ticket lifetime (survives
  `reset()`, dropped by `clearBurnProof()` on a new wave). `bare examples/entry.js`
- **`CrdtFeed`** (`lib/feed-crdt.js`) — the per-wave multicore CRDT feed over a
  Corestore, holding one feed per subscribed wave concurrently: `open(waveId)` creates MY
  writable core (its key is `writerKeyFor(waveId)`) without closing other waves,
  `addWriter(waveId, peerId, writerKey)` opens a participant's core (from its flooded
  `wave-join`) and downloads its one entry, `postEntry(entry)` appends my single op, `tick()`
  pulls replication + repaints every held wave (`onFeed(waveId, items)`), and
  `closeWave(waveId)` frees one wave's cores (on unsubscribe). No admission, no indexer, no
  retention — every subscribed peer holds every core and merges locally with `mergeFeed` (§8).

---

## 12. `rpc.js` — the host↔UI IPC seam (`bare-rpc`)

`createEngine`'s `exec`/`emit` is a transport-free, in-process contract. When the engine runs in a
separate process from its UI — the desktop **Bare worker** behind Electron, the mobile **worklet**
behind RN — that pipe carries JSON, and request/response commands (`tip` / `send-trx` /
`fetch-transactions`) used to be faked by matching a later result message. `lib/rpc.js` puts
[`bare-rpc`](https://github.com/holepunchto/librpc) over the pipe so replies correlate natively. It's
**internal app IPC**, not the on-wire gossip protocol (that stays JSON-over-Protomux between peers).

```js
const { serveEngine, createRpcClient } = require('hyperwave-engine/lib/rpc');
const { createEngine } = require('hyperwave-engine');

// HOST side (where createEngine runs — the worker / worklet). Two-step wiring breaks the
// emit<->engine cycle: build the seam, create the engine with seam.emit, then attach.
const seam = serveEngine({ stream: framedPipe });
const engine = createEngine({ storageDir, config, emit: seam.emit });
seam.attach(engine);
// A host that can't build its engine until a first message (mobile learns storageDir from `init`)
// passes onBootstrap instead: serveEngine({ stream, onBootstrap: (cmd) => { …createEngine…; attach } })

// UI side (Electron main / RN JS). `call` awaits request/response, fire-and-forget otherwise.
const client = createRpcClient({
  stream: framedPipe,
  onEvent: (msg) => render(msg)
});
client.call('start-wave'); // fire-and-forget
const result = await client.call('tip', { to: 'T…', amount: 5 }); // resolves with tip-result
```

`REQUEST_REPLY` (a `Set`) is the single source of truth for which commands await a reply — both ends
import it, so they can't disagree. Notifications ride bare-rpc's one-way `event` primitive (no reply
lifecycle, so a high-frequency `position` stream can't leak request state). A request/response reply
is **also** delivered through `onEvent`, so an event-oriented UI (`ipc.on('tip-result', …)`) needs no
change. **Desktop is a main-split**: the renderer is bundler-free and can't load bare-rpc, so the
worker speaks the seam to Electron **main**, which runs the client and re-exposes it to the renderer
over Electron's own `invoke`/event IPC (`apps/desktop/electron/main.js`). **Mobile** runs it
end-to-end (`apps/mobile/src/useEngine.js` ↔ `worklet/app.js`). See `lib/rpc.test.js` for the
full-stack contract (concurrent-reply correlation, the FramedStream transport, lazy bootstrap).

---

## Running the examples & tests

```bash
bare bin/wave.run.js A /tmp/hw/a     # a headless wave host (dev CLI)
bare bin/dht-local.js                # a local DHT bootstrap (prints host:port)
npm test                             # unit suites (from repo root; delegates here)
bare lib/sweep.test.js               # a single suite
```
