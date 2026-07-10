# Examples

Runnable, self-contained examples — one per module. Companion to
[`../usage.md`](../usage.md) (the prose walkthrough). Each file requires the package by name
(`hyperwave-engine/...`), exactly as a consumer would.

Run any of them under **Bare**, from the package root:

```bash
bare examples/ring.js       # seat angles, live ring, successor, healing
bare examples/chord.js      # successor-list, fingers, pinTargets, distributed findSuccessor
bare examples/token.js      # receipt chain + burn / gallery-key / wave-end attestations
bare examples/flood.js      # first-sight gossip dedup
bare examples/peer-table.js # live peer bookkeeping: seats, channels, pin diffs, churn cooldowns
bare examples/selfie.js     # the selfie pipeline: stage + receipt pairing, once-per-wave, burn ticket
bare examples/gallery.js    # a real Autobase: append receipt-valid selfies + read them ordered
bare examples/gallery-session.js # per-wave gallery lifecycle: open/retain (archivist) + post
bare examples/seeds.js      # parseBootstrap + persistent swarm identity seed
bare examples/payments.js   # WDK wallet: derive address (offline) + balance (network)
bare examples/engine.js     # host the whole engine via createEngine() (wallet-less), then close
bare examples/wave.js       # the lower-level createWave() transport, then close
```

The pure-module examples (`ring`, `chord`, `token`, `flood`, `peer-table`, `selfie`,
`gallery`, `gallery-session`, `seeds`) run fully offline and deterministically. `payments.js` derives its address offline but needs network (and a
funded wallet) for a live balance. `engine.js` / `wave.js` join a swarm and then shut themselves
down; pass `HYPERWAVE_BOOTSTRAP=host:port` (see `bare bin/dht-local.js`) for instant local
discovery.
