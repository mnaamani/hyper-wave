# HyperWave docs

- [architecture.md](./architecture.md) — process/layer structure (Electron main ·
  renderer · Bare workers · IPC), the module map, and where logic lives.
- [protocol.md](./protocol.md) — the on-wire protocol & per-peer state machine: identity/
  ring geometry, transport, crypto (receipts + chain accumulator), every gossip message
  type, the token race, the lobby/racing lifecycle, healing, join-time sync, and the
  Autobase gallery + receipt write-gate. Detailed enough to build a compatible client in
  another language.
- [scalable-topology.md](./scalable-topology.md) — **design/plan** (not yet built) for
  scaling to a large global swarm: make the ring drive connections (Chord over Hyperswarm —
  `swarm.peers` discovery + `joinPeer` fingers), keep the wave behind the `successor` seam,
  plus the propagation-time decision (serial token vs deterministic sweep).

App-level run/test instructions live in [`../app/README.md`](../app/README.md).
