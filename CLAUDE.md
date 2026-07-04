# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current State

Scaffolding underway. `app/` is the Electron MVP (forked from hello-pear-electron). Build-order Steps 1–4 done: discovery, **presence/ring-update gossip** (Protomux channel), live sorted ring + **successor**, the **token race** (constant-size blake2b chain accumulator, Ed25519 receipts, originator completes the lap), and the **Autobase selfie gallery** — the originator creates a **per-wave** Autobase (namespace `wave-gallery:<waveId>`; key shared via gossip + token), peers request writer admission (`add-writer` = anti-spam gate) and `postSelfie()` a `wave-selfie` entry (inline JPEG thumbnail), all converging on one ordered gallery. Because the namespace is keyed by the random `waveId`, each wave/run starts empty (no stale selfies). The whole `storageDir/hyperwave` store is **wiped on startup** (galleries are ephemeral per-run — nothing there persists across runs), so disk doesn't accumulate; a persistent "past waves" browser is a future option. **Wave lifecycle (idle → lobby → racing → idle):** "kick off" **announces** a wave and opens a **lobby** (default 15s, `wave-announce`) so peers **opt in** (`wave-join`); the initiator then broadcasts `wave-start` (with the roster) and the token races. Exactly one wave at a time (anyone can start when idle; simultaneous starts resolve by lower-`waveId`-wins). **Everyone relays the ball (full-ring visual), but only opted-in roster members get the selfie proof-window** (`holding.canSelfie`); non-joiners just pass it on. Originator broadcasts `wave-end` on completion so all peers finish together; a timeout falls back to idle. **Join-time sync:** existing peers push a `wave-sync` (phase/roster/gallery key/lobby-time-left) to any newcomer on connect, so a peer joining mid-lobby/mid-race gets the right UI (join or spectate) and can't start a competing wave (broadcasts they missed wouldn't reach them). **Healing:** forward to the next *reachable* peer clockwise; if the wave doesn't advance past my hop within `HEAL_TIMEOUT_MS` (the successor's `wave-pos` = ACK), skip that peer and re-forward. `seen` cleared per wave; `endedWaves` prevents reviving a finished wave. Renderer: ring, a **⚽ football token that rolls clockwise around the ring on every screen** (each holder broadcasts `wave-pos`; all renderers animate the ball → `position` event), Kick-off button, webcam **proof-window** modal, and the gallery played **one selfie at a time in the ring centre** (newest arrival features as the wave passes, auto-cycles when idle). **WDK payment layer (in progress):** `workers/lib/pay.js` = self-custodial Tron (Nile testnet) wallet — WDK is ESM-only so this CJS module bridges via dynamic `import()`; real transfers confirmed on-chain under Bare. **MVP payment currency = native TRX** (dropped TRC-20 USDT: no token contract, and a TRX transfer pays its own tiny fee from the same balance, so a wallet that received TRX can immediately send). Done: step 2 wallets (worker emits `wallet` {address,trx} IPC → renderer 💰 chip), step 3 gallery tipping (`wave-selfie` carries poster `address`; 💵 Tip button → `tip` IPC → `pay.send` → `tip-result` toast), step 4 `wave-proof` receipt collection (every holder pushes its hop receipt to connected validators; `wave.chainProofs(waveId)` = the ordered chain), and the **initiator kick-off burn** (1 TRX to Tron's black hole `T9yD14…UZBjK` on start-wave, fire-and-forget, `burn-result` toast — zero-amount transfers are rejected by Tron, so a burn is a real small transfer to the unspendable all-zero address). Next: join bond → interlocked payout. Wallets must be **faucet-funded** (nileex gives TRX) to send. `spike/wdk/` + `spike/multiwriter/` = local de-risking spikes (gitignored). Design docs in `ideas/`.

**Everything runs under Bare** (the worker's real runtime), not Node — Node is only Electron's main process. Tests use **brittle** (Holepunch TAP framework), run under Bare: **`cd app && npm test`** = `bare test.js`, which requires each suite (`workers/lib/*.test.js`) so brittle aggregates them (TAP, non-zero on failure). Add a new suite to `test.js` to include it; run one with `bare workers/lib/<name>.test.js`. Suites: `wave.logic` (ring/successor/pickReachable), `wave.token` (receipts/accumulator/tamper), `wave.gallery` (ordering), `wave.autobase` (real Autobase apply/view + receipt write-gate), `chord` (Chord math + distributed findSuccessor routing sim), `flood` (partial-topology flood-reach harness), `gallery.replication` (transitive replication + seed persistence over a line, no swarm). A **validator/seed** (`role: 'validator'`, or `HYPERWAVE_ROLE=validator` for `wave.run.js`) retains every gallery + is pinned as a well-connected hub, so galleries survive peers leaving; it never selfies or starts waves. Networked end-to-end: `HYPERWAVE_MATCH=test-$RANDOM HYPERWAVE_LOBBY_MS=4000 START=1 AUTOJOIN=1 AUTOSELFIE=1 bare workers/lib/wave.run.js A /tmp/hw/a` + a B → both reach `GALLERY size=2` (public DHT ~30-90s; or `bare workers/lib/bootstrap.js` + `HYPERWAVE_BOOTSTRAP=host:port` for instant local discovery). `cd app && npm run format` / `npm run lint` for prettier+lunte. Bare specifics: `bare-fs`, `bare-env` for env vars, `Bare.argv`/`Bare.exit`, global timers.

**Module format:** Bare workers (`workers/`) are **CJS** (`require`/`module.exports`) — idiomatic for Bare/the template, and the worker entry is loaded by `PearRuntime.run`. The **renderer** (`renderer/`) is **ESM** (`import`/`export`, works over `file://`). This mix is intentional; Bare *can* run ESM (`.mjs`), but converting the workers is all-or-nothing across the require/import boundary (`require()` of ESM throws) and the ESM worker-entry boot under pear-runtime is unverified — so we keep workers CJS.

- `app/` — the desktop MVP. See `app/README.md` for architecture and run commands. Engine is split by domain under `app/workers/lib/`: `ring.js` (pure ring geometry — angle from id, successor), `token.js` (pure token crypto — receipts + blake2b accumulator), `gallery.js` (Autobase gallery config + ordering), and `wave.js` (the `createWave` orchestrator that wires Hyperswarm/Protomux transport to those three; the payment layer attaches here as its own module). `app/workers/hyperwave.js` (Bare worker ↔ IPC bridge), `app/renderer/app.js` (ring UI, proof-window webcam, gallery). `app/electron/main.js` is the template plus one line: a `setPermissionRequestHandler` allowing `media` for the webcam. Note: ring angle is always derived locally from a peer's id (`angleOfId`), never trusted from gossip.
- `spike/multiwriter/` — standalone proof that Hyperswarm discovery + Autobase multi-writer converge across separate `--storage` dirs.
- `TODO.md` — the refinement backlog (done + prioritized remaining work). Check/update it when picking up or finishing work.
- `docs/` — `architecture.md` (process/layer structure + module map + where logic lives), `protocol.md` (on-wire protocol & state machine, spec-level: messages, crypto, lifecycle, gallery), and `scalable-topology.md` (**planned major work**: Chord over Hyperswarm — make the ring drive connections via `swarm.peers` + `joinPeer`, entirely behind the `ring.js` successor seam). Keep these in sync when the protocol or structure changes.

Note: the gallery write gate is **enforced** — `apply()` (in `gallery.js`) appends a `wave-selfie` only if its `receiptSig` verifies (Ed25519) by `peerId` over `(waveId, hopCount, chainHash, receiptTs)`, and admission (`add-writer`) is gated on the same receipt for the current wave. This is *authenticity* (no unsigned/impersonated entries), not proof-of-participation — a peer can still self-sign a receipt for a hop it didn't hold; the validator will cross-check the real token chain in the payment layer.

**Run the app:** `cd app && npm install && npm start -- --storage /tmp/hyperwave/one` (one `--storage` dir per instance; open several). **Headless engine test:** `cd app && bare workers/lib/wave.run.js A /tmp/hw/a`.

**Gotchas learned:** (1) `package.json#upgrade` must be a valid `pear://` link (mint via `pear touch`) or `electron-forge start` refuses to boot. (2) Cold discovery on a fresh public-DHT topic takes **~20–35s** — launch demo instances early; consider a validator `joinPeer` well-known key or local DHT bootstrap to speed it up. (3) Two Hyperswarm instances in one process don't reliably discover each other; always one instance per process. (4) A local DHT (`@hyperswarm/testnet` / `bootstrap` option) gives instant same-machine discovery and is confirmed working on the dev Mac (it only failed inside the build sandbox due to blocked loopback UDP) — use it for the live demo to avoid the ~30s public-DHT wait. (5) All instances on the same `matchId` share one ring; the app default (`hyperwave:demo-match:v1`) is fixed, so instances on the public DHT collide — isolate tests with `HYPERWAVE_MATCH`/the `matchId` engine option or the local bootstrap. Per-match topics are the production model.

- `ideas/idea.md` — first design pass (deterministic timed wave; every peer computes its own trigger time from ring angle).
- `ideas/idea2.md` — evolution to the **baton-pass** model (a token is forwarded peer-to-peer around the ring) plus interlocked hop-by-hop rewards and self-healing gossip.
- `ideas/final-idea.md` — **the authoritative design** (HyperWave). Read this first. It supersedes the others and contains the critical refinements below. **§11 is the MVP platform decision (desktop Electron) and overrides earlier mobile/sensor assumptions.**

When the designs conflict, `final-idea.md` wins; within it, §11 wins for anything MVP/platform-related.

## What This Project Is

A submission for the **Tether Developers Cup** (DoraHacks), theme "football / global tournament moment." It turns a stadium "Mexican wave" into a permissionless P2P relay:

- Peers join a match-specific Hyperswarm topic. Each peer's Noise public key deterministically maps to a fixed **position on the 256-bit DHT ring** (`angle = uint256(pubkey) / 2^256 * 360°`) — the ring *is* the stadium seating chart. No registration, no server.
- A signed **wave token** races peer-to-peer to each peer's **successor** (next live peer clockwise), accumulating a cryptographic receipt chain (~50–100ms/hop). Dead successors are skipped using a gossip-built ring map.
- After the token passes, each peer gets a **proof window** to react, take a selfie, and write it to a shared **Autobase** gallery (writes gated on holding a valid token receipt).
- **WDK** powers all money: self-custodial wallets, a join bond, interlocked sponsor payouts, and gallery tipping.

## Core Design Rules (baked-in decisions — do not re-litigate)

These are refinements already settled in `final-idea.md`; honor them when implementing:

- **Constant-size hot path.** The `wave-token` must NOT carry the full growing `hops[]` array (bloats to 100s of KB and blows the timing budget). Use a rolling accumulator: `newChainHash = blake2b(prevChainHash + thisReceiptSig)`. Each peer gossips its individual receipt to the validator, which reassembles the full chain off the hot path. Target ~200–400 bytes/token.
- **Two encodings by layer.** Race layer (`wave-token`) → Compact Encoding (binary). Gossip messages and Autobase writes → JSON. Everything is Ed25519-signed over Noise-encrypted Hyperswarm streams.
- **Write to Autobase during the proof window, not "after the race"** — peers close the app once the fun is over, so writes must happen while still connected. The Sponsor Validator also replicates the Autobase + Hyperblobs so the gallery survives after peers leave.
- **Interlocked reward (the golden rule):** peer N is paid only when proof shows peer N+1 continued the wave. On a break, pay the longest valid prefix.
- **Validator is a first-class swarm peer**, not an edge server. Peers push proofs *directly* to it (via `swarm.joinPeer(validatorKey)`); gossip is a redundant path, never the critical path for reward delivery. Reward is fixed-per-participant (budgeted spend), never a split pot — a split pot creates censorship incentives and collapses.
- **MVP is trusted-validator + testnet.** WDK is a wallet SDK, not an escrow platform: bond = a plain testnet USDT transfer to the validator, tracked in the validator's internal ledger; payouts = a loop of individual transfers. No smart contracts in the MVP. Prefer **Tron testnet** (cheapest/fastest USDT).
- The 1-second anti-bot proof delay is **experiential pacing, not security** — do not present it as a real anti-bot measure.

## MVP Platform: Desktop Electron (decided — see `final-idea.md` §11)

The MVP is a **desktop Electron app forked from [`holepunchto/hello-pear-electron`](https://github.com/holepunchto/hello-pear-electron)**, NOT React Native/mobile. Reasons: run N peers on one laptop via `--storage <dir>` (no NAT roulette in the live demo), reliable webcam via `getUserMedia`, fast iteration.

Consequences that override the earlier mobile design:
- **No accelerometer.** The L2 Kinetic / sensor proof layers are **cut**. The **Autobase webcam selfie is the proof-of-humanity** (physical action + gallery content + humanity in one snap). Keep the compact token accumulator regardless.
- **Three-process split imposed by the template — respect it:**
  - **Renderer (Chromium):** UI only — ring viz, proof-window modal + webcam capture, gallery, tipping. Never touches the swarm; talks over the IPC bridge.
  - **Electron main (Node.js):** window/lifecycle, Pear update bridge, IPC routing.
  - **Bare worker(s):** all Holepunch P2P — Hyperswarm, token race, gossip, Autobase, Hyperblobs, Corestore — **plus WDK** (WDK officially supports Bare, so payments live alongside the swarm in one worker; renderer requests tips/payouts over IPC).
- **Validator and spectator are just peer instances** run with a role flag (validator gets a visible log panel; spectator joins `client-only`).

## Intended Stack

- **App shell:** Electron via hello-pear-electron (Electron Forge; `pear-runtime` for OTA updates).
- **Networking:** Hyperswarm (DHT discovery, NAT hole-punching, Noise duplex streams) — in the Bare worker.
- **Shared state:** Autobase (multi-writer selfie gallery) + Hyperblobs (selfie images) + Corestore, in the worker.
- **Payments:** WDK (Wallet Development Kit) — multi-chain USDT, self-custodial, **Tron testnet**, plain transfers (no contracts) for MVP; runs **in the Bare worker** (WDK supports Bare — see https://docs.wdk.tether.io/start-building/nodejs-bare-quickstart/). Packages: `@tetherto/wdk`, `@tetherto/wdk-wallet-tron` (+ `-evm`/`-btc` as needed). `WDK.getRandomSeedPhrase()` → `new WDK(seed).registerWallet('tron', WalletManagerTron, {provider})`; remember `wdk.dispose()` on exit. Optional `wdk-mcp` for an AI Sponsor Validator (stretch).

## Commands (from hello-pear-electron; verify after fork)

- `npm start` — run in dev (updates disabled).
- `npm start -- --storage <dir>` — run an isolated instance (use one dir per peer to demo many locally).
- `npm run make` — build platform distributables. `npm run lint` / `npm run format` — code quality.
- `pear build` / `pear stage` / `pear provision` — Pear deployment pipeline (not needed for the local demo).

Open items before coding (`final-idea.md` §11.7): plumb a `--role`/match-topic arg through the template bridge to the worker; verify Autobase multi-writer replication across local instances with separate `--storage` dirs. (WDK-in-Bare is confirmed supported.)

## MVP Scope (from `final-idea.md` §8 / Tier 1)

Target a vertical slice on 3–5 devices/emulators: Hyperswarm join + `presence`/`ring-update` gossip → ring visualization → token race with compact chain hash → proof window UI + selfie capture → Autobase gallery write → Sponsor Validator chain walk + testnet USDT payout → one-click gallery tipping. `dead-peer` healing, bond lock, and `wave-start`/`wave-end` lifecycle are Tier 2.

## Message Types

`presence`, `ring-update`, `wave-start`, `wave-token`, `wave-proof`, `wave-selfie`, `dead-peer`, `wave-end`. Schemas are in `final-idea.md` §5–6 (note: use the compact `wave-token` in §4.1 and the `wave-selfie` with `blobCoreKey`/`blobIndex` in §4.2, not the earlier full-array versions).
