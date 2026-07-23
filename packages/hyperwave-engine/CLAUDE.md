# packages/hyperwave-engine — CLAUDE.md

Engine-specific guidance. The root `CLAUDE.md` still applies when you work here
(especially the **theme-agnostic** rule in Core Design Rules and the whole
**Code Style** list) — this file adds only what matters when editing engine
files.

## The engine is payment-agnostic — keep it that way

**Zero payment dependencies.** Never import a wallet package
(`hyperwave-wallet*`, WDK, cashu-ts) from `lib/`. The engine touches money only
through the injected `createPayments` factory
(`createEngine({ deps: { createPayments } })`); the wallet-agnostic fee flows in
`payments.js` (`burnMemo` / `payFee` / `confirmBurn` / `wireWallet`) are the
only payment code that lives here.

## `lib/` is split by domain

- **Pure modules** (no I/O, unit-tested in isolation): `ring.js` (angle from
  id), `attest.js` (burn + join signatures), `sweep.js` (the deterministic
  schedule from the canonical roster), `messages.js` (one factory + one shape
  validator per message kind — send sites build through the factories, the
  receive edge validates before any signature/state work), `feed.js` (the
  `mergeFeed` CRDT fold + `buildFeed` ordering — join-attestation write-gate +
  byte caps + one-per-peer).
- `feed-crdt.js` = the `CrdtFeed` class (the multicore CRDT: per-participant
  cores, `addWriter` open+download-block-0, `postEntry` append to my own core,
  `tick`/merge).
- `wave.js` = the `createWave` orchestrator wiring Hyperswarm/Protomux transport
  to the above; plus `flood.js` (the `Flood` dedup class, oldest-first
  eviction), `peer-table.js` (the `PeerTable` class — seats + direct-channel
  bookkeeping, angle always derived from the id), `entry.js` (the
  `EntryPipeline` class — pairs the staged lobby entry with my sweep slot, posts
  once per wave, owns the burn-ticket lifetime), and `payments.js`.
- `engine.js` = `createEngine` (the host-agnostic engine: wave protocol, wallet,
  and command dispatch); `worklet/app.js` = the mobile bare-kit entry; `bin/` =
  standalone dev CLIs; `index.js` re-exports.

## Code-style note (stricter here)

The **no-more-than-3-positional-params** rule (root Code Style) is **enforced**
in this package, not advisory — take a single destructured options object. The
hazard is adjacent same-typed args (hex strings) silently transposed at a call
site.

## Engine dev workflow

- **Suites** (brittle / Holepunch TAP, under Bare): `bare test.js` runs this
  package's suites; run one with `bare lib/<name>.test.js`. Add a new suite to
  `test.js` to include it (so the suite list is derivable from `test.js`).
- **Headless smoke test:**
  `HYPERWAVE_TOPIC=test-$RANDOM HYPERWAVE_LOBBY_MS=4000 START=1 AUTOJOIN=1 AUTOENTRY=1 bare bin/wave.run.js A /tmp/hw/a`
  plus a B → both reach `FEED size=2` (public DHT ~30-90s; or `bare bin/dht-local.js`
  with `HYPERWAVE_BOOTSTRAP=host:port` for instant local discovery).
- **Automated e2e harness:** `e2e/` (`npm run test:e2e:local` from the repo
  root drives this across 8 peers).

## Docs

This package documents itself under `docs/` — `protocol.md` (the authoritative
on-wire spec: messages, the uniform Ed25519 envelope, lifecycle, feed, §11
hardening) and `usage.md` (API examples). Keep `protocol.md` in sync when the
protocol changes.
