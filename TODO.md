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
      gossip (O(N) `peers` snapshot → `pointers` exchange, neighbour-scoped `presence`)
- [x] Control-plane flooding: `wave-announce/join/start/end` relayed with `mid` dedup
      (`flood.js` + partial-topology reach harness `flood.test.js`)
- [x] Distributed `findSuccessor` routing (`find-succ` RPC) — correct under partial
      membership knowledge (64-node sim ≤5 hops); join-time placement + periodic repair
- [x] Gallery over a partial mesh: transitive replication proven (line topology, no swarm);
      **validator/seed role** retains every gallery + is pinned as a hub (persistence)

### Payment layer (WDK, Tron Nile testnet, native TRX) — functionally complete
- [x] Self-custodial wallet per instance (`pay.js`; seed persists at `<storage>/wallet.seed`);
      💰 chip in the renderer. WDK is ESM-only → CJS worker bridges via dynamic `import()`
- [x] Gallery tipping: `wave-selfie` carries the poster's address; 💵 Tip → real transfer
- [x] `wave-proof` receipt collection: every holder pushes its hop receipt to connected
      validators; `chainProofs(waveId)` = the ordered chain (relayers included)
- [x] Participation fees **burned** to Tron's black hole (kick-off + join, 1 TRX each) —
      skin in the game with no beneficiary
- [x] Provable burns: on-chain memo `hyperwave:<waveId>:<peerId>` + ring-key `burn-proof`
      attestation in the gallery (protocol.md §9)
- [x] Paid-wave anti-spam gate: no announce until the kick-off burn is on-chain; peers
      ignore unproven announces and verify the burn before joining/paying
- [x] Interlocked payout: validator walks `longestValidChain`, pays the golden rule
      (`payableFromChain` — longest valid prefix; last hop only on completion) to each
      hop's on-chain address; verified with real transfers on Nile
- [x] Bare/pear-runtime compat: `postinstall` normalizes dep `engines` ranges Bare's
      semver can't parse (`scripts/fix-bare-engines.js`)

## Backlog

### Propagation at extreme scale (Phase 5 — decision deferred)
Serial token is O(N·dwell) — hours at N=10k. The designed alternative is the
**deterministic angular sweep** (each peer self-triggers from `(startTime, speed)`;
independent proofs; pairs with fixed-per-participant payout). Decision deliberately
parked — the serial interlocked token is the product for now (small/medium waves).
See `docs/scalable-topology.md` §3B/§8.

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
- [ ] Validator log panel in the GUI (proofs collected, chain walk, payouts)
- [ ] "Past waves" browser (validator retains galleries; peers could browse them)
- [ ] Nicer payout UX for participants (a "you earned 2 TRX" toast — today only the
      validator sees payout events; participants just see their balance change)

### Housekeeping
- [ ] Surface `wave-unpaid` / `join-blocked` more visibly in the UI (currently status line)
- [ ] Configurable fee/reward amounts (constants in `hyperwave.js` / `wave.js`)
