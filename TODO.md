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

## Backlog

### Gallery write authorization (the real anti-spam gate)
Today admission is **unconditional**: any peer that broadcasts `add-writer` is admitted, and
`apply()` appends any `wave-selfie` without checking the receipt. Autobase only enforces the
structural writer-set (an existing writer must add you) — there is no wave-participation check.
Implement the design's "no receipt = no write":
- On admission: only append `add-writer` if the request carries a valid receipt for this wave.
- In `gallery.js` `apply()`: only append a `wave-selfie` whose `receiptSig` verifies (Ed25519)
  for `(waveId, hopCount, peerId)` — so even an admitted writer can't post for a hop it didn't
  hold. `apply()` is the strong point because it runs deterministically on every peer.
- Caveat: verifying the receipt is *valid* is easy; verifying it's in *the* real token chain
  needs the accumulator the validator saw (validator arbitrates at payout). Forked clients can't
  be fully stopped — the gate keeps the honest gallery clean and raises the bar.
- The existing "anti-spam gate" comments describe this intended behaviour.

### Resilience / healing (review item #4)
- Skip dead/unreachable successors instead of stalling (`successor-unreachable` currently kills
  the wave); ACK/timeout + skip to next live peer.
- Bound the `seen` set (currently grows unbounded across waves).

### Housekeeping
- Prune old `wave-gallery:<waveId>` namespaces on startup (they linger on disk under `--storage`),
  or add a "past waves" picker to browse them as permanent artifacts.
- Handle `gallery-error` events in the renderer (currently silent).

### Payment layer (WDK) — next major step
- WDK in the Bare worker (Tron testnet, plain transfers, no contracts for MVP): self-custodial
  wallets, join bond, interlocked per-hop payout on wave completion, gallery tipping.
