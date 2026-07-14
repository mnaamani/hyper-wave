# hyperwave-engine

The HyperWave engine: a permissionless P2P "stadium wave" — peers on a Hyperswarm
DHT ring run a deterministic angular **sweep** (every peer derives the same
angle-ordered schedule from a flooded start time + lap duration and self-triggers
its own moment — no token), post selfies to a per-wave **multicore CRDT** gallery
(one Hypercore per participant, merged locally), and pay/tip with self-custodial WDK
wallets. Host-agnostic; runs under [Bare](https://github.com/holepunchto/bare).

```js
const { createEngine } = require('hyperwave-engine');

const engine = createEngine({
  storageDir: '/tmp/hyperwave/a',
  config: { matchId: 'hyperwave:my-match:v1' },
  notify: (msg) => console.log(msg) // engine → host events
});

engine.exec({ type: 'start-wave' }); // host → engine commands
```

See [`usage.md`](./usage.md) for the full API walkthrough and `examples/` for
runnable samples.

License: Apache-2.0
