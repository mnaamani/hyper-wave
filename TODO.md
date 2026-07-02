# HyperWave — task list

Refinement backlog, roughly prioritized. Design context in `ideas/final-idea.md`.

## Done
- [x] Code structure: split engine into `ring.js` / `token.js` / `gallery.js` + `wave.js` orchestrator
- [x] Derive ring angle from identity (never trust gossiped angle)
- [x] Gallery UX: one selfie at a time in the ring centre (features new arrivals, auto-cycles)
- [x] Token is a ⚽ football that rolls around the ring on every screen (cross-window `wave-pos`)
- [x] Proof window as a compact corner card (doesn't cover the ring)
- [x] Per-wave galleries (Autobase namespaced by `waveId`; fixes stale selfies across waves/runs)
- [x] Wave lifecycle: single active wave at a time (anyone can start when idle); deterministic
      tie-break for simultaneous starts (lower `waveId` wins); `wave-end` broadcast so all peers
      finish together; timeout fallback to idle; `busy` guard + Start button disabled while active
- [x] Resilience / healing: forward to the next *reachable* peer (skip unconnected ones); if the
      wave doesn't advance past my hop within `HEAL_TIMEOUT_MS` (the successor's `wave-pos` = ACK),
      skip that peer and re-forward (`healed` event). Bounded `seen` (cleared per wave) +
      `endedWaves` guard so a finished wave can't be revived. `pickReachable` unit-tested.
      NOTE: the skip path isn't networked-verified (sandbox can't form 3 peers); happy-path heal
      arm/clear is exercised by the lifecycle run. Known edge: if a peer dies right after holding
      (predecessor already ACKed), that gap isn't healed — the wave timeout catches it.
- [x] Gallery write authorization (anti-spam gate): `apply()` appends a `wave-selfie` only if its
      `receiptSig` verifies (Ed25519) by `peerId` over `(waveId, hopCount, chainHash, receiptTs)`
      — deterministic on every peer; admission (`add-writer`) is gated on the same receipt for the
      current wave. Rejects unsigned/impersonated entries (unit-tested in wave.autobase.test.js).
      NOTE: authenticity only — a peer can still self-sign a receipt for a hop it didn't hold;
      real proof-of-participation needs the validator cross-checking the token chain (payment layer).

## Backlog

### Housekeeping
- [x] Prune old galleries: the `storageDir/hyperwave` store is wiped on startup (per-run,
      nothing persists across runs), reclaiming stale `wave-gallery:<waveId>` disk. Galleries are
      now ephemeral per-run; a "past waves" picker for persistent artifacts is a future option.
- [x] Surface `gallery-error` events in the renderer (was silent).

### Payment layer (WDK) — next major step
- WDK in the Bare worker (Tron testnet, plain transfers, no contracts for MVP): self-custodial
  wallets, join bond, interlocked per-hop payout on wave completion, gallery tipping.
