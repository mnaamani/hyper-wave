# HyperWave — task list

Refinement backlog, roughly prioritized. Design context in `docs/idea.md`;
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
      See `docs/raffle.md` + `docs/protocol.md` §12. **MVP: initiator = admitter = prize-holder**
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

- [ ] **Roster field scales O(N) — `wave-start`/`wave-sync` get huge for large waves.** The
      `roster` is a JSON array of full 64-char hex peer ids, carried in the **flooded** `wave-start`
      (and unicast `wave-sync`). At N participants that's ~N×70 bytes of JSON: ~70KB at N=1k,
      ~700KB at N=10k — in a **single** `compact-encoding` `string` frame that every peer must
      buffer, parse, and re-flood. Large frames strain the parser, balloon flood bandwidth (O(edges
      × frame size)), and risk hitting Protomux/stream size limits. What each peer actually needs
      from the roster is narrow: **"am I in it?"** (the selfie/spectate gate, `canSelfieNow`) and a
      **count** for the UI — not the full id list. Options, roughly in effort order: (1) **raw-byte
      ids** instead of hex (halve it — folds into the compact-encoding item); (2) **cap roster
      size** per wave (bounded product decision) and/or **chunk** the roster across multiple frames;
      (3) **compressed membership** — ship a **Bloom filter** (or compact bitset) of roster ids
      instead of the list: each peer tests its own id for membership (a false positive just lets a
      non-joiner selfie, already bounded downstream by the receipt + burn gates), size is ~1.2
      bytes/entry at 1% FPR regardless of id length, and the UI count ships as a separate integer;
      (4) **drop the explicit roster entirely** and make participation **emergent** — anyone
      presenting a valid receipt + burn attestation may selfie, so the roster never travels
      (largest change; loses the pre-race "who's in" UI). Likely direction: raw-byte ids + a size
      cap now, Bloom-filter membership if waves grow past the cap. Update `docs/protocol.md` §5
      (`wave-start`/`wave-sync`) + §7.2 when chosen.

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
- [ ] Raffle production hardening (`docs/raffle.md`): **separate the admitter from the
      prize-holder** so the initiator (currently admitter + prize-holder in one) can't censor
      the entry set; escrow/contract custody instead of the trusted initiator wallet; a VDF (Verifiable Delay
      Function) or threshold scheme to remove the last-revealer abort; legal review (a paid game
      of chance is a lottery). Also: k-winners/tiered prizes (`raffleDraw` returns the full
      ranking, so the top-k of the winner walk are the winners).
- [ ] **Loop guard: a peer must never forward a token for the same `waveId` twice (wave can't
      circle past the originator).** Today the safety against a runaway loop is (a) the originator's
      completion check in `processToken` (`token.originator === me.id && hopCount > 0` → `wave-end`,
      stop) and (b) the `seen` set keyed by **`waveId|hopCount`** (a re-received _exact hop_ is
      dropped). That relies on the originator being alive and correctly recognizing its own token;
      if the originator dropped/misbehaved, a token could in principle keep advancing hopCount and
      re-entering peers (bounded only by `MAX_HOPS`). Add a stricter defensive guard: a peer
      **processes/forwards an incoming token for a given `waveId` at most once**, independent of
      `hopCount`. Simplest: track a per-wave `forwardedWave` set (or key `seen` by `waveId` for the
      forward path) and drop a second token for a `waveId` I've already relayed. **Caveat to get
      right:** the originator legitimately touches its own wave's token twice — hop 0 at kickoff
      (it originates, doesn't "receive") and again at completion (`hopCount === hops`, where it
      must still fire `wave-end`) — so the guard must exempt the completion path (or only apply to
      the _non-originator forward_ path), else it would suppress the very `wave-end` that ends the
      wave. Net effect: the wave deterministically dies after one lap even if the originator is
      gone, instead of leaning on `MAX_HOPS` as the only backstop. Clear the set per wave (as
      `seen` already is in `goIdle`). **Documented** in `docs/protocol.md` §6 (marked planned);
      implementation still to do.
- [ ] **Uniform gossip message envelope: `origin` + `sig` + `ts` on every message.** Today the
      originator field is named inconsistently across kinds — `peerId` (`add-writer`, `wave-join`),
      `by` (`wave-end`), `holder` (`wave-pos`), `id` (`pointers`), `staller` (stall) — and only
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
      hot path (`wave-pos` is emitted every hop) — pair with the compact-encoding item (raw-byte
      sig) and per-connection rate limiting above. **Schema documented** in `docs/protocol.md`
      §5.0 (marked planned); implementation still to do.
- [ ] **Harden `pay.send` to report failed transactions** (`pay.js`). The returned `hash` is the
      txID computed client-side from the signed bytes (`sha256(raw_data)`), so `send` resolves
      `{ hash }` even when the broadcast is rejected or the tx later fails on-chain — e.g. sending
      from an **unfunded** wallet (`WALLET_SEND` via `wave.run.js`) prints `WALLET SENT ... hash=`
      with no error. Check the broadcast result (`res.result`/`code`/`message`) and/or confirm via
      `getTransaction`/`getTransactionInfo` (as `verifyBurnTx` already does) and throw/return a
      failure so the `fund` flow surfaces insufficient-balance instead of a misleading success.

### Future features / ideas

- [ ] **Typed RPC seam between renderer/host and worker (`hyperschema` + `bare-rpc`).** The
      renderer↔worker IPC today is hand-rolled and one-directional in both halves: the host sends
      **fire-and-forget commands** (`onMessage` in `core.js`: `start-wave`, `join-wave`,
      `stage-selfie`, `tip`, `refresh-wallet` — no reply), and the worker pushes a **stream of
      untyped `type`-tagged events** back (`onEvent → send({type:'event', …})`, plus one-offs like
      `wallet`, `tip-result`, `burn-result`). Request/response is **faked by correlation** — e.g. a
      `tip` command is matched to a later `tip-result` event by its `to` field — which is fragile
      (no request id, races if two tips share a `to`), and there's no schema, so a typo'd field or a
      shape drift between the desktop renderer and the RN worklet fails silently. Adopt the **typed
      RPC seam** from Pears' bare-on-native guide (https://docs.pears.com/explanation/bare-on-native/#the-typed-rpc-seam):
      define the message shapes once in a **`hyperschema`** and speak **`bare-rpc`** over the
      existing worker pipe, giving (1) real **request/response** methods (`await tip(...)` resolves
      with the result or throws — no `tip-result` correlation dance), (2) a typed **events/
      notification** channel for the genuinely one-way stream (ring/position/wave-state pushes), and
      (3) a **single source of truth** for the wire shapes shared by `core.js`, the desktop
      renderer, and the mobile worklet (kills the "same message shapes both hosts speak" comment
      that's currently enforced only by convention). Cleans up the renderer command handlers
      (`app.js`) and the RN `useEngine.js` symmetrically. Scope note: it's an **internal app IPC**
      seam (Appendix A), not the on-wire gossip protocol — orthogonal to the §5 gossip envelope
      work, though both move toward schema'd messages. Check the encoding fit under Bare (both
      modules are Holepunch-native, so they should run in the worker; the desktop side crosses the
      Electron main↔renderer bridge too — verify bare-rpc rides that or wrap it).
- [ ] **Persist the peer identity (swarm keypair) across runs.** `wave.js` constructs
      `new Hyperswarm({...})` with no `keyPair`, so every run generates a fresh Noise
      keypair — the peer id, and therefore the **ring seat**, changes on every restart
      (only `wallet.seed` persists today). Fix: persist a DHT keypair seed alongside the
      wallet (e.g. `<storage>/swarm.seed` → `hyperdht.keyPair(seed)` passed as the
      Hyperswarm `keyPair` option), giving a stable seat + stable identity for burns/
      receipts across restarts. Consider the privacy trade-off of deriving it from the
      wallet seed (would publicly link wallet ↔ swarm identity — keep the seeds separate).
- [ ] **Bitcoin on-chain payments via `OP_RETURN`.** Add BTC alongside Tron (WDK already has
      `wdk-wallet-btc`). The burn/attestation model ports directly: instead of the Tron memo,
      commit `hyperwave:<waveId>:<peerId>[:<commit>]` in an **`OP_RETURN`** output (≤ 80 bytes —
      the raffle commit is 32B, fits with the ids trimmed/hashed). "Burn" = an output to a
      provably-unspendable script (`OP_RETURN` itself is unspendable, or a known burn address);
      `verifyBurnTx` becomes a chain-specific check of the tx's outputs + `OP_RETURN` data.
      Keep the ring-key attestation chain-agnostic; make the verifier pluggable per chain.
- [ ] **More compact wire encoding for gossip messages.** Today every gossip message _and_ the
      token are `JSON.stringify`'d over a single `compact-encoding` `string` Protomux frame (the
      "one wire encoding (JSON)" design rule — chosen for debuggability + zero schema ceremony at
      MVP speed). JSON is verbose: hex-string ids/sigs/hashes are 2× their bytes, field names
      repeat on every message, and the heartbeat `pointers` (succ-list + pred, every
      `HEARTBEAT_MS`) is the steady-state bandwidth floor — so a tighter codec mostly pays off
      _there_ and on high-frequency `wave-pos`. Options: **protobuf** (mature, cross-language, but
      needs `.proto` + a codegen step), **SCALE** (Polkadot's — compact, no field tags, but
      schema-position-coupled and JS tooling is thinner), or **staying in the Holepunch stack with
      `compact-encoding`** (already a dep; hand-write per-message struct encoders — binary ids/sigs
      as raw 32/64B buffers instead of hex, enum `kind` byte). Likely the best fit: it's already
      the frame layer, avoids a new dependency/codegen, and the win is mostly from raw-byte
      ids/sigs. Keep JSON available behind a version byte for debug/interop. Measure first — the
      lifecycle floods are infrequent; the real target is `pointers` + `wave-pos` at scale.
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

- [ ] World map with flags lighting up as selfies arrive (the original design's wow factor)
- [ ] "Past waves" browser (would need galleries to persist across runs — currently a wave
      initiator only retains its own wave's gallery in-run)
- [ ] Tipping UX polish (a "you were tipped" toast for the recipient)

### Housekeeping

- [ ] Surface `wave-unpaid` / `join-blocked` more visibly in the UI (currently status line)
- [ ] Configurable fee/tip amounts (constants in `fees.js` / renderer)
