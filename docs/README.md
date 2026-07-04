# HyperWave docs

- [architecture.md](./architecture.md) — process/layer structure (Electron main ·
  renderer · Bare workers · IPC), roles (peer vs validator/seed), the module map, and
  where logic lives.
- [protocol.md](./protocol.md) — the on-wire protocol & per-peer state machine: identity/
  ring geometry, transport, crypto (receipts + chain accumulator), message propagation
  (flooding / pointer gossip), every message type, the token race, the paid lobby/racing
  lifecycle, healing, join-time sync, the Autobase gallery + write gates, **participation
  fees — burning & verification** (§9), and the interlocked payout (§8.5). Detailed enough
  to build a compatible client in another language.
- [scalable-topology.md](./scalable-topology.md) — Chord over Hyperswarm: make the ring
  drive connections. **Phases 1–4 implemented** (DHT discovery, `joinPeer` pinning of
  successor-list/predecessor/fingers, stabilize + churn, slim gossip) plus control-plane
  flooding and distributed `findSuccessor` routing; §8 tracks what remains (notably the
  deterministic-sweep decision for propagation at extreme N).

App-level run/test instructions: [`../app/README.md`](../app/README.md).
Local demo walkthrough: [`../DEMO.md`](../DEMO.md).
