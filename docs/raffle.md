# HyperWave — sponsor-funded raffle reward (design)

Status: **built (MVP, behind a flag)** via the **internal commit-reveal** path (§3.2). A
positive incentive to start/join a wave, layered on the existing model (burned fees + tips, no
sponsor rewards). Verified live on Nile: a funded initiator drew the winner among gallery
participants and paid the prize to the winner's burn-verified address (net for a participant:
−1 fee +prize).

> **Terminology note:** parts of this doc predate the removal of peer roles — read
> "seed" / "sponsor" as **the wave's initiator**. As built, sponsor ≡ initiator by
> construction: a funded peer draws only for waves it itself initiated (`iInitiated` gates
> `scheduleDraw` in `raffle.js`); there is no separate sponsor role or signed
> "sponsored-wave" marker (that remains a production idea, §7/§9).

**As-built decisions** (per the follow-up discussion):

- **Randomness:** internal commit-reveal (§3.2), **no external beacon**. Each participant
  commits to `commit = H(secret)` and reveals `secret` in its gallery selfie; the seed folds
  the revealed secrets into the draw seed (`raffleDraw` in `token.js`).
- **Commit published two ways** (both same value): (a) ring-signed on `wave-join` /
  `wave-announce` gossip, which the seed **caches in memory** during its lobby (phase gate =
  reveal deadline); and (b) **on-chain**, in the fee-burn **memo**
  (`hyperwave:<waveId>:<peerId>:<commit>`), timestamped in the lobby and immutable. The gallery
  entry keeps the burn `txHash` (`burnTx`) so the on-chain commit is locatable.
- **The seed draws from its in-memory gossip cache — NOT by fetching commits on-chain.**
  Fetching every participant's commit over the Tron REST API at draw time would be slow and
  hit rate limits, so the hot draw path stays in memory. The **on-chain memo is the
  accountability record**: because commits (chain) + reveals (gallery) are both public, anyone
  can _later_ recompute the eligible set and winner and catch a seed that dropped a
  validly-committed participant or paid the wrong winner. Fast in-memory draw, kept honest by
  an on-chain audit trail (a deterrent) — not by trusting the seed's bookkeeping.
  - _Consistency:_ a well-connected seed (pinned by all peers) receives every lobby commit, so
    its cache = the on-chain set and there's no discrepancy to flag. The residual is a benign
    false positive — if a commit's gossip genuinely never reached the seed (network drop), the
    audit shows an "excluded" participant that the seed simply never saw, not censorship.
- **Payout doubles as the burn check for OPTIMISTIC admission.** Gallery admission no longer
  verifies the burn on-chain (that was O(N) reads on the admitter). So `raffleDraw` produces a
  deterministic **ranking** (tickets keyed by `H(seed|peerId)`, sorted ascending), and the
  raffle `run()` walks it and
  pays the **first candidate whose burn verifies on-chain** — one read for the winner (+ one per
  fake-burn entry ranked above it) — **skipping itself**: the initiator holds a fair ticket but
  never pays its own prize; if it ranks first the walk moves to the next eligible candidate.
  This is where "you must really have burned to win" is
  enforced, and the walk is auditable (skipping a candidate whose burn was actually valid is
  detectable on-chain).
- **Sponsor = admitter = seed (single trusted role), for simplicity.** With commits on-chain
  the **draw math is publicly auditable**, but the seed still **decides who's admitted**, so it
  _could_ censor the entry set. **This collapses the separation of powers of §7.** Accepted for
  the MVP (trusted sponsor + testnet); **production must separate the admitter (an independent
  wave originator) from the prize-holder.** See §7.
- **Prize:** single winner (the walk pays one candidate and stops), `raffleTrx` TRX, enabled
  per-instance by `HYPERWAVE_RAFFLE_TRX` on the initiator. `raffleDraw` returns the full
  ranking, so k winners = the top-k of the walk, for later.
- **Custody:** the seed pays from its own wallet (trusted-sponsor MVP); escrow deferred (§6).
- **Legal:** testnet-only; production needs review (§8).

Implementation: `run()` in `packages/hyperwave-lib-core/lib/raffle.js` (`createRaffle`,
scheduled by `scheduleDraw` on wave finish; wired by `wave.js`). It draws from the in-memory
gossip commit cache; the burn memo carries the commit on-chain for audit, and `pay.js`
`verifyBurnTx` returns that memo `commit` for a verifier tool. Pure draw + commit crypto
(`commitOf`, `signCommit`/`verifyCommit`, `raffleDraw`) in
`packages/hyperwave-lib-core/lib/token.js` (unit-tested).
Verified live on Nile: the commit appeared in the burn memo and the initiator drew + paid from it.

---

This doc settles the fairness and legal questions, per the discussion that produced it.

Prior context: the interlocked sponsor payout was removed (sybil-farmable). The question is
how to add a positive incentive back **without** reopening that hole. A raffle fits unusually
well because the **burn-gated gallery is already a sybil-resistant ticket ledger**.

---

## 1. Why a raffle fits this system

- **The gallery is the ticket book.** Every gallery entry is one peer, backed by one real
  on-chain **burn** (join fee), with a **burn-verified payout address** and **one entry per
  peer** (enforced in `apply()`). So "who is in the draw" is already a public, replicated,
  sybil-resistant list — no new ticketing to build.
- **Fixed, headcount-independent sponsor spend.** Unlike per-participant rewards (spend grows
  with the crowd), a raffle's cost is just the prize(s). Best-in-class budget predictability.
- **Engagement.** A small chance at a big prize drives participation through hope, and the
  draw is a natural "and the winner is…" moment for the demo.

## 2. Ticket eligibility

One ticket = one **burn-gated gallery entry** in the **sponsored** wave:

- Must be backed by a **join burn**. As built, admission is **optimistic** — the admitter
  checks only the burn attestation's _signature_ (`burnAuthorizes`), no on-chain call (§8.2
  of `docs/protocol.md`); the **on-chain verification happens at payout** (the winner walk
  pays the first candidate whose burn verifies). So a _winning_ ticket costs a real fee;
  buying more chances = more identities = more burns + more live peers. This is the whole
  sybil bound.
- **Only the funder's own waves pay.** A random peer's wave earns nothing — otherwise an
  attacker spins up a private wave of its own sybils and takes the pool. As built this is
  structural: a funded peer draws **only for waves it initiated** (`iInitiated`). (A signed
  `wave-sponsor` marker separating funder from originator is a production idea, not built.)
- Entries **close at wave-end** (the gallery is final). No late entries: they'd need a burn +
  admission, and admission stops when the wave ends.

## 3. The draw: where the randomness comes from

This is the whole design. A draw needs four properties:

1. **Deterministic** — every peer computes the same winner from public data.
2. **Unpredictable at entry-close** — nobody can know the outcome before tickets are locked
   (else they'd choose whether to enter based on winning).
3. **Unbiasable** — no participant (nor a coalition, nor the sponsor) can _aim_ the outcome.
4. **Auditable** — anyone can recompute the winner and check the sponsor paid that address.

Properties 1, 2, 4 are easy. Property 3 is hard, and it has a name.

### 3.1 The fundamental obstacle: the last-actor problem

Any scheme where participants **contribute entropy sequentially** (each sees predecessors'
contributions before making its own) is **biasable by whoever goes last**. The last
contributor can compute the outcome for each of its possible moves and pick the one that
favors it. In HyperWave the sequential contributions are everywhere:

- **the receipt chain accumulator** (`chainHash`): each hop folds in `receiptSig`, and the
  peer chooses `timestamp` (part of the signed tuple) → it can grind its receipt to steer the
  final accumulator. The **originator** is worst: it holds hop 0 _and_ completes the lap.
- **burn txids**: a peer building its burn tx can grind fields (offline) to bias its txid.
- **join order / roster**: chosen by participants who see the state so far.

So **"just hash the participation data" is deterministic and unpredictable-to-early-peers but
NOT unbiasable** — the last peer / originator games it. This is the trap to avoid. It is also
why the _external_ block-hash beacon is attractive: its entropy comes from a party (miners)
with **no stake in the raffle** and is **fixed only after entries close**, so there is no
last participant to bias it.

> Theory note: unbiasable distributed randomness with **no external source and no trusted
> party** is impossible against a rational last actor who can _abort_ — you need one of:
> (a) an external beacon, (b) a **VDF (Verifiable Delay Function)** — make "compute-then-decide"
> too slow to fit the window, or (c) a **threshold** scheme (no single party is last). Everything
> below is a point on that trade-off.

### 3.2 Answer to "can we stay fully internal (no external beacon)?"

**Yes — with commit-reveal, using the two phases the wave already has.** This is internal-only
(no block hash, no external call), deterministic, unpredictable, and unbiasable _except_ for a
bounded, costly last-revealer _abort_ (not aim). Concretely:

**Lobby-commit / gallery-reveal**

1. **Commit (lobby).** When a peer joins, it generates `secret_i` (32 random bytes) and
   publishes `commit_i = BLAKE2b(secret_i)` in its `wave-join` (or alongside its burn
   attestation / staged selfie). Everyone commits **before** the race — before seeing any
   other secret, and the commit hides it.
2. **Reveal (gallery).** The peer reveals `secret_i` in its `wave-selfie` entry. `apply()`
   just stores the reveal (it can't check it — the commits live in the initiator's in-memory
   cache, not in the Autobase); **eligibility is enforced at draw time**: the initiator's
   `run()` (`ticketsFrom`) keeps an entry only if `BLAKE2b(secret_i) == commit_i` — a wrong
   or missing reveal makes the ticket ineligible (but the selfie can still show).
3. **Seed.** As built (`raffleDraw`):
   `seed = BLAKE2b( utf8("raffle|" + waveId + "|" + secrets joined by "|" in ascending-peerId order) )`
   — no commit-root term, no `chainHash` mixing. The winner ranking (§4) is derived from `seed`.

Why this gets properties 1–4:

- **Deterministic / auditable** — every input is in the replicated gallery; anyone recomputes
  the seed and checks the payout tx.
- **Unpredictable** — at commit time, secrets are hidden behind hashes; you cannot compute the
  seed until reveals land, which is after tickets are locked.
- **Unbiasable-to-choose** — a peer commits `secret_i` before seeing others, so it **cannot
  pick** a favorable secret. Its only residual move is the **last-revealer abort**: the last
  peer to reveal knows the outcome and can _withhold_ its reveal to force a re-roll. But that:
  - only offers a **binary** choice (reveal → winner X, or abort → winner Y over the
    remaining set) — it **cannot aim** at an arbitrary target;
  - **costs** the aborter its own ticket (and burn) — reveal-by-deadline or you're DQ'd;
  - shrinks with scale — with many revealers, one abort barely moves the seed, and a
    coalition of `k` aborters gets only `2^k` pre-determined outcomes for `k` forfeited
    tickets.
    Handle it with a **reveal deadline** (a local timer at/after wave-end): the seed is computed
    over on-time reveals only; late/no-shows are excluded. This leans on rough time coordination
    (the deadline) but **not** on any external beacon.

  **A missing reveal never aborts the whole raffle.** As implemented (`raffle.js` `run()`), a
  participant that committed but didn't reveal (or whose reveal doesn't match its commit) is
  simply **dropped from the ticket set**; the draw runs over whoever revealed validly. If
  _nobody_ revealed, there are no tickets and no winner is paid (a no-op, not an error). So a
  withholder can shift the seed by removing itself (that IS the abort lever) but can't cancel
  the draw. The effective reveal window is the draw schedule: the draw fires `RAFFLE_DELAY_MS`
  (3s) after the wave finishes, then **polls for convergence** (every `RAFFLE_POLL_MS`, up to
  `RAFFLE_CONVERGE_MS` = 20s) until the replicated tickets cover the cached commits — reveals
  that haven't replicated into the initiator's gallery by then are missed.

This is the recommended internal-only scheme. It is philosophically pure P2P and needs no
chain node for the draw — at the cost of a commit field in `wave-join`, a reveal field in the
gallery entry, and a reveal-deadline timer.

### 3.3 Alternative: external block-hash beacon (no commit phase)

```
participants = sponsored wave's gallery entries, sorted by peerId        (M, each burn-verified)
B            = hash of the first Tron block with timestamp ≥ waveEnd + DRAW_DELAY
seed         = BLAKE2b(B ‖ waveId)
```

- **Pro:** no last-actor at all (entropy is external and disinterested, fixed after close);
  no commit/reveal machinery; simpler gallery schema.
- **Con:** needs a chain node to read `B` (an external dependency the rest of the draw
  avoids); miner block-withholding is the _analogous_ bounded/costly grind.

### 3.4 Full unbiasability, internal-only (heavyweight, future)

- **VDF (Verifiable Delay Function) over the seed** — require the seed to pass through a
  function that is deliberately _slow to compute but fast to verify_. The last revealer can't
  compute-then-decide within the reveal window (the answer isn't ready in time), killing the
  abort advantage — internal-only, no beacon. Cost: a real VDF is heavy and a Bare/JS
  implementation is unproven. Out of scope for the MVP.
- **Threshold secret-sharing** — no single party is last. More protocol, more failure modes.

### 3.5 Recommendation

**Internal commit-reveal (§3.2)** for a self-contained P2P raffle, with the reveal deadline
handling the last-revealer abort (bounded + costly, cannot aim). If you would rather avoid the
commit/reveal machinery and a chain node is acceptable, the **block-hash beacon (§3.3)** is
simpler and removes the last-actor entirely. Both reduce the residual to "a last actor can
force a bounded, costly re-roll, not choose the winner" — the choice is _internal complexity_
vs _external dependency_. Ship one behind a flag; they share everything downstream of `seed`.

## 4. Winner selection (shared by all schemes)

As built (`raffleDraw`): a deterministic **ranking**, not a modulo index —

```
key_i   = BLAKE2b( seed ‖ "|" ‖ peerId_i )      # one key per eligible ticket
ranking = tickets sorted by key ascending        # winner candidate = ranking[0]
# k winners (tiered/multi) = ranking[0..k-1] — no rejection sampling needed
```

The initiator then **walks the ranking** and pays the first candidate whose burn verifies
on-chain, **skipping itself** (it holds a fair ticket but never pays its own prize). Payment
goes to that candidate's `address` (the **burn-verified** tip address — already bound to the
wallet that paid in, so a winner can't have redirected the prize elsewhere).

## 5. Prize structure

- **Single prize** — max excitement/variance; one winner, everyone else net −fee.
- **Tiered** (1 big + several small) — classic raffle feel, more winners.
- **Top-k equal** — k equal winners.

Same primitive, different `k`/amounts. Sponsor spend is fixed regardless of crowd size.

## 6. Payout & custody

- **MVP:** the sponsor = the funded **seed**; it runs the draw and pays from its own wallet
  after the reveal deadline / beacon block. Matches the existing "trusted validator + testnet"
  assumption; no new infrastructure. Reuses the seed's post-wave hook (the slot the removed
  `runPayout` vacated) and `pay.js`.
- **Risk: sponsor refusal/failure** (it just doesn't pay). Trustless fix: hold the pool in an
  escrow/multisig or a Tron contract that releases to the computed winner — removes rug risk
  but is real work and breaks the "no contracts in the MVP" line. Fine to defer for a testnet
  demo; required for real value.

## 7. Trust & attack analysis

| Vector                            | Exposure                                                                                      | Mitigation                                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sybil (buy odds)**              | must burn + run a live peer + get admitted **per identity**; one ticket per burn-gated seat   | sponsored-waves-only + global cap + per-identity cost; expectation-neutral if prize ≤ total burns (but the subsidy `prize > burns` is the point, bounded by cap) |
| **Bias the draw**                 | last-actor problem (§3.1)                                                                     | commit-reveal + reveal deadline (bounded binary re-roll, can't aim), or external beacon (no last actor)                                                          |
| **Sponsor rigs draw**             | can't — can't control `B`/others' secrets; entries close before the seed exists               | public gallery + public beacon/reveals → recompute and detect                                                                                                    |
| **Sponsor censors the entry set** | the seed **also admits** writers → could starve honest entries and stack sybils to shrink `M` | **separate powers:** let an _independent originator_ be the admitter; the sponsor only funds + draws. Censorship is visible in the public gallery.               |
| **Winner redirects prize**        | none — the tip `address` is burn-bound (`apply()`, §8.2)                                      | pay the verified address only                                                                                                                                    |

The load-bearing non-obvious point: **the party funding the prize must not also gate who's in
the draw.** Keep the admitter (wave originator) separate from the prize-holder (sponsor/seed).

## 8. The caveat bigger than the code: it's legally a lottery

Paid entry (the burn) **+** chance **+** prize = the three elements of a **lottery / gambling**
in most jurisdictions, and running one unlicensed is often illegal — crypto included. This is
what separates a raffle from a fixed _reward_ (which pays for an action, not chance). Options,
by cost:

- **Testnet / no real-world value** — fine for the Cup demo; document it as such.
- **Free alternate method of entry (AMOE)** — standard sweepstakes workaround (entry not
  "paid"); but it guts the anti-spam burn for free-path entrants.
- **Decouple** — frame the burn strictly as an anti-spam fee (not a ticket) and make raffle
  entry free/automatic for all gallery members → no _paid_ entry into the game of chance.
- **License / jurisdiction it** — real legal work.

**MVP stance: testnet-only, explicitly documented as legally sensitive for production.** Not a
footnote — it's the biggest blocker to shipping this with real money.

## 9. Implementation (as built)

Minimal, because the plumbing existed:

- **Which waves pay** — structural, no marker: a funded peer draws only for waves it
  initiated (`iInitiated` gates `scheduleDraw`). (The signed `wave-sponsor` marker for a
  separate funder remains future work.)
- **Commit/reveal fields** — `commit`/`commitSig` on `wave-join` **and** `wave-announce`
  (the initiator records its own via `recordOwn`); `raffleSecret` on the `wave-selfie`
  entry. Eligibility (`H(secret) == commit`) is checked at **draw time** by
  `run()`/`ticketsFrom` — not in `apply()`, which only stores the reveal.
- **`run(waveId)`** (`lib/raffle.js`, scheduled by `scheduleDraw` on wave finish): gather
  eligible tickets → `raffleDraw` (seed + ranking) → walk the ranking, verify the
  candidate's burn on-chain, skip self → `pay.send` → emit `raffle-draw` (`{tickets, seed,
top}`) and `raffle-win` (`{winner, address, amount, hash}`) for the renderer to celebrate.
  No receipts, no chain walk — the gallery is the ledger.
- **Constants/params:** prize = the `raffleTrx` option (env `HYPERWAVE_RAFFLE_TRX`);
  timing = `RAFFLE_DELAY_MS` (3s) + converge poll (`RAFFLE_POLL_MS` / `RAFFLE_CONVERGE_MS`
  20s). Single-winner is the walk's behavior, not a constant.
- **Standalone verifier** (future) — a script that takes the public gallery + reveals +
  on-chain commits + payout tx and recomputes the winner, so the fairness claim is checkable
  by a skeptic.

## 10. Open decisions

1. **Randomness source:** internal commit-reveal (§3.2, self-contained) vs external block-hash
   beacon (§3.3, simpler)? Both share everything after `seed`.
2. **Prize structure:** single vs tiered vs top-k?
3. **Custody:** trusted sponsor wallet (MVP) vs escrow/contract (production)?
4. **Admitter ≠ sponsor:** commit to the separation of powers (§7) — who runs the originator?
5. **Legal:** confirm testnet-only framing; production needs review (§8).
