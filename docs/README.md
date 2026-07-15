# HyperWave docs — map

Docs live next to what they describe. This is the index.

## Engine (`packages/hyperwave-engine/docs/`)

The reusable, theme-agnostic P2P engine.

- [protocol.md](../packages/hyperwave-engine/docs/protocol.md) — the on-wire protocol &
  per-peer state machine: identity/ring geometry, transport, crypto (join / burn
  attestations), message propagation (flooding / heartbeat), every message type (five
  kinds), the paid lobby, the **deterministic sweep** (schedule derivation, self-trigger,
  deterministic end), join-time sync, the multicore CRDT **feed** + write gates, and
  **participation fees — burning & verification**. Detailed enough to build a compatible
  client in another language.
- [usage.md](../packages/hyperwave-engine/docs/usage.md) — the API walkthrough: `createEngine`
  / `createWave`, the command + event surface, and every pure submodule with runnable snippets.

## Apps (`apps/docs/`)

The "stadium Mexican wave" product and how the two hosts wrap the engine.

- [idea.md](../apps/docs/idea.md) — **the idea, in plain language** (read first). What
  HyperWave (the product) is, how a wave works, the money model (burned fees + tips), why
  P2P, and the limitations — non-technical.
- [hosting.md](../apps/docs/hosting.md) — the app-hosting architecture: the desktop Electron
  three-process split (main · renderer · Bare worker), the mobile bare-kit worklet, the
  renderer↔worker IPC seam, the module map, and where logic lives. (Formerly `architecture.md`.)
- [secure-seed-storage.md](../apps/docs/secure-seed-storage.md) — design for moving desktop
  secret storage (wallet + swarm seeds) to the OS keychain (planned, not built).

## Project (`docs/`)

- [research.md](./research.md) — the papers, protocols, and projects HyperWave draws on
  (Chord, epidemic gossip, Kademlia, CRDTs, the Holepunch stack, WDK, proof-of-burn, …)
  and what each contributed.

Project overview, quickstart, and the local demo walkthrough: [`../README.md`](../README.md).
Desktop app shell: [`../apps/desktop/README.md`](../apps/desktop/README.md). Mobile host:
[`../apps/mobile/README.md`](../apps/mobile/README.md).
