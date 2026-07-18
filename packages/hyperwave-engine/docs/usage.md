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

**Import surfaces.** The engine is **payment-agnostic** and ships **no wallet** — the `Wallet`
interface and the concrete wallets are separate packages you add as needed:

```js
// 1. The engine entry re-exports the host-level building blocks + the wallet-agnostic fee flows
//    (NO Wallet class, NO concrete wallet — those moved to their own packages):
const {
  createEngine,
  createWave,
  parseBootstrap,
  loadOrCreateSwarmSeed,
  payFee,
  confirmBurn,
  wireWallet,
  burnMemo, // the wallet-agnostic fee flows (payments.js)
  serveEngine,
  createRpcClient // the host<->UI IPC seam (rpc.js) — §12
} = require('hyperwave-engine');

// 2. The payment abstraction — its own packages (install only what you use):
const { Wallet } = require('hyperwave-wallet'); // the abstract interface — extend it for a custom wallet
const {
  createPayments, // the default Tron wallet (native TRX)
  createTronUsdtWallet, // the USDT/TRC-20 variant
  FEE_TRX
} = require('hyperwave-wallet-tron');
const { createCashuWallet } = require('hyperwave-wallet-cashu'); // Chaumian ecash (the desktop default)

// 3. The pure submodules are imported by subpath (not re-exported from the index):
const ring = require('hyperwave-engine/lib/ring');
const sweep = require('hyperwave-engine/lib/sweep');
const attest = require('hyperwave-engine/lib/attest');
const messages = require('hyperwave-engine/lib/messages');
const { Flood } = require('hyperwave-engine/lib/flood');
const feed = require('hyperwave-engine/lib/feed');

// 4. The stateful classes wave.js composes (also subpath imports — see §11):
const { PeerTable } = require('hyperwave-engine/lib/peer-table');
const { EntryPipeline } = require('hyperwave-engine/lib/entry');
const { CrdtFeed } = require('hyperwave-engine/lib/feed-crdt');
```

Contents: [Host the engine](#1-host-the-whole-engine-createengine) · [Drive it headless](#2-drive-a-wave-headless-createwave) ·
[ring.js](#3-ringjs--seats--the-ring) · [sweep.js](#4-sweepjs--the-deterministic-schedule) · [attest.js](#5-attestjs--attestations) ·
[messages.js](#6-messagesjs--the-gossip-message-seam) · [flood.js](#7-floodjs--the-flood-graph) · [feed.js](#8-feedjs--the-multicore-crdt-feed) ·
[payments](#9-payments--the-wallet-interface--injected-wallets) · [seeds & bootstrap](#10-seed--bootstrap-helpers) ·
[stateful classes](#11-the-stateful-classes-wavejs-composes) ·
[rpc.js IPC seam](#12-rpcjs--the-hostui-ipc-seam-bare-rpc)

---

## 1. Host the whole engine (`createEngine`)

The host-agnostic entry. Think of it like a kernel: give it a `storageDir`, an optional `config`,
and an `emit` callback (engine → host events); feed it commands via `exec` (host → engine, like a
syscall). This is the entire surface a host (the desktop worker / mobile worklet) needs.

```js
const { createEngine } = require('hyperwave-engine');
const { createCashuWallet } = require('hyperwave-wallet-cashu'); // or hyperwave-wallet-tron

const engine = createEngine({
  storageDir: '/tmp/hyperwave/a', // one dir per peer (the hyperwave/ store is wiped on startup)
  config: {
    topicId: 'hyperwave:my-match:v1', // peers on the same topicId share one ring
    bootstrap: '127.0.0.1:49737', // optional host:port → local DHT (instant same-machine discovery)
    wallet: false, // set false to force wallet-less; else a wallet activates IFF deps.createPayments is given
    autoSubscribe: true // default; false → browse-then-pick (hold cores only for waves you subscribe to)
  },
  // The engine ships NO wallet — inject a payment factory to enable fees/tips (else it runs
  // wallet-less: join-attestation feed, no burns/paid-gate/tips). This is where you pick a mechanism.
  deps: { createPayments: createCashuWallet },
  // Optional: share an existing Hyperswarm the host already owns (a LIVE object, so it rides the
  // top-level option, NOT `config`). When set, the engine joins its topics on that instance and
  // NEVER destroys it (on close it only leaves those topics + detaches its listeners), and
  // config.bootstrap / swarmSeed are ignored. Pass this when the app ALSO uses Hyperswarm — two
  // instances in one process don't reliably discover each other.
  // swarm: myHyperswarm,
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
engine.exec({ type: 'tip', to: '<addr>', amount: 5 }); // pay an entry owner (mechanism-agnostic)
engine.exec({ type: 'dm', waveId, to: '<peerId>', note: {} }); // DIRECTED (private) note to one peer → a `dm` event
engine.exec({ type: 'note', waveId, note: {} }); // FLOODED note to a wave's subscribers → a `note` event
engine.exec({ type: 'send-trx', to: '<addr>', amount: 10 }); // a plain transfer
engine.exec({ type: 'fetch-transactions' }); // → { type:'transactions', list }
engine.exec({ type: 'refresh-wallet' }); // → a fresh { type:'wallet', address, amount, unit }

// Mint-based wallet (Cashu) — currency-agnostic, no-ops/errors on a chain wallet:
engine.exec({
  type: 'set-wallet-options',
  walletOptions: { mint: 'https://…' }
}); // switch mint live
engine.exec({ type: 'fund-wallet', amount: 100 }); // mint funds → { type:'fund-result', invoice?, minted }
engine.exec({ type: 'redeem', token: '<cashuB…>' }); // redeem a received bearer token → { type:'redeem-result' }
// Multi-account wallet (Tron): list-accounts + set-account (see §9).

await engine.close();
```

Command / event reference: `protocol.md` §5; the state-machine `event` names (`started`,
`joined`, `roster`, `holding`, `position`, `completed`, `note`, `dm`, …) in §5 as well.

---

## 2. Drive a wave headless (`createWave`)

`createEngine` wraps `createWave` + the fee flows over an injected wallet. If you want the wave
protocol without any payment layer (tests, a custom host), call `createWave` directly. It builds the
Hyperswarm/Corestore transport and returns the wave controls.

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
  // swarm: myHyperswarm  // optional: share the host's Hyperswarm instead of creating one; the
  //   engine takes its identity from it and NEVER destroys it (it only leaves the topics it
  //   joined on close). Use when the app also runs Hyperswarm — one instance per process.
});

console.log('my seat:', wave.me); // { id, angle, tag }
const waveId = wave.startWave(); // announce + open the lobby; always returns the new waveId
wave.setTag('BR');
wave.stageEntry({ payload: { label: 'me' } }); // opaque payload; posts at my sweep slot
await wave.close();
```

`createWave` returns: `{ me, startWave, subscribe, unsubscribe, join, setTag, stageEntry, note,
dm, setWallet, feeFor, announcePaid, recordBurn, close }`. Concurrent waves are allowed —
`startWave()` never returns null and there is no "busy" guard. `join(waveId?)` /
`stageEntry({payload, waveId?})` default to the newest joinable / joined wave; `subscribe(waveId)` /
`unsubscribe(waveId)` open / close a wave's feed (holding cores only for waves you subscribed to —
see §11 CrdtFeed). `note({waveId, note})` floods an authenticated note to the wave's subscribers;
`dm({waveId, to, note})` unicasts a **directed** note to one peer (private counterpart of `note` —
protocol.md §5). There is no routing surface — the wave is a deterministic sweep. The payment
methods (`setWallet`/`feeFor`/`announcePaid`/`recordBurn`) are driven by the fee flows over an
injected `Wallet` — see §9.

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

**Burn attestation** — bridges a peer's ring identity to its fee burn; authorizes a feed write and
binds the tip address. Mechanism-agnostic: `burnRef` is the burn reference (a chain tx hash, or a
Cashu ecash token) and `payerAddress` the wallet/identity that funded it:

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
  burnRef: 'deadbeef…', // chain tx hash | cashu token
  payerAddress: 'T…', // the wallet/identity that paid
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

The single definition point for the on-wire message kinds (`protocol.md` §5: `heartbeat`, `subs`,
`wave-announce`, `wave-join`, `wave-start`, `wave-sync`, `wave-note` (flooded roster-member
broadcast), `wave-dm` (directed/unicast note to one peer)): one `make*` factory per kind
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

## 9. Payments — the `Wallet` interface + injected wallets

The payment abstraction spans **four packages**: **`hyperwave-wallet`** (the abstract **`Wallet`**
base class — the interface), **`hyperwave-wallet-tron`** (`TronWallet`/`TronUsdtWallet` +
`createPayments`, WDK), **`hyperwave-wallet-cashu`** (`CashuWallet` + `createCashuWallet`, ecash),
and the engine's own **`payments.js`** — the wallet-agnostic fee flows (`payFee`/`confirmBurn`/
`wireWallet`/`burnMemo`) it composes over any wallet.

**The engine ships no wallet** — it talks to payments only through the **`Wallet`** interface: the
members any wallet must implement (`type`, `unit`, `fee`, `address`, `balances`, `send`, `burn`,
`verifyBurnTx`, `transactions`, `dispose`) plus optional ones (`accountIndex`/`accounts(count)`
default to a single account; a mint wallet adds `fund`/`receive`/`consolidate`/`mintUrl`). A host
**injects** a factory returning any `Wallet` subclass — `createEngine({ deps: { createPayments:
createCashuWallet } })` — with none, the engine runs wallet-less. (The desktop default is Cashu.)

**Multiple accounts (one seed, distinct addresses).** `createPayments({ accountIndex })` derives a
distinct BIP-44 address per index (`m/44'/195'/0'/0/i` for Tron) from the same seed. The engine
starts on `config.accountIndex` (default 0), a **`list-accounts`** command emits an `accounts`
message (`{ list: [{index, address}], active }`) so a host can render an account picker, and a
**`set-account`** command switches the active account **live** (re-derives + re-wires the wallet,
same seed → the `wallet` message reports the new `accountIndex` + address). `wallet.accounts(count)`
derives the first `count` addresses offline for the picker.

Each wallet declares a **`type`** (e.g. `'tron-nile'`) that travels on the wire (wave-announce/
start/sync), so a joiner only joins a wave whose payment mechanism its own wallet supports (§ the
`walletType` gate in `protocol.md` §9). The `fee` is the wallet's own participation-fee amount.
The **`TronWallet` type is network-derived** — `tron-<network>` (`tron-nile`, `tron-mainnet`, …) —
so testnet and mainnet are automatically distinct mechanisms and their waves never mix.

```js
const { Wallet } = require('hyperwave-wallet'); // the base class to extend for a custom wallet

class MyWallet extends Wallet {
  get type() {
    return 'my-chain'; // rides the wire; a peer only joins a wave whose type it supports
  }
  get unit() {
    return 'COIN'; // currency label for host-side amount formatting
  }
  get fee() {
    return 5;
  }
  get address() {
    return this._addr;
  }
  async balances() {
    return {
      address: this._addr,
      amount: await this._fetchBalance(),
      unit: this.unit
    };
  }
  async send(to, amount) {
    /* … → { hash, fee? } */
  }
  async burn(amount, memo) {
    /* … → { hash, fee? } (irrecoverable, memo binds waveId|peerId) */
  }
  async verifyBurnTx(burnRef, expect) {
    /* expect = { waveId?, from?, minAmount? } → { ok, reason? } (fail closed) */
  }
  async transactions(limit) {
    /* … newest first, [] on error */
  }
}
// inject it: createEngine({ ..., deps: { createPayments: async (opts) => new MyWallet(opts) } })
```

**Bundled alternative — `TronUsdtWallet` (USDT / TRC-20).** A second Tron wallet that pays in USDT
instead of native TRX, **extending `TronWallet`** (it reuses the shared WDK account + address +
dispose and overrides the currency ops to move USDT via the token contract). Its `type` is
`tron-usdt-<network>` (e.g. `'tron-usdt-nile'`) — a **distinct** payment mechanism, so a USDT wave
and a TRX wave don't mix (a TRX-wallet peer can't join a USDT wave, and vice versa). An app opts in
by injecting it:

```js
const { createTronUsdtWallet } = require('hyperwave-wallet-tron');

createEngine({
  storageDir,
  config,
  emit,
  deps: {
    createPayments: (opts) =>
      createTronUsdtWallet({ ...opts, usdtContract: 'T…NileUSDT' })
  }
});
```

Two caveats: USDT is a TRC-20 **token, so a transfer costs TRX for gas** — the wallet holds both
(one seed / one address funds TRX for gas + USDT for fees); and the on-chain TRC-20 ops are
**pending Nile verification** (like the native path, de-risked by the on-chain tier, not offline
tests). Supply the real Nile USDT `usdtContract` (there is no safe default).

The default `TronWallet` (via `createPayments`, from `hyperwave-wallet-tron`):

```js
const { createPayments } = require('hyperwave-wallet-tron');

const pay = await createPayments({
  storageDir: '/tmp/hw/a' /*, seed: '<mnemonic>' */
});
console.log(pay.address); // T… (derived offline from the seed at <storage>/wallet.seed)

await pay.balances(); // → { address, amount, unit: 'TRX' }  (network call)
await pay.send('T…recipient', 5); // → { hash, fee }  a real testnet transfer
await pay.burn(1, `hyperwave:${'w1'}:${pay.address}`); // → { hash, fee }  send to the black hole + memo
await pay.verifyBurnTx('deadbeef…', {
  waveId: 'w1',
  from: pay.address,
  minAmount: 1
}); // → { ok, reason? }
await pay.transactions(10); // → recent on-chain txs, both directions
pay.dispose();
```

**Cashu ecash (the desktop default)** — from `hyperwave-wallet-cashu`. Chaumian ecash on a
Lightning mint: burns lock ecash to a NUMS pubkey (the black-hole analog), tips are bearer tokens.
It's **stateful** (proofs held locally) so it must be **funded** before it can burn/tip, and the
`walletType` is the generic `'cashu'` (any mint interoperates):

```js
const { createCashuWallet } = require('hyperwave-wallet-cashu');

const pay = await createCashuWallet({
  storageDir: '/tmp/hw/a',
  mint: 'https://testnut.cashu.space' // else the default test mint
});
console.log(pay.type, pay.unit); // 'cashu' 'sat'
await pay.fund(100, { onInvoice: (bolt11) => showQr(bolt11) }); // mint quote → mint into the store
await pay.balances(); // → { address, amount, unit: 'sat' } (local proof total at the active mint)
await pay.burn(2, `hyperwave:${'w1'}:${pay.address}`); // lock ecash to the NUMS key + memo → { hash: token }
await pay.verifyBurnTx('<cashuB…>', { waveId: 'w1', minAmount: 2 }); // decode + NUT-07 checkstate → { ok }
const { hash: token } = await pay.send('<recipientPubkey>', 5); // P2PK-locked bearer token (deliver via `dm`)
await pay.receive(token); // redeem a received tip (unlock P2PK into the store)
```

**Selecting the network (testnet → mainnet).** The same `TronWallet`/`TronUsdtWallet` implementation
serves every Tron network — pass `network` (default `'nile'`; `'mainnet'`, `'shasta'`, or any name +
an explicit `provider` for a custom node). The network selects both the RPC endpoint **and** the
wire `type`, so mainnet peers (`tron-mainnet`) and testnet peers (`tron-nile`) can't join each
other's waves. **Mainnet is opt-in** — the default is the testnet, so nothing spends real funds by
accident. A host reaches it through `config.walletOptions` (forwarded verbatim to the payments
factory), no custom wallet needed:

```js
createEngine({
  storageDir,
  emit,
  config: { walletOptions: { network: 'mainnet' } } // real funds — opt-in
});
// USDT on mainnet: { walletOptions: { network: 'mainnet', usdtContract: 'T…MainnetUSDT' } }
// (the mainnet USDT contract differs from Nile's — pass the matching address)
```

Or directly: `createPayments({ storageDir, network: 'mainnet' })` /
`createTronUsdtWallet({ storageDir, network: 'mainnet', usdtContract })`. The headless CLI
(`bin/wave.run.js`) takes `TRON_NETWORK` + optional `TRON_PROVIDER` env vars.

**Fee.** The participation fee is a **`fee`** option on the wallet (default 1 TRX / 1 USDT) — set it
per deployment (e.g. a smaller mainnet fee, since 1 TRX ≠ 1 USDT in value):
`createPayments({ storageDir, fee: 0.5 })`, or via `config.walletOptions.fee` / the CLI's
`WALLET_FEE`. It must be a positive number (a burn is a real transfer — Tron rejects zero-amount).

**The initiator sets its wave's fee.** A wallet's `fee` is the amount its owner charges on the waves
**it initiates** — that fee rides `wave-announce`/`wave-start`/`wave-sync` (envelope-signed), and
**every joiner burns exactly that** (not each their own wallet fee), so a wave has one agreed fee.
A verifier gates the initiator's start burn against the announced fee on-chain. To defend against an
initiator advertising a near-zero fee (cheap sybil joins), each peer sets a **local floor**
`config.minFee` (default 0 = accept any): it refuses to engage or join a wave whose announced fee is
below it. Only enforced when a wallet is present.

Wire it into a `createWave` instance and run the fee flow:

```js
const {
  createWave,
  payFee,
  confirmBurn,
  wireWallet
} = require('hyperwave-engine');
const { FEE_TRX } = require('hyperwave-wallet-tron');

const wave = createWave({ storageDir: '/tmp/hw/a', emit() {} });
wireWallet(wave, pay); // sets the wallet address (tips) + the on-chain burn verifier (paid gate)

// start: start → burn the fee → wait for on-chain confirmation → announce the (now-paid) wave
const waveId = wave.startWave();
const { hash, proof } = await payFee({
  wave,
  payments: pay,
  waveId,
  reason: 'start' // 'start' (initiator) | 'join' (participant) — the start gate requires 'start'
}); // the fee burned + attestation signed
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
bare bin/wave.run.js A /tmp/hw/a     # a headless wave host (dev CLI; WALLET_TYPE=cashu|usdt selects a wallet)
bare bin/dht-local.js                # a local DHT bootstrap (prints host:port)
npm test                             # from repo root: runs every package (engine + the wallet packages)
bare lib/sweep.test.js               # a single engine suite (from packages/hyperwave-engine)
```
