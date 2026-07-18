# HyperWave docs — map

Docs live next to what they describe. This is the index.

## Engine (`packages/hyperwave-engine/docs/`)

The reusable, theme-agnostic P2P engine.

- [protocol.md](../packages/hyperwave-engine/docs/protocol.md) — the on-wire protocol &
  per-peer state machine: identity/ring geometry, transport, crypto (join / burn
  attestations), message propagation (flooding / heartbeat), every message type (six
  kinds — heartbeat, subs, wave-announce, wave-join, wave-start, wave-sync), the paid lobby,
  the **deterministic sweep** (schedule derivation, self-trigger, deterministic end),
  the subscription layer + scoped gossip, join-time sync, the multicore CRDT **feed** + write gates, and
  **participation fees — burning & verification**. Detailed enough to build a compatible
  client in another language.
- [usage.md](../packages/hyperwave-engine/docs/usage.md) — the API walkthrough: `createEngine`
  / `createWave`, the command + event surface, and every pure submodule with runnable snippets.
- [scaling.md](../packages/hyperwave-engine/docs/scaling.md) — **Phases 1–3 built**: scaling to
  thousands of peers via **concurrent waves** as a sharding model — the multiplexed wave FSM, the
  subscription layer (O(subscribed) core budget), and scoped gossip with per-wave sub-topics. Covers
  what breaks in a single wave (the feed's O(N)-cores wall); **Phase 4 (a discovery directory at
  scale) is still proposed**. Revisits several baked-in assumptions.

## Wallets (`packages/hyperwave-wallet-*/`)

The payment abstraction, split from the engine so it (and its consumers) carry no
payment deps. A host injects a concrete wallet via
`createEngine({ deps: { createPayments } })`.

- **`hyperwave-wallet`** — the abstract `Wallet` base class (the pluggable payment
  interface a concrete wallet implements and the engine composes over). No deps.
- **`hyperwave-wallet-cashu`** — Chaumian ecash on a Lightning mint (the desktop
  default). See [cashu.md](../apps/docs/cashu.md).
- **`hyperwave-wallet-tron`** — WDK self-custodial Tron: native TRX + TRC-20 USDT.

## Apps (`apps/docs/`)

The "stadium Mexican wave" product and how the two hosts wrap the engine.

- [idea.md](../apps/docs/idea.md) — **the idea, in plain language** (read first). What
  HyperWave (the product) is, how a wave works, the money model (burned fees + tips), why
  P2P, and the limitations — non-technical.
- [hosting.md](../apps/docs/hosting.md) — the app-hosting architecture: the desktop Electron
  three-process split (main · renderer · Bare worker), the mobile bare-kit worklet, the
  renderer↔worker IPC seam, the module map, and where logic lives. (Formerly `architecture.md`.)
- [cashu.md](../apps/docs/cashu.md) — the **Cashu (ecash) payment mechanism**, the desktop
  default: NUMS-pubkey burns, mint-signed memos, per-peer mint choice, redeemable multimint
  tips, funding, and the (custodial) trust model. The protocol is unchanged (see protocol.md §9).
- [secure-seed-storage.md](../apps/docs/secure-seed-storage.md) — design for moving desktop
  secret storage (wallet + swarm seeds) to the OS keychain (planned, not built).

## Project (`docs/`)

- [research.md](./research.md) — the papers, protocols, and projects HyperWave draws on
  (Chord, epidemic gossip, Kademlia, CRDTs, the Holepunch stack, WDK, proof-of-burn, …)
  and what each contributed.
- [cashu-integration-plan.md](./cashu-integration-plan.md) — the plan (and progress) for
  adding Cashu as the desktop's default payment mechanism: the currency-agnostic rename, the
  `CashuWallet`, tips + multimint, the desktop wiring, and what remains.

Project overview, quickstart, and the local demo walkthrough: [`../README.md`](../README.md).
Desktop app shell: [`../apps/desktop/README.md`](../apps/desktop/README.md). Mobile host:
[`../apps/mobile/README.md`](../apps/mobile/README.md).
