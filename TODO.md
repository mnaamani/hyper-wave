# HyperWave — task list

Refinement backlog, roughly prioritized. Design context in `apps/docs/idea.md`;
engine spec in `packages/hyperwave-engine/docs/protocol.md`, app docs in `apps/docs/`; demo script in `DEMO.md`.

## Done

### Core wave engine + UI

- [x] Code structure: engine split into `ring.js` / `token.js` / `gallery.js` (+ later
      `chord.js` / `flood.js` / `wallet.js`) with the `wave.js` orchestrator
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
- [x] **Persistent peer identity across runs.** The swarm keypair is derived from a seed
      persisted at `<storage>/swarm.seed` (`loadOrCreateSwarmSeed` in `wave.js`, passed as
      Hyperswarm's `keyPair`) — the peer id, ring **seat**, and receipt/burn signing key are
      now stable across restarts (before, `new Hyperswarm()` minted a fresh Noise keypair each
      run). Independent of `wallet.seed` for **key isolation** (a leaked wallet seed shouldn't
      also compromise the ring identity) — _not_ unlinkability: a fee burn already ties the wallet
      address to the `peerId` on-chain via its `hyperwave:<waveId>:<peerId>` memo. A host may
      inject a hex seed (mobile secure storage) — used verbatim, never written. A missing/corrupt
      file regenerates rather than bricking startup. Suite: `swarm.seed.test.js`.

### Scalable topology (Chord over Hyperswarm — since simplified away entirely)

- [x] Phase 1: ring membership seeded from DHT discovery (`swarm.peers`), liveness-gated
      (no phantom seats from stale announces)
- [x] Phase 2: `joinPeer` pinning of successor-list (k=3) + predecessor — ring edges physical
- [x] Phase 3: finger table + `findSuccessor` + `fixFingers` → O(log N) connections
- [x] Phase 4: stabilize + churn handling (re-pin on close, churn cooldown) + slim
      gossip (O(N) `peers` snapshot → a single neighbour-scoped `pointers` heartbeat)
- [x] Control-plane flooding: `wave-announce/join/start/end` relayed with `mid` dedup
      (`flood.js` + partial-topology reach harness `flood.test.js`)
- [x] Distributed `findSuccessor` routing (`find-succ` RPC) — correct under partial
      membership knowledge (64-node sim ≤5 hops); join-time placement + periodic repair
- [x] Gallery over a partial mesh: transitive replication proven (line topology, no swarm);
      the wave **initiator** retains its own wave's gallery (per-wave persistence — no peer
      roles, no dedicated archivist hub)
- [x] **Batch gallery admission at lobby close** (sweep Phase 1): `wave-join` carries the
      joiner's writer key + signed **join attestation** (`attest.js signJoin`) + burn; the
      initiator validates and batch-appends every `add-writer` op (`admitRoster`) before
      `wave-start` — admission rides the bootstrap core sync everyone needs anyway. The
      reactive `add-writer` flood + retry storm + `apply()`'s receipt gate are deleted
      (the write-gate is now the join attestation). Killed the two measured 128-peer scale
      failures: the O(N) mid-race admission funnel and the fresh-`mid` re-flood storm.
- [x] **The deterministic sweep replaces the token walk** (sweep Phases 2+3):
      `wave-start` carries `t0` + `lapMs`; every roster peer derives the identical
      angle-ordered schedule (`sweep.js`) and self-triggers at its own slot; the ball is
      rendered from the schedule (no `wave-pos`); the wave ends deterministically at
      `t0 + lapMs + grace` on every peer (no `wave-end`). Deleted: token race, healing,
      receipts + chain accumulator (`token.js` → `attest.js`), `pickReachable`. Wire
      protocol 10 → 7 message kinds; wall-clock is a chosen constant regardless of N; a
      live roster member can no longer be silently skipped.
- [x] **128-peer scale campaign: seven bugs found+fixed by instrumented runs (2026-07-13).**
      (1) a receiver's lobby-timeout blacklisted the wave, so a late `wave-start` could
      never be adopted — lobby-timeout is now revivable; (2) the initiator ran the batch
      admission BETWEEN lobby close and the start flood, delaying the start past every
      receiver's fallback — the start now floods first; (3) admission was O(roster)
      awaited appends (measured 277s at 127 writers, ~2.2s each, starving every poster's
      writable-wait) — now ONE batched array append (0.6s); (4) the start trigger gated
      on live connections, whose equilibrium (~46 with the pins ÷4 dial squeeze) sat at
      the old 48 threshold — hosts now gate on the DHT-discovered count (new `discovered`
      field in onState); (5) re-adopting a wave after a revivable timeout lost the
      peer's joined flag + joinSig (its slot never armed) — join state is now memoized
      and restored; (6) a credential-less `wave-join` took a roster seat (and sweep
      slot) it could never fill, making full convergence unreachable by construction —
      joins now only count WITH a credential, and `credentials()` gets the rest of the
      lobby to resolve; (7) joins arriving after lobby close still grew the roster past
      the frozen schedule — joins now count only during the lobby. Plus e2e calibration:
      scale START_TARGET 48→32 (local discovery plateaus ~40-60/node), convergence
      budgets scaled ×2-3 for the 16-peers-per-core environment.
- [x] **Random-K pins replace the structured ring; `chord.js` deleted.** With the sweep,
      nothing consumes successor/predecessor — pinning's only job is a flood-graph floor
      the transport can't bias (pins dial with priority + bypass `maxPeers`). Harness at
      N=128 (real Flood, 200 graphs/config, ±10% kills): random K=7 = 100% reach in every
      trial and better diameter than the ring (4 rounds vs 4.9–6); cliff at K≤3. Now:
      `PIN_BUDGET = 7` sticky random pins (`pins.js` `topUpPins` — keep live pins, top up
      on churn, never reshuffle), `chord.js` + its suite deleted (~300 lines). Downside
      (accepted): connectivity is probabilistic, not proven; escape hatch = raise
      `PIN_BUDGET` or resurrect the ring rule from git history. **Superseded (2026-07-14):
      the no-pinning endgame was taken — pinning was removed entirely (see below).**
- [x] **Topology diet for the sweep** (sweep Phase 4): deleted `chord-routing.js` (the
      distributed `find-succ` RPC/placement/repair — successor _precision_ is unneeded;
      only flood connectivity matters); `pinTargets` now pins successor-list (k=3) +
      predecessor + the **capped far fingers** (`FAR_FINGERS`=3 longest edges) → constant
      pin budget ≈7; flood dedup evicts **oldest-first** instead of wholesale-clearing.
- [x] **Peer pinning removed entirely (2026-07-14).** The final simplification step:
      `pins.js` + `topUpPins` + `maintainNeighbours` + the pin/churn-cooldown bookkeeping
      in `PeerTable` + the `pinBudget` option / `HYPERWAVE_PIN_BUDGET` knob are all
      deleted. The topology is now just Hyperswarm's incidental topic mesh (degree ≈
      `maxPeers`); the flood rides it unaided. Justified by the pins-off 128-peer run
      (full lobby gathered over the local DHT with pinning disabled) and the 8-peer e2e
      (convergence + mid-race kills) passing without pins. Accepted trade-off: flood
      connectivity is entirely the transport's mesh quality — if a real deployment shows
      ragged flood reach, resurrect `pins.js` + its wiring from git history.

### Payment layer (WDK, Tron Nile testnet, native TRX) — burned fees + tips, no rewards

- [x] Self-custodial wallet per instance (`wallet.js`; seed persists at `<storage>/wallet.seed`);
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
      admitter). The burn is verified where it pays off: by tippers via `burnTx`. Spam bounded by one-entry-per-peer + a byte-size cap
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
      initiator**: it retains its own wave's gallery (archivist for that wave only). Accepted:
      a gallery is lost if its initiator goes offline; nothing persists across runs.
- [x] Bare/pear-runtime compat: `postinstall` normalizes dep `engines` ranges Bare's
      semver can't parse (`scripts/fix-bare-engines.js`)
- [x] **End-to-end integration tests** (`app/e2e/`): a Node+brittle harness spawns a local DHT + N real `wave.run.js` peers and drives full waves, asserting on the protocol's structured
      event stream (poll-until-event, no sleeps; process-group teardown). Local suite (no wallet
      / no on-chain, deterministic): 8-peer gallery convergence, self-healing under 2 mid-race
      kills. `npm run test:e2e:local`; runs in GitHub Actions
      (`.github/workflows/ci.yml`) alongside unit tests. **On-chain tier** (`wave.onchain.e2e.js`,
      `npm run test:e2e:onchain`): enforced wave on Nile — paid gate → real kick-off/join burns →
      on-chain kick-off verification → optimistic admission. Gated on funded-wallet secrets, runs manual/nightly
      (`.github/workflows/e2e-onchain.yml`). Verified live (8/8 asserts, ~38s).

### Adversarial hardening (against a modified client) — `packages/hyperwave-engine/docs/protocol.md` §11.2

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

### Dependency watch

- [ ] **Unpin hyperdht (root `package.json` overrides → `6.32.0`) once upstream fixes the
      loopback/testnet regression.** hyperdht 6.33.0 reworked the LAN/relay connection lifecycle
      (upstream PRs #251/#259/#266/#272) and broke the `@hyperswarm/testnet` local-DHT scenario the
      e2e suite runs on: flaky announce/lookup (peers vary wildly per run), heavy connection churn,
      and silently-dead pipes that drop token hops. Public-DHT behaviour is unaffected. Verified
      A/B on one machine (6.33.0 local: FAIL; 6.32.0 local: PASS 2/2 twice, ~21s convergence;
      6.33.0 public: PASS). To re-test a new release: remove the override, `npm install`, run
      `npm run test:e2e:local` a few times. Related knobs added during the hunt: `E2E_PUBLIC=1`
      (run the suite over the public DHT — CI now runs BOTH modes so a local-only failure points
      at testnet/loopback networking and a both-red failure points at the protocol),
      `E2E_DUMP=<dir>` (write each peer's full log on a failed run). CI's two e2e steps still
      carry a temporary `continue-on-error` — drop it after a few green runs.

### Propagation at extreme scale (Phase 5 — DECIDED: the sweep is built)

The deterministic angular sweep replaced the serial token entirely (see the Done
section above and `packages/hyperwave-engine/docs/protocol.md` §6). Remaining scale work:

- [x] **Duplicate `roster` field dropped from the wire (2026-07-14).** `wave-start`/`wave-sync`
      no longer carry a `roster` array — it was always the same set as `{by} ∪ writers[].peerId`,
      so every receiver now derives the canonical roster from the `writers` credentials
      (`canonicalRoster` in `wave.js`). The local `wave.roster` set is gone too: the `writers`
      map IS the roster (a participant without a credential can't fill a sweep slot — counting
      anything else was the source of two 128-peer scale bugs).
- [ ] **`writers` still scales O(N) — `wave-start`/`wave-sync` get huge for very large waves.**
      Each entry is ~200 bytes of JSON (hex peerId + writerKey + joinSig), carried in a
      **single** `compact-encoding` `string` frame every peer must buffer, parse, and re-flood:
      ~200KB at N=1k. Unlike the deleted `roster`, this payload is irreducible in kind — every
      peer genuinely needs every credential to open every gallery core. Options if waves grow:
      (1) **raw-byte fields** instead of hex (halves it — folds into the compact-encoding
      backlog item); (2) **cap roster size** per wave (bounded product decision) and/or chunk
      `writers` across frames; (3) rely on `wave-join` floods for credential spread and let
      `wave-start` carry only ids the receiver back-fills (loses self-containedness — a start
      adopter would need a follow-up sync). Measure before doing any of it.

### Adversarial hardening still open (`packages/hyperwave-engine/docs/protocol.md` §11.3)

- [ ] **Automated coverage for the paid gate (currently a test gap).** The
      burn/attestation path — `enforcePaid`, `recordBurn`, `validKickoff`/`verifyKickoff`,
      the per-peer `burnAuthorizes` check on `wave-join` ingest — has **no automated test
      with a wallet**: the unit suites don't wire a wallet and the `e2e/` harness runs
      wallet-less (`enforcePaid` off, join-attestation-only ingest), so this path is
      exercised only by the manual/nightly on-chain e2e tier and two-peer runs. A fast wave
      can end before a joiner's fee burn confirms, and the burn proof must survive that
      (`recordBurn` accepts a late burn for its own waveId; the proof survives `goIdle` and
      is cleared only in `enterLobby`). Add a **wallet-mocked engine test** (stub `payments`
      with a controllable `burn`/`verifyBurnTx` whose confirmation can be delayed past wave
      completion) asserting: (a) a joiner whose burn confirms mid-lobby re-floods its join
      and gets seated; (b) an enforcing peer ignores a burn-less join and an unpaid
      announce; (c) a stale burn for a superseded wave is dropped (the `recordBurn` guard);
      (d) a burn confirming after the wave ends still binds the tip address on the posted
      entry. Optionally extend `e2e/` with a mock-payments mode so the paid gate gets
      end-to-end coverage too.
- [ ] **Reject a wave whose kick-off burn is stale (replay-attack prevention).** `shouldAdopt()`
      only refuses a `waveId` already in `endedWaves`, and `validKickoff()` checks the burn
      attestation's `reason`/`waveId`/`peerId`/signature but **not its age**. So an attacker can
      **replay a captured, still-validly-signed `wave-announce`** later: a peer that never saw the
      original end (a freshly joined or **restarted** peer has an empty `endedWaves`) will adopt the
      stale wave, since the signed kick-off proof still verifies. Fix: enforce a **freshness
      window** on adoption. The burn attestation already carries a **signed `burnTs`** (part of
      `burnHash`, so it can't be back-dated without the initiator's key) — reject a kick-off whose
      `burnTs` is older than a bound (`MAX_KICKOFF_AGE_MS`, e.g. a few minutes) in `validKickoff`
      /`shouldAdopt`. For a stronger, unforgeable anchor, gate on the **on-chain tx timestamp**
      via `verifyBurnTx` (already fetched at the paid-gate verify step) rather than the
      self-reported `burnTs`. Allow generous clock-skew (peers aren't synchronized). Ties into the
      envelope `ts` item (§5.0) — a per-message timestamp would let the same freshness check apply
      to every flooded message, not just the kick-off.
- [ ] Per-connection rate limiting (token buckets per message kind) + bounds on the
      auxiliary sets (the flood `seen` set is capped; `endedWaves` grows unbounded over a
      long session). A gallery seat costs only a signature check, so the rate limit caps
      how many `wave-join` floods one connection can push. (Per-entry byte cap already
      done.)
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
- [ ] **Uniform gossip message envelope: `origin` + `sig` + `ts` on every message.** Today the
      originator field is named inconsistently across kinds — `peerId` (`wave-join`),
      `by` (`wave-announce`/`wave-start`/`wave-sync`), `id` (`heartbeat`) — and only
      some messages carry a signature. Standardize a common envelope on **every** gossip message:
      (1) **`origin`** — one convention everywhere for who authored the message (replace
      `peerId`/`by`/`holder`/`id`); (2) **`sig`** — an Ed25519 signature by `origin`'s ring key
      covering **all** fields (canonical serialization of the whole message minus `sig`), so any
      relay/recipient can verify authenticity and the identity binding (§11.2) becomes a single
      shared check instead of per-kind ad-hoc; (3) **`ts`** — the origin timestamp, so relays can
      make **age-based drop decisions** (reject/stop relaying a message older than a max-lifetime
      bound). The `ts` is the real defence: it's a hard cap on how long any flooded message can
      circulate, so a routing loop or a dedup-set bug can't turn into an unbounded flooding
      amplification — a message simply dies once it's older than the TTL regardless of `mid`
      dedup state. Note the trade-offs: `ts` needs loose clock-skew tolerance (peers aren't
      synchronized — allow a generous window), and signing every message adds a verify on the
      hot path (the heartbeat fires every `HEARTBEAT_MS` per connection) — pair with the
      compact-encoding item (raw-byte sig) and per-connection rate limiting above. **Schema
      documented** in `packages/hyperwave-engine/docs/protocol.md` §5.0 (marked planned); implementation still to do.
- [ ] **Harden `pay.send` to report failed transactions** (`wallet.js`). The returned `hash` is the
      txID computed client-side from the signed bytes (`sha256(raw_data)`), so `send` resolves
      `{ hash }` even when the broadcast is rejected or the tx later fails on-chain — e.g. sending
      from an **unfunded** wallet (`WALLET_SEND` via `wave.run.js`) prints `WALLET SENT ... hash=`
      with no error. Check the broadcast result (`res.result`/`code`/`message`) and/or confirm via
      `getTransaction`/`getTransactionInfo` (as `verifyBurnTx` already does) and throw/return a
      failure so the `fund` flow surfaces insufficient-balance instead of a misleading success.

### Future features / ideas

- [ ] **Typed RPC seam between renderer/host and worker (`hyperschema` + `bare-rpc`).** The
      renderer↔worker IPC today is hand-rolled and one-directional in both halves: the host sends
      **fire-and-forget commands** (`exec` in `engine.js`: `start-wave`, `join-wave`,
      `stage-selfie`, `tip`, `refresh-wallet` — no reply), and the worker pushes a **stream of
      untyped `type`-tagged events** back (`onEvent → notify({type:'event', …})`, plus one-offs like
      `wallet`, `tip-result`, `burn-result`). Request/response is **faked by correlation** — e.g. a
      `tip` command is matched to a later `tip-result` event by its `to` field — which is fragile
      (no request id, races if two tips share a `to`), and there's no schema, so a typo'd field or a
      shape drift between the desktop renderer and the RN worklet fails silently. Adopt the **typed
      RPC seam** from Pears' bare-on-native guide (https://docs.pears.com/explanation/bare-on-native/#the-typed-rpc-seam):
      define the message shapes once in a **`hyperschema`** and speak **`bare-rpc`** over the
      existing worker pipe, giving (1) real **request/response** methods (`await tip(...)` resolves
      with the result or throws — no `tip-result` correlation dance), (2) a typed **events/
      notification** channel for the genuinely one-way stream (ring/position/wave-state pushes), and
      (3) a **single source of truth** for the wire shapes shared by `engine.js`, the desktop
      renderer, and the mobile worklet (kills the "same message shapes both hosts speak" comment
      that's currently enforced only by convention). Cleans up the renderer command handlers
      (`app.js`) and the RN `useEngine.js` symmetrically. Scope note: it's an **internal app IPC**
      seam (Appendix A), not the on-wire gossip protocol — orthogonal to the §5 gossip envelope
      work, though both move toward schema'd messages. Check the encoding fit under Bare (both
      modules are Holepunch-native, so they should run in the worker; the desktop side crosses the
      Electron main↔renderer bridge too — verify bare-rpc rides that or wrap it).
- [ ] **Secure seed storage on desktop (OS keychain via Electron `safeStorage`).** Today
      `wallet.seed` + `swarm.seed` are **plaintext files**; file permissions only stop other OS
      users, not disk theft / backups / casual inspection. Move desktop secret storage to the OS
      keychain: Electron **main** owns `safeStorage` (encrypt-at-rest, key in Keychain/DPAPI/
      libsecret) and **injects** the decrypted seeds into the Bare worker over the IPC pipe (not
      argv/env) — reusing the injection seam mobile already uses (`createPayments({ seed })`,
      `createWave({ swarmSeed })`, both used-verbatim-never-written). Requires making the desktop
      worker **init-message-driven** (like `worklet/app.js`) and a `config.swarmSeed` passthrough in
      `engine.js`; the engine's plaintext files stay as the headless/dev fallback. Handle the Linux
      `basic_text` fallback (warn, don't imply false security) + plaintext→`.enc` migration. Honest
      ceiling: protects at-rest / cross-user, **not** same-user malware (needs a signed build +
      keychain ACL, ultimately hardware wallet). Low urgency (testnet, no real value) but the right
      foundation for mainnet. **Full design: [`apps/docs/secure-seed-storage.md`](apps/docs/secure-seed-storage.md).**
- [ ] **Bitcoin on-chain payments via `OP_RETURN`.** Add BTC alongside Tron (WDK already has
      `wdk-wallet-btc`). The burn/attestation model ports directly: instead of the Tron memo,
      commit `hyperwave:<waveId>:<peerId>` in an **`OP_RETURN`** output (≤ 80 bytes, with the
      ids trimmed/hashed as needed). "Burn" = an output to a
      provably-unspendable script (`OP_RETURN` itself is unspendable, or a known burn address);
      `verifyBurnTx` becomes a chain-specific check of the tx's outputs + `OP_RETURN` data.
      Keep the ring-key attestation chain-agnostic; make the verifier pluggable per chain.
- [ ] **More compact wire encoding for gossip messages.** Today every gossip message is
      `JSON.stringify`'d over a single `compact-encoding` `string` Protomux frame (the
      "one wire encoding (JSON)" design rule — chosen for debuggability + zero schema ceremony at
      MVP speed). JSON is verbose: hex-string ids/sigs/hashes are 2× their bytes, field names
      repeat on every message, and the `heartbeat` (every `HEARTBEAT_MS` per connection) is the
      steady-state bandwidth floor — so a tighter codec mostly pays off there and on the
      O(N) `writers` payload of `wave-start`/`wave-sync`. Options: **protobuf** (mature, cross-language, but
      needs `.proto` + a codegen step), **SCALE** (Polkadot's — compact, no field tags, but
      schema-position-coupled and JS tooling is thinner), or **staying in the Holepunch stack with
      `compact-encoding`** (already a dep; hand-write per-message struct encoders — binary ids/sigs
      as raw 32/64B buffers instead of hex, enum `kind` byte). Likely the best fit: it's already
      the frame layer, avoids a new dependency/codegen, and the win is mostly from raw-byte
      ids/sigs. Keep JSON available behind a version byte for debug/interop. Measure first — the
      lifecycle floods are infrequent; the real target is the heartbeat + `writers` at scale.
- [ ] **Bloom filter to minimize selfie re-use.** A peer can re-post the same image across
      waves (or lift someone else's). Maintain a space-efficient bloom filter of seen
      selfie-image hashes (per-peer, and/or gossiped) and reject a `wave-entry`
      whose image hash is probably-already-seen — cheap "have I seen this image?" at scale
      without storing every hash. False positives (rare) just ask the peer to re-shoot; no false
      negatives. Complements the per-entry byte cap + one-per-peer dedup (bounds _content_ reuse,
      not just count). Pairs well with a lightweight perceptual hash to catch near-duplicates.
- [ ] **Downvote / report mechanism for objectionable (e.g. NSFW) selfies.** A `wave-entry` is
      an inline image any admitted participant can post, so a peer could post something NSFW or
      abusive. Add a **report/downvote** signal that propagates so each peer can **choose not to
      display** a flagged entry (client-side moderation, not censorship — the entry stays in the
      log; hiding it is a local decision). Design: a signed `downvote` op appended to the
      reporter's own per-wave gallery core (block 1+ — would need relaxing the block-0-only
      download for tiny non-image ops), referencing the target entry (`waveId` + `peerId`, or its
      image hash), **join-attested + one-per-reporter** exactly like a selfie (so `mergeGallery`
      tallies at most one downvote per reporter — a sybil can't brigade, and the whole tally is
      deterministic + replicated so every peer converges on the same counts). The renderer hides
      an entry whose downvote count crosses a threshold (with a per-user "show anyway" toggle, and
      a default that errs toward hiding). Prefer a gallery-core op over gossip so counts persist
      with the gallery and converge; keep the report bytes tiny (no image). Pairs with the perceptual-hash / bloom
      item (auto-detection) — this is the human-report half. Note the moderation is inherently
      subjective + decentralized: it's advisory per-peer, not a global takedown.

### Remaining hardening (scale validation)

- [x] **Gallery-as-CRDT: DONE (2026-07-14, commits cd7f6e0 + 7d9b271).** Dropped the
      single Autobase indexer for a multicore CRDT gallery — removes the O(N) funnel + the
      live SPOF. Each participant owns one Hypercore (key rides its wave-join, self-certified
      by the join attestation); every peer merges the set locally (mergeGallery); no indexer,
      no admission, no shared gallery key. wave-start/wave-sync carry the full writers set so
      late adopters are self-contained. 8-peer e2e green; 128-peer re-validation still
      pending. Original analysis kept below.

- [ ] **(historical) Gallery-as-CRDT design notes.** The gallery's displayed output (`buildGallery`) is a pure
      function of the entry _set_ — dedupe by peerId, sort by rank — and never uses
      Autobase's linearization ORDER. So the gallery is a conflict-free replicated data
      type (a peerId→entry LWW-map): each entry is self-authenticating (join attestation),
      self-ordering (rank), idempotent (one per peer), and commutative. The single indexer
      (the wave initiator, `gallery.js`) exists only to produce a total order we compute
      and discard — and it's the O(N) fan-in/out bottleneck (~0.3 entries/s at 128 on an
      oversubscribed box) AND a live SPOF (initiator dies mid-wave → nobody can advance the
      indexed view). K-archivist retention (DONE) mitigates the _post-wave_ archival SPOF
      but not this. Real fix: replace the Autobase gallery with N per-participant Hypercores
      in a shared Corestore namespace — each peer posts to its own core, everyone replicates
      the cores they can reach (writer keys are ALREADY flooded on `wave-join`, so key
      distribution is solved) and merges via `buildGallery` over the union. No indexer, no
      quorum, no leader, no funnel; convergence becomes epidemic ("have I replicated core
      X"). Costs: a real rewrite of `gallery.js` + `gallery-session.js` (~600 lines), and
      re-proving that raw multi-core corestore replication spreads as well as Autobase's
      over a real partial mesh (validate with a flood-harness-style sim BEFORE committing —
      that's the load-bearing assumption). The committee/k-of-n-indexer alternative was
      considered and rejected: it re-introduces the quorum-stall the single indexer
      deliberately escaped, for only partial relief (Autobase's multi-indexer needs a
      strict MAJORITY of indexers reachable — `consensus.js: (n>>>1)+1` — to advance the
      indexed view; single-indexer is majority-of-1, trivially met).
      **De-risked (2026-07-14) — the A/B replication bench** (since deleted along with the
      whole Autobase baseline + the `autobase` dep, its job done — git history has it) compared both
      strategies over the SAME synthetic partial mesh (real Corestore/Autobase/Hypercore,
      degree-capped graph = maxPeers). Measured N=64, degree=16: both reach 64/64, but
      the multicore CRDT converges in ~13.3s vs the single-indexer Autobase's ~18.4s
      (~28% faster, and that excludes the ~1s admission the Autobase path also pays) —
      the N-core replication overhead did NOT prevent or slow convergence; it was faster,
      with no SPOF. Load-bearing finding baked into the harness: each node must ACTIVELY
      `core.download()` every gallery core — the log LENGTH propagates for free but the
      block DATA only arrives when requested (a length-only convergence check is
      over-optimistic; the real design must drive downloads). Corestore-with-large-N is
      also far cheaper than the old model: corestore 7 / hypercore-storage 3.x use ONE
      shared RocksDB backend, not a file-set per core. Caveat: the bench is in-process
      (no WAN latency) — the real-swarm absolute-latency complement is the
      HYPERWAVE_MAX_PEERS-limited e2e (knob now plumbed; run E2E_MAX_PEERS=16 E2E_PEERS=64).

- [ ] **128-peer scale validation — DONE locally (2026-07-13); public-DHT variant needs
      multi-machine.** The local-testnet 128-peer run now PASSES end-to-end (130/130
      asserts: 102-peer lobby, batch admission in ~0.6-3s, sweep completed on schedule,
      ALL 128 peers — roster members and spectators — converged to the full gallery in
      ~10 min wall-clock on an 8-core box running all 128 peers). The campaign found and
      fixed seven real scale bugs (see the Done entry). Still open here:
      (a) the PUBLIC-DHT variant is impossible from one home IP (128 same-IP peers
      managed 6 connections in 9 min — NAT hairpin/conntrack/per-IP DHT limits; needs
      peers spread across real machines, e.g. a cloud dispatch); (b) a clean 128-peer
      convergence run on the now-pinless build (pins-off DID gather a full 128-peer
      lobby over the local DHT before removal, but a full-convergence run on the final
      build hasn't happened); (c) churn-during-sweep at scale untested.
- [ ] Measure gallery replication lag at depth
- [ ] **Late/reactive admission fallback (deliberately dropped).** A peer whose join
      misses the lobby window is a spectator — the reactive `add-writer` path was
      deleted with the sweep. Re-add a (backoff-limited) flooded admission request only
      if late posting turns out to matter for the product.

### Demo polish / wow factor

- [ ] World map with flags lighting up as selfies arrive (the original design's wow factor)
- [ ] "Past waves" browser (would need galleries to persist across runs — currently a wave
      initiator only retains its own wave's gallery in-run)
- [ ] Tipping UX polish (a "you were tipped" toast for the recipient)

### Housekeeping

- [ ] Surface `wave-unpaid` / `join-blocked` more visibly in the UI (currently status line)
- [ ] Configurable fee/tip amounts (constants in `wallet.js` / renderer)
