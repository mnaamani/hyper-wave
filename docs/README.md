# HyperWave docs

- [architecture.md](./architecture.md) — process/layer structure (Electron main ·
  renderer · Bare workers · IPC), why there are no peer roles (every peer is equal; the
  only asymmetry is the per-wave initiator), the module map, and where logic lives.
- [protocol.md](./protocol.md) — the on-wire protocol & per-peer state machine: identity/
  ring geometry, transport, crypto (receipts + chain accumulator), message propagation
  (flooding / pointer gossip), every message type, the token race, the paid lobby/racing
  lifecycle, healing, join-time sync, the Autobase gallery + write gates, and **participation
  fees — burning & verification** (§9). The money model is burned fees + gallery tips; there
  are no sponsor rewards. Detailed enough to build a compatible client in another language.
- [scalable-topology.md](./scalable-topology.md) — Chord over Hyperswarm: make the ring
  drive connections. **Phases 1–4 implemented** (DHT discovery, `joinPeer` pinning of
  successor-list/predecessor/fingers, stabilize + churn, slim gossip) plus control-plane
  flooding and distributed `findSuccessor` routing; §8 tracks what remains (notably the
  deterministic-sweep decision for propagation at extreme N).
- [final-idea.md](./final-idea.md) — **the authoritative design doc** (read first). The
  original HyperWave vision + the settled refinements; §11 is the desktop-Electron MVP
  decision. Note: it still describes the original interlocked-reward model, superseded by the
  fees+tips money model (see the current-state summary in `CLAUDE.md`).
- [raffle.md](./raffle.md) — the per-wave initiator-funded raffle: internal commit-reveal
  fairness, the draw + on-chain-verified payout, and the production hardening still open
  (separate admitter from prize-holder; VDF/threshold against last-revealer abort).

App-level run/test instructions: [`../apps/desktop/README.md`](../apps/desktop/README.md).
Local demo walkthrough: [`../DEMO.md`](../DEMO.md).
