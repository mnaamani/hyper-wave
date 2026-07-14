# Examples

Runnable, self-contained examples — one per module. Companion to
[`../usage.md`](../usage.md) (the prose walkthrough). Each file requires the package by name
(`hyperwave-engine/...`), exactly as a consumer would.

Run any of them under **Bare**, from the package root:

```bash
bare examples/ring.js       # seat angles, live ring, successor
bare examples/sweep.js      # the deterministic schedule: roster → angle-ordered slots, my slot
bare examples/attest.js     # burn + join attestations (the paid gate + gallery write credential)
bare examples/flood.js      # first-sight gossip dedup
bare examples/pins.js       # sticky random-K pin selection (the flood-graph floor)
bare examples/peer-table.js # live peer bookkeeping: seats, channels, pin diffs, churn cooldowns
bare examples/selfie.js     # the selfie pipeline: stage + sweep-slot pairing, once-per-wave, burn ticket
bare examples/gallery.js    # the pure CRDT merge (mergeGallery): fold participant ops → ordered gallery
bare examples/seeds.js      # parseBootstrap + persistent swarm identity seed
bare examples/payments.js   # WDK wallet: derive address (offline) + balance (network)
bare examples/engine.js     # host the whole engine via createEngine() (wallet-less), then close
bare examples/wave.js       # the lower-level createWave() transport, then close
```

The pure-module examples (`ring`, `sweep`, `attest`, `flood`, `pins`, `peer-table`, `selfie`,
`gallery`, `seeds`) run fully offline and deterministically. `payments.js` derives its address offline but needs network (and a
funded wallet) for a live balance. `engine.js` / `wave.js` join a swarm and then shut themselves
down; pass `HYPERWAVE_BOOTSTRAP=host:port` (see `bare bin/dht-local.js`) for instant local
discovery.
