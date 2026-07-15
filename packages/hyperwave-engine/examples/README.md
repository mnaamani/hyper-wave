# Examples

Runnable, self-contained examples — one per module. Companion to
[`../docs/usage.md`](../docs/usage.md) (the prose walkthrough). Each file requires the package by name
(`hyperwave-engine/...`), exactly as a consumer would.

Run any of them under **Bare**, from the package root:

```bash
bare examples/ring.js       # seat angles, live ring
bare examples/sweep.js      # the deterministic schedule: roster → angle-ordered slots, my slot
bare examples/attest.js     # burn + join attestations (the paid gate + feed write credential)
bare examples/messages.js   # gossip message factories + receive-edge shape validators
bare examples/flood.js      # first-sight gossip dedup
bare examples/peer-table.js # live peer bookkeeping: seats + direct channels
bare examples/entry.js     # the entry pipeline: stage + sweep-slot pairing, once-per-wave, burn ticket
bare examples/feed.js    # the pure CRDT merge (mergeFeed): fold participant ops → ordered feed
bare examples/seeds.js      # parseBootstrap + persistent swarm identity seed
bare examples/payments.js   # WDK wallet: derive address (offline) + balance (network)
bare examples/engine.js     # host the whole engine via createEngine() (wallet-less), then close
bare examples/wave.js       # the lower-level createWave() transport, then close
```

The pure-module examples (`ring`, `sweep`, `attest`, `messages`, `flood`, `peer-table`, `entry`,
`feed`, `seeds`) run fully offline and deterministically. `payments.js` derives its address offline but needs network (and a
funded wallet) for a live balance. `engine.js` / `wave.js` join a swarm and then shut themselves
down; pass `HYPERWAVE_BOOTSTRAP=host:port` (see `bare bin/dht-local.js`) for instant local
discovery.
