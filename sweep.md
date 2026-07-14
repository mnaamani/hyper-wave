# The Sweep — action plan

Replace the serial token walk with a deterministic angular sweep (the
`scalable-topology.md` §3B / Phase 5 design), and move gallery admission to
lobby-time batch admission. Goal: a wave whose wall-clock is a chosen constant
regardless of N, with the token/heal machinery deleted and admission off the
hot path. Bias every decision toward deleting code.

Untracked scratch plan — not part of the repo docs.

**STATUS: ALL PHASES COMPLETE** (commits 7076234 → 3710f23, 2026-07-12/13):
Phase 1 (batch admission), Phases 2+3 (the sweep, token deleted), Phase 4
(chord-routing deleted, capped far fingers, FIFO flood cache), Phase 5 folded
into each phase's tests (units + strict 8-peer e2e green throughout), Phase 6
(docs synced). Net ≈ −1,600 lines. Remaining follow-ups live in TODO.md
("Remaining hardening"), notably the 128-peer public-DHT re-validation run.

---

## Target design (one paragraph)

Lobby unchanged: `wave-announce` floods (paid-gated), peers opt in with
`wave-join` — which now also carries the joiner's **gallery writer key** and
**burn attestation** (both signed; the join itself is the admission request).
At lobby close the initiator validates and **batch-appends every `add-writer`
op** to its core, then floods `wave-start` carrying the roster plus **`t0`**
(epoch ms, a few seconds ahead to absorb flood latency) and **`lapMs`**. Every
roster peer computes its slot locally — roster sorted by ring angle,
`slot = t0 + (rank / rosterSize) * lapMs` — and at its slot appends its staged
selfie (it is already writable: becoming a writer and syncing the gallery
bootstrap are the same replication). The ball on every screen is rendered from
the schedule (the engine emits synthetic `position` events on a local timer —
renderer IPC unchanged). The wave ends deterministically at
`t0 + lapMs + grace` on every peer — no completion message, no healing,
no ACKs. Gallery replication/convergence is pure catch-up after that, exactly
as today (initiator retains; others hold open until the next wave).

What a dead/skewed peer costs: nothing. Its slot passes silently; nobody
waits, nothing stalls, no skip logic. Clock skew only shifts the cosmetic
ball; `apply()` does not enforce slot timing.

---

## Phase 0 — safety net

- Branch (`sweep`). Baseline: `npm test` + `npm run test:e2e:local` green at
  N=8 on the pinned hyperdht.

## Phase 1 — admission: credential + batch (still on the token, keeps tests green)

The credential moves from "hop receipt" to "signed join attestation", and
admission moves from mid-race RPC to lobby-close batch.

1. `token.js`: add `signJoin` / `verifyJoin` — Ed25519 over
   `H(waveId | peerId | writerKey | 'join')`, same shape as the existing
   receipt/burn/gallery-key helpers in that file.
2. `wave-join` gains `writerKey`, `joinSig`, `burn` (the existing signed burn
   attestation). Initiator-side: on each valid join during the lobby, stash
   `{writerKey, joinSig, burn}` with the roster entry (verify signatures on
   arrival — cheap, and bounds the batch to valid requests).
3. `gallery-session.js`: new `admitRoster(entries)` — the originator
   batch-appends `add-writer` for every collected writer key at lobby close,
   before `wave-start` goes out. Reuses the existing checks (`burnAuthorizes`
   when enforcing; `#admittedKeys` dedup).
4. `gallery.js apply()`: gate entries on the join attestation
   (`verifyJoin`) instead of `receiptSig`. Keep one-entry-per-peer, byte
   caps, and the burn/tip-address binding exactly as they are.
5. DELETE the reactive admission path: `#ensureWriter`, `#requestAdmission`,
   the `add-writer` flood + `ADMIT_RETRY_MS`/`ADMIT_TIMEOUT_MS` machinery,
   the `admitTimeoutMs` engine option, and the `add-writer` message handling
   in `wave.js`. A peer whose join misses the lobby is a spectator (same
   promise the roster already makes). Note in TODO: a reactive fallback can
   be re-added later if late posting is ever wanted.
6. Update suites: `wave.autobase` (write-gate now join-attested),
   `selfie` (burn-ticket invariants unchanged), drop admission-flood cases.

## Phase 2 — the sweep itself

1. `wave-start` (and `wave-sync`) gain `t0` + `lapMs`; initiator sets
   `t0 = now + SWEEP_LEAD_MS` (constant, ~3–5s) and
   `lapMs = clamp(rosterSize * SLOT_MS, MIN_LAP_MS, MAX_LAP_MS)`.
2. New tiny module `sweep.js` (pure, testable): given (roster, myId, t0,
   lapMs) → my slot time + the full schedule (for the renderer ball). Order =
   roster sorted by `angleOfId`.
3. `wave.js` `beginRace(roster)` becomes `beginSweep(...)`: arm one
   `setTimeout` to my slot (post staged selfie via the session — already
   writable from Phase 1) and a local ticker that emits `position` events
   along the schedule so the renderer is untouched.
4. Deterministic end: every peer (originator included) finishes at
   `t0 + lapMs + END_GRACE_MS` — local timer, flooded `wave-end` DELETED
   (it existed to synchronize an end only the originator could observe;
   now everyone observes it). Keep `endedWaves` (cheap guard against stale
   floods reviving a finished wave id).
5. `selfie.js` `SelfiePipeline` shrinks: no receipt pairing — it holds the
   staged frame + burn ticket and posts once per wave at the slot. Keep the
   burn-proof-survives-wave-reset behaviour (the tip-address gotcha).

## Phase 3 — delete the token walk

- `wave.js`: `forwardToken`, `pickSuccessor`, heal timers/resends/skips,
  `seen`, `wave-pos` handling (`announcePosition`), token receive/adopt
  paths, `HEAL_TIMEOUT_MS`, wave-timeout scaling tied to hops.
- `token.js`: delete receipts + the blake2b chain accumulator + wave-end
  signing; KEEP `signJoin`/`verifyJoin`, burn attestation, gallery-key
  attestation (consider renaming the module `attest.js` — it no longer has
  anything to do with a token).
- `ring.js`: delete `pickReachable` (and `nextClockwise` if the successor
  seam below goes too); keep `angleOfId`/`liveRing` (renderer + sweep order).
- Messages deleted from the protocol: `token`, `wave-pos`, `wave-end`,
  `add-writer`. Remaining: `pointers`, `wave-announce`, `wave-join`,
  `wave-start`, `wave-sync`.
- Delete suites: `wave.token`, the heal/receipt parts of `wave.logic`.
  Add: `sweep` (slot math: ordering, bounds, determinism across peers).

## Phase 4 — topology simplification (the sweep needs less)

The token needed a _correct successor_ under partial views; the sweep only
needs a _connected flood graph_ + replication paths.

- DELETE `chord-routing.js` entirely (distributed `find-succ` RPC, join-time
  self-placement, successor repair) and the `find-succ`/`find-succ-reply`
  messages + `chord` routing-sim test half. Successor _precision_ no longer
  matters — only connectivity.
- KEEP pinning in `maintainNeighbours`, simplified per the existing TODO
  item: successor-list (k=3) + predecessor + **2–3 far fingers** (capped
  set) for flood diameter. `chord.js` keeps only the math this needs
  (`ringOrder`/`successors`/`predecessor`/capped `fingers`).
- Flood layer (`flood.js`) unchanged — it is now the protocol's backbone
  (announce/join/start). Do the two hardening tweaks while here:
  LRU eviction instead of the wholesale `GOSSIP_SEEN_CAP` clear (no retry
  storms remain, but wholesale-forget under pressure is still wrong).

## Phase 5 — tests & e2e

- Unit: `sweep` suite; updated `wave.autobase` / `selfie` / `gallery.*`;
  deleted token/heal/routing suites. `npm test` green.
- e2e `wave.local.e2e.js`:
  - Test 1 unchanged in spirit: N peers, full roster joins, **gallery
    converges to the roster on every node**. The visit-set problem is gone,
    so this assertion should now hold at scale too — try re-tightening
    `STRICT_FULL_ROSTER`-style assertions upward.
  - Heal test becomes a kill test: kill 2 peers **after `started`**; assert
    the sweep still ends on time and survivors converge to `roster - 2`
    (exactly — no more "tolerate one extra dropped selfie", because there is
    no heal-precision loss mode).
  - Budgets: `WAVE_TIMEOUT`/lap scaling is now `lapMs` by construction;
    `ADMIT_TIMEOUT_MS` plumbing removed from the harness.
- Scale run: dispatch the manual public-DHT workflow at 128 to confirm the
  two known scale killers are gone (admission timeouts, silent skips).

## Phase 6 — docs & hosts

- `docs/protocol.md`: message table (−4 messages, `wave-join`/`wave-start`
  fields), lifecycle (racing → sweeping), crypto (join attestation replaces
  receipts/accumulator), §11 hardening notes (heal-ACK/receipt-stall items
  become N/A; deterministic end).
- `docs/scalable-topology.md`: §3B/Phase 5 marked implemented; §8 items
  about the successor seam / find-succ close as obsolete.
- `docs/idea.md`, `docs/architecture.md`, `CLAUDE.md`, `TODO.md` sync.
- Hosts: renderer untouched by design (synthetic `position` events); check
  `apps/desktop/workers/hyperwave.js` + `worklet/app.js` option plumbing
  (`admitTimeoutMs` gone, `lapMs` optional), `bin/wave.run.js` env knobs.

---

## Net deletion estimate

| Area                                                    | Fate                                                                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `chord-routing.js` (254 lines)                          | deleted                                                                                               |
| token walk + heal + wave-pos in `wave.js`               | ~350–450 lines deleted, ~80 added (`sweep.js` + timers)                                               |
| receipts/accumulator/wave-end in `token.js` (328 lines) | roughly half deleted, small `signJoin` added                                                          |
| reactive admission in `gallery-session.js`              | ~120 lines deleted, ~30 added (`admitRoster`)                                                         |
| `selfie.js` pairing logic                               | ~halved                                                                                               |
| messages                                                | `token`, `wave-pos`, `wave-end`, `add-writer`, `find-succ`, `find-succ-reply` all gone (10 → 5 kinds) |
| tests                                                   | token/heal/routing suites out; one small pure `sweep` suite in                                        |

## What we consciously give up (decided in discussion)

- Causal relay → scheduled choreography ("one moment, really shared").
- The ordered receipt chain (nothing consumes it since sponsor payouts were
  removed); participation proof = signed join + burn.
- Late/missed-lobby peers can't post (spectate only) — reactive admission
  fallback deliberately deleted; re-add later only if wanted.
- Loose clock-sync dependency (cosmetic only; NTP-grade skew is fine).

## Order matters

Phase 1 lands independently and keeps the token e2e green (admission just
gets earlier + batched). Phases 2+3 are one coherent switch (land together).
Phase 4 only after e2e is green on the sweep — it's pure deletion, keep it
reviewable on its own.
