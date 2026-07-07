# HyperWave docs

- [idea.md](./idea.md) — **the idea, in plain language** (read first). What HyperWave is,
  how a wave works, the money model (burned fees + tips + optional raffle), why P2P, and
  the honest limitations — non-technical, describes the system as built.
- [hyperwave-whitepaper.pdf](./hyperwave-whitepaper.pdf) — a two-page, scientific-style
  summary of the protocol (ring, token race + receipt accumulator, gallery, burn/tip/raffle
  economics, scaling + adversarial notes). Source: `whitepaper.html`, rendered via headless
  Chromium (`--headless --print-to-pdf`).
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
- [raffle.md](./raffle.md) — the per-wave initiator-funded raffle: internal commit-reveal
  fairness, the draw + on-chain-verified payout, and the production hardening still open
  (separate admitter from prize-holder; VDF/threshold against last-revealer abort).
- [architecture.md](./architecture.md) — process/layer structure (Electron main ·
  renderer · Bare workers · IPC), why there are no peer roles (every peer is equal; the
  only asymmetry is the per-wave initiator), the module map, and where logic lives.
- [research.md](./research.md) — the papers, protocols, and projects HyperWave draws on
  (Chord, epidemic gossip, Kademlia, the Holepunch stack, WDK, proof-of-burn,
  commit-reveal randomness, …) and what each contributed.
- [future-work.md](./future-work.md) — what else the substrate is good for: the general
  properties of the wave-over-Chord-over-Hyperswarm stack, candidate applications with
  real value (paid-postage messaging, rendezvous KV, auditable rotation/draw primitives,
  presence, pub/sub), and an honest read of the prior attempts' graveyard.

Project overview, quickstart, and the local demo walkthrough: [`../README.md`](../README.md).
Desktop app shell: [`../apps/desktop/README.md`](../apps/desktop/README.md). Mobile host:
[`../apps/mobile/README.md`](../apps/mobile/README.md).
