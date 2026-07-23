# hyperwave-engine

A permissionless P2P **coordinated-round** primitive. Peers join a shared **topic** and
map to seats on a Hyperswarm DHT **ring** (angle from the public key). Any peer triggers a
**wave** that **sweeps** the ring on a deterministic schedule — every peer derives the same
angle-ordered slots from a flooded start time + lap duration and self-triggers its own
moment (no token, no coordinator). Each participant contributes one **entry** — an opaque
`payload` the host owns — to a per-wave **multicore CRDT feed** (one Hypercore per
participant, merged locally, byte-identical on every peer), optionally gated by
proof-of-burn, and carries a cosmetic **tag**. Host-agnostic; runs under
[Bare](https://github.com/holepunchto/bare).

**Payments are pluggable** — the engine ships no wallet and is indifferent to the payment
mechanism. It talks to money only through the abstract `Wallet` interface
([`hyperwave-wallet`](https://www.npmjs.com/package/hyperwave-wallet)) and owns just the
wallet-agnostic fee flows (`payments.js`): a burned participation fee and peer-to-peer tips,
in the wallet's own units. A host injects a concrete wallet factory via
`createEngine({ deps: { createPayments } })`; any `Wallet` implementation works — on-chain,
ecash, custodial, or a mock. With no wallet injected the engine runs unpaid (fees/tips are
skipped).

Existing `Wallet` implementations you can inject:
[`hyperwave-wallet-cashu`](https://www.npmjs.com/package/hyperwave-wallet-cashu) and
[`hyperwave-wallet-tron`](https://www.npmjs.com/package/hyperwave-wallet-tron).

The engine is **theme-agnostic** — it never interprets the entry payload. The "wave of
moments" desktop/mobile app is one host: it fills each entry with a moment (a webcam photo)
and uses the tag as a country. Any turn-taking / coordinated-snapshot app can host it the
same way.

```js
const { createEngine } = require('hyperwave-engine');

const engine = createEngine({
  storageDir: '/tmp/hyperwave/a',
  config: { topicId: 'my-topic:v1' },
  emit: (msg) => console.log(msg) // engine → host events
});

engine.exec({ type: 'start-wave' }); // host → engine commands
engine.exec({ type: 'stage-entry', entry: { payload: { any: 'json' } } });
```

See [`docs/usage.md`](./docs/usage.md) for the full API walkthrough,
[`docs/protocol.md`](./docs/protocol.md) for the on-wire spec, and `examples/` for
runnable samples.

License: Apache-2.0
