# HyperWave docs

- [idea.md](./idea.md) — **the idea, in plain language** (read first). What HyperWave is,
  how a wave works, the money model (burned fees + tips), why P2P, and
  the limitations — non-technical, describes the system as built.
- [protocol.md](./protocol.md) — the on-wire protocol & per-peer state machine: identity/
  ring geometry, transport, crypto (join / burn attestations), message
  propagation (flooding / heartbeat), every message type (five kinds), the paid lobby,
  the **deterministic sweep** (schedule derivation, self-trigger, deterministic end),
  join-time sync, the multicore CRDT gallery + write gates, and **participation fees —
  burning & verification** (§9). The money model is burned fees + gallery tips; there are
  no sponsor rewards. Detailed enough to build a compatible client in another language.
- [architecture.md](./architecture.md) — process/layer structure (Electron main ·
  renderer · Bare workers · IPC), why there are no peer roles (every peer is equal),
  the module map, and where logic lives.
- [research.md](./research.md) — the papers, protocols, and projects HyperWave draws on
  (Chord, epidemic gossip, Kademlia, the Holepunch stack, WDK, proof-of-burn, …)
  and what each contributed.
- [secure-seed-storage.md](./secure-seed-storage.md) — design for moving desktop
  secret storage (wallet + swarm seeds) to the OS keychain (planned, not built).

Project overview, quickstart, and the local demo walkthrough: [`../README.md`](../README.md).
Desktop app shell: [`../apps/desktop/README.md`](../apps/desktop/README.md). Mobile host:
[`../apps/mobile/README.md`](../apps/mobile/README.md).
