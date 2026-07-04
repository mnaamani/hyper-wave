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
- [x] Resilience / healing: forward to the next *reachable* peer; `wave-pos` = ACK; skip a
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
      **validator/seed role** retains every gallery + is pinned as a hub (persistence)

### Payment layer (WDK, Tron Nile testnet, native TRX) — burned fees + tips, no rewards
- [x] Self-custodial wallet per instance (`pay.js`; seed persists at `<storage>/wallet.seed`);
      💰 chip in the renderer. WDK is ESM-only → CJS worker bridges via dynamic `import()`
- [x] Gallery tipping: `wave-selfie` carries the poster's address; 💵 Tip → real transfer.
      **The only way to make money** — there are no sponsor rewards.
- [x] Participation fees **burned** to Tron's black hole (kick-off + join, 1 TRX each) —
      skin in the game with no beneficiary; on-chain memo `hyperwave:<waveId>:<peerId>`
- [x] Paid-wave anti-spam gate: no announce until the kick-off burn is on-chain (carried as
      the signed `paid` proof); peers ignore unproven announces and verify before joining
- [x] **Burn-gated gallery admission**: `add-writer` carries the join burn attestation; the
      admitter runs `burnAuthorizes` + verifies the burn on-chain before granting write access
      — a gallery seat requires a real burn, so every tippable selfie is from a peer who paid
      in (bounds the gallery to one entry per burn). Verified live end-to-end on Nile.
- [x] **Signed gallery key**: originator signs `(waveId, autobaseKey)` (`signGalleryKey`);
      peers verify before opening — a relay can't swap the unsigned key to a rogue Autobase
- [x] **Tip address bound to the burn**: `apply()` keeps a selfie's tip `address` only if a
      signed burn names that wallet — a tip always reaches the wallet that paid in (§8.2)
- [x] **One gallery entry per peer at write** (`apply()` dedup) — a paid seat can't bloat the
      log with unbounded self-signed entries (was display-only dedup before)
- [x] **Sponsor rewards removed** (simplification): dropped the interlocked payout, the
      `wave-proof` receipt collection, the golden-rule chain-walk (`longestValidChain` /
      `payableFromChain`), and the gallery `burn-proof` op. The validator role is now purely
      a gallery archivist. Kills the sybil-payout risk class outright (nothing to steal).
- [x] Bare/pear-runtime compat: `postinstall` normalizes dep `engines` ranges Bare's
      semver can't parse (`scripts/fix-bare-engines.js`)

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
- [ ] Per-connection rate limiting (token buckets per message kind) + a byte-size cap on the
      inline selfie `image` + bounds on auxiliary maps (`seen`/`endedWaves`/`routed`/
      `lookupRoute`/`goneUntil`). (Gallery entry *count* is already bounded — one per burn.)
- [ ] Byzantine admitter: burn-gated admission is enforced by the admitting writer, so a
      malicious *already-admitted* writer could admit a non-payer. Fine while admissions route
      through the originator/seed; harden with quorum admission or proof-in-the-op if needed.

### Remaining hardening (scalable-topology §8)
- [ ] Validate Chord convergence under real large-N churn (can't force a partial mesh
      locally; needs a real >mesh-limit deployment)
- [ ] Clean seam switch: forward via `successor-list[0]` instead of full-ring
      `nextClockwise` (works today via pin coupling; unverified at partial-neighbourhood scale)
- [ ] `add-writer` admission across a partial mesh (currently one-hop; fine while the
      originator/validator is well-connected)
- [ ] Measure gallery replication lag at depth

### Demo polish / wow factor
- [ ] World map with flags lighting up as selfies arrive (final-idea wow factor)
- [ ] "Past waves" browser (validator retains galleries; peers could browse them)
- [ ] Tipping UX polish (a "you were tipped" toast for the recipient)

### Housekeeping
- [ ] Surface `wave-unpaid` / `join-blocked` more visibly in the UI (currently status line)
- [ ] Configurable fee/tip amounts (constants in `fees.js` / renderer)
