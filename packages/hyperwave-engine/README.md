# hyperwave-engine

The HyperWave engine: a permissionless P2P "stadium wave" — peers on a Hyperswarm
DHT ring relay a signed token clockwise, post selfies to a shared Autobase gallery,
and pay/tip with self-custodial WDK wallets. Host-agnostic;
runs under [Bare](https://github.com/holepunchto/bare).

```js
const { createEngine } = require('hyperwave-engine');

const engine = createEngine({
  storageDir: '/tmp/hyperwave/a',
  config: { matchId: 'hyperwave:my-match:v1' },
  send: (msg) => console.log(msg) // engine → host events
});

engine.onMessage({ type: 'start-wave' }); // host → engine commands
```

See [`usage.md`](./usage.md) for the full API walkthrough and `examples/` for
runnable samples.

License: Apache-2.0
