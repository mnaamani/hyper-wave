# HyperWave — task list

Refinement backlog, roughly prioritized. Design context in `ideas/final-idea.md`;
docs in `docs/` (architecture, protocol, scalable-topology); demo script in `DEMO.md`.

## Done

### Core wave engine + UI

- [x] Code structure: engine split into `ring.js` / `token.js` / `gallery.js` (+ later
      `chord.js` / `flood.js` / `pay.js`) with the `wave.js` orchestrator
- [x] Derive ring angle from identity (never trust gossiped angle)
- [x] Token race with Ed25519 receipts + constant-size blake2b chain accumulator
- [x] Wave lifecycle: idle → lobby → racing → idle; single active wave; lower-`waveId`
      tie-break; `wave-end` broadcast; timeout fallbacks; `busy` guard; join-time `wave-sync`
- [x] Resilience / healing: forward to the next _reachable_ peer; `wave-pos` = ACK; skip a
      silent successor and re-forward; `seen` per wave + `endedWaves` anti-revival
- [x] Gallery: per-wave Autobase (namespaced by `waveId`), writer admission gated on a valid
      hop receipt, `apply()` verifies every entry signature deterministically
- [x] Renderer: ring canvas, rolling ⚽ on every screen, country flags + intro picker,
      centre-selfie gallery, collection progress
- [x] Fast dwell (250ms) + **lobby selfie capture**: selfies are framed/captured during the
      lobby (camera + countdown), staged to the worker, and posted when the ball reaches the
      peer — the token never waits on a human; gallery fills in ring order

### Scalable topology (Chord over Hyperswarm) — `docs/scalable-topology.md`

- [x] Phase 1: ring membership seeded from DHT discovery (`swarm.peers`), liveness-gated
      (no phantom seats from stale announces)
- [x] Phase 2: `joinPeer` pinning of successor-list (k=3) + predecessor — ring edges physical
- [x] Phase 3: finger table + `findSuccessor` + `fixFingers` → O(log N) connections
- [x] Phase 4: stabilize + churn handling (re-pin on close, `goneUntil` cooldown) + slim
      gossip (O(N) `peers` snapshot → a single neighbour-scoped `pointers` heartbeat)
- [x] Control-plane flooding: `wave-announce/join/start/end` relayed with `mid` dedup
      (`flood.js` + partial-topology reach harness `flood.test.js`)
- [x] Distributed `findSuccessor` routing (`find-succ` RPC) — correct under partial
      membership knowledge (64-node sim ≤5 hops); join-time placement + periodic repair
- [x] Gallery over a partial mesh: transitive replication proven (line topology, no swarm);
      the wave **initiator** retains its own wave's gallery (per-wave persistence — no peer
      roles, no dedicated archivist hub)

### Payment layer (WDK, Tron Nile testnet, native TRX) — burned fees + tips, no rewards

- [x] Self-custodial wallet per instance (`pay.js`; seed persists at `<storage>/wallet.seed`);
      💰 chip in the renderer. WDK is ESM-only → CJS worker bridges via dynamic `import()`
- [x] Gallery tipping: `wave-selfie` carries the poster's address; 💵 Tip → real transfer.
      **The only way to make money** — there are no sponsor rewards.
- [x] Participation fees **burned** to Tron's black hole (kick-off + join, 1 TRX each) —
      skin in the game with no beneficiary; on-chain memo `hyperwave:<waveId>:<peerId>`
- [x] Paid-wave anti-spam gate: no announce until the kick-off burn is on-chain (carried as
      the signed `paid` proof); peers ignore unproven announces and verify before joining
- [x] **Optimistic gallery admission** (scales without a Tron node/indexer): `add-writer`
      carries the join burn attestation; the admitter checks only the _signature_
      (`burnAuthorizes`) — **no on-chain call on the write path** (that was O(N) reads on the
      admitter). The burn is verified where it pays off: at raffle payout (winner walk) + by
      tippers via `burnTx`. Spam bounded by one-entry-per-peer + a byte-size cap
      (`MAX_IMAGE_BYTES`/`MAX_CAPTION_BYTES`). Soft, publicly-detectable gate; verified live.
- [x] **Signed gallery key**: originator signs `(waveId, autobaseKey)` (`signGalleryKey`);
      peers verify before opening — a relay can't swap the unsigned key to a rogue Autobase
- [x] **Tip address bound to the burn**: `apply()` keeps a selfie's tip `address` only if a
      signed burn names that wallet — a tip always reaches the wallet that paid in (§8.2)
- [x] **One gallery entry per peer at write** (`apply()` dedup) — a paid seat can't bloat the
      log with unbounded self-signed entries (was display-only dedup before)
- [x] **Sponsor rewards removed** (simplification): dropped the interlocked payout, the
      `wave-proof` receipt collection, the golden-rule chain-walk (`longestValidChain` /
      `payableFromChain`), and the gallery `burn-proof` op. Kills the sybil-payout risk class
      outright (nothing to steal).
- [x] **Peer roles removed** (simplification): no more `validator`/`seed`/`sponsor` role, no
      `role` option, no `HYPERWAVE_ROLE`, no `role` in the `pointers` heartbeat, no
      seed-pinning. Every peer is equal. The only asymmetry is **per-wave and belongs to the
      initiator**: it retains its own wave's gallery (archivist for that wave only), collects
      its raffle commits, and — if it funds a raffle — draws + pays the prize from its own
      wallet (skipping itself in the winner walk). Accepted: a gallery is lost if its initiator
      goes offline; nothing persists across runs.
- [x] **Initiator-funded raffle** (positive incentive re-added, off by default; `raffleTrx` /
      `HYPERWAVE_RAFFLE_TRX` on the initiator) — `runRaffle` draws ONE winner among gallery
      participants via internal **commit-reveal** (no external beacon: commit rides
      `wave-join`/`wave-announce` in the lobby, reveal rides the selfie, the initiator folds
      secrets into a deterministic auditable draw) and pays the burn-verified address from its
      own wallet (it's skipped in the winner walk — never pays itself). Verified live on Nile.
      See `ideas/raffle.md` + `docs/protocol.md` §12. **MVP: initiator = admitter = prize-holder**
      — production must separate the admitter from the prize-holder; testnet-only (a paid game of
      chance is legally a lottery).
- [x] Bare/pear-runtime compat: `postinstall` normalizes dep `engines` ranges Bare's
      semver can't parse (`scripts/fix-bare-engines.js`)
- [x] **End-to-end integration tests** (`app/e2e/`): a Node+brittle harness spawns a local DHT + N real `wave.run.js` peers and drives full waves, asserting on the protocol's structured
      event stream (poll-until-event, no sleeps; process-group teardown). Local suite (no wallet
      / no on-chain, deterministic): 8-peer gallery convergence, self-healing under 2 mid-race
      kills, raffle draw over all N. `npm run test:e2e:local`; runs in GitHub Actions
      (`.github/workflows/ci.yml`) alongside unit tests. **On-chain tier** (`wave.onchain.e2e.js`,
      `npm run test:e2e:onchain`): enforced wave on Nile — paid gate → real kick-off/join burns →
      on-chain kick-off verification → optimistic admission → raffle payout (on-chain winner
      check + real TRX transfer). Gated on funded-wallet secrets, runs manual/nightly
      (`.github/workflows/e2e-onchain.yml`). Verified live (8/8 asserts, ~38s).

### Adversarial hardening (against a modified client) — `docs/protocol.md` §11.2

- [x] Identity binding: a self-describing gossip field (`pointers.id`, `wave-pos.holder`,
      `token.senderPeerId`, `add-writer.peerId`) must match the authenticated connection id
      — blocks ring pollution, heal suppression, and admission under a key you don't hold
- [x] Authenticated `wave-end`: completion signed by the originator (`signWaveEnd`), stall
      carries the staller's hop receipt — an outsider can't force-terminate a live wave
- [x] Paid-gate on every adoption path (`wave-announce`/`wave-start`/`wave-sync`, incl. a
      **racing** sync) — closes the `wave-sync` bypass; kick-off proof now rides `wave-start`
- [x] Completion self-guard (only for a wave I'm running) + heal-ACK precision (only my
      actual successor's `wave-pos`) + cheap-checks-before-Ed25519-verify in token processing

## Backlog

### Propagation at extreme scale (Phase 5 — decision deferred)

Serial token is O(N·dwell) — hours at N=10k. The designed alternative is the
**deterministic angular sweep** (each peer self-triggers from `(startTime, speed)`;
independent per-seat proofs). Decision deliberately parked — the serial token is the product
for now (small/medium waves). See `docs/scalable-topology.md` §3B/§8.

### Adversarial hardening still open (`docs/protocol.md` §11.3)

- [ ] Per-connection rate limiting (token buckets per message kind) + bounds on auxiliary maps
      (`seen`/`endedWaves`/`routed`/`lookupRoute`/`goneUntil`). More important now that
      admission is optimistic (gallery seats are cheap) — the token bucket caps how many
      add-writer/selfie one peer can push. (Per-entry byte cap already done.)
- [ ] Ban peers by IP for invalid protocol messages: track per-connection violations (bad
      JSON, failed signature/identity-binding checks, forged gallery keys, spoofed sender ids)
      and, past a threshold, drop + block the peer at the transport layer (Hyperswarm `ban` /
      `swarm.leavePeer` by remote key; consider IP-level so a peer can't just rekey). Turns the
      per-message drops above into an escalating penalty, so a modified client that keeps
      sending garbage gets cut off rather than re-processed each time.
- [ ] Kick-off verification rate: every joiner still reads the _same_ kick-off burn on-chain
      (N reads of 1 immutable tx). Not a concentration bottleneck (distributed, 1 read/joiner)
      and trivially cacheable, but it's the last per-participant on-chain read. Left as-is (it's
      the anti-_wave_-spam gate; making it optimistic would re-open free wave-spam).
- [ ] Raffle production hardening (`ideas/raffle.md`): **separate the admitter from the
      prize-holder** so the initiator (currently admitter + prize-holder in one) can't censor
      the entry set; escrow/contract custody instead of the trusted initiator wallet; a VDF (Verifiable Delay
      Function) or threshold scheme to remove the last-revealer abort; legal review (a paid game
      of chance is a lottery). Also: k-winners/tiered prizes (`raffleDraw` returns the full
      ranking, so the top-k of the winner walk are the winners).

### Future features / ideas

- [ ] **Bitcoin on-chain payments via `OP_RETURN`.** Add BTC alongside Tron (WDK already has
      `wdk-wallet-btc`). The burn/attestation model ports directly: instead of the Tron memo,
      commit `hyperwave:<waveId>:<peerId>[:<commit>]` in an **`OP_RETURN`** output (≤ 80 bytes —
      the raffle commit is 32B, fits with the ids trimmed/hashed). "Burn" = an output to a
      provably-unspendable script (`OP_RETURN` itself is unspendable, or a known burn address);
      `verifyBurnTx` becomes a chain-specific check of the tx's outputs + `OP_RETURN` data.
      Keep the ring-key attestation chain-agnostic; make the verifier pluggable per chain.
- [ ] **Bloom filter to minimize selfie re-use.** A peer can re-post the same image across
      waves (or lift someone else's). Maintain a space-efficient bloom filter of seen
      selfie-image hashes (per-peer, and/or gossiped) and reject a `wave-selfie`
      whose image hash is probably-already-seen — cheap "have I seen this image?" at scale
      without storing every hash. False positives (rare) just ask the peer to re-shoot; no false
      negatives. Complements the per-entry byte cap + one-per-peer dedup (bounds _content_ reuse,
      not just count). Pairs well with a lightweight perceptual hash to catch near-duplicates.

### Remaining hardening (scalable-topology §8)

- [ ] Validate Chord convergence under real large-N churn (can't force a partial mesh
      locally; needs a real >mesh-limit deployment)
- [ ] Clean seam switch: forward via `successor-list[0]` instead of full-ring
      `nextClockwise` (works today via pin coupling; unverified at partial-neighbourhood scale)
- [ ] `add-writer` admission across a partial mesh (currently one-hop; fine while the
      wave initiator is well-connected)
- [ ] Measure gallery replication lag at depth

### Demo polish / wow factor

- [ ] World map with flags lighting up as selfies arrive (final-idea wow factor)
- [ ] "Past waves" browser (would need galleries to persist across runs — currently a wave
      initiator only retains its own wave's gallery in-run)
- [ ] Tipping UX polish (a "you were tipped" toast for the recipient)

### Housekeeping

- [ ] Surface `wave-unpaid` / `join-blocked` more visibly in the UI (currently status line)
- [ ] Configurable fee/tip amounts (constants in `fees.js` / renderer)
