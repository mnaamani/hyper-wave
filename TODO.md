# HyperWave — task list

Refinement backlog, roughly prioritized. Design context in `docs/idea.md`;
engine spec in `packages/hyperwave-engine/docs/protocol.md`, app docs in `docs/`; demo script in `DEMO.md`.

## Done

Completed work is not itemized here — the current system is described in
`CLAUDE.md` + `packages/hyperwave-engine/docs/protocol.md`, and the full
change history (the token walk → deterministic sweep, Chord → pinless mesh,
Autobase indexer → multicore CRDT gallery, sponsor-rewards + peer-roles
removal, the WDK/Cashu payment layer, the 128-peer scale campaign, adversarial
hardening §11.2, e2e tiers) is in git.

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

> **Reframed by scaling.md Phases 1–3 (2026-07-16).** The adopted answer to "large N on one
> topic" is **sharding across concurrent waves** + a subscription layer (O(subscribed) core
> budget) + scoped control gossip — NOT growing a single wave to thousands. So the O(N) `writers`
> items below matter only within one wave; the product answer to very large gatherings is many
> bounded waves, each with its full-replication feed. See `packages/hyperwave-engine/docs/scaling.md`.

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

- [~] **Automated coverage for the paid gate — PARTIALLY DONE (2026-07-16).** Done: the pure
  gate predicate `startProofValid` + the freshness/replay window (`attest.test.js`),
  `burnAuthorizes`, and the enforced START/JOIN fee ORCHESTRATION in `engine.test.js` with a
  **mocked wallet** (burn → confirm → `announcePaid`; unfunded fail-fast; join burn; burn-result
  staging). **Still open — the timing-dependent lifecycle** (needs the wave running; today
  covered only by the manual/nightly on-chain tier, since `e2e/` runs wallet-less): add a
  **wallet-mocked engine test** (stub `payments` with a `burn`/`verifyBurnTx` whose confirmation
  can be delayed past wave completion) asserting (a) a joiner whose burn confirms mid-lobby
  re-floods its join and gets seated; (b) an enforcing peer ignores a burn-less join + an unpaid
  announce; (c) a stale burn for a superseded wave is dropped (the `recordBurn` guard — the proof
  survives `goIdle`, cleared only in `enterLobby`); (d) a burn confirming after the wave ends
  still binds the tip address. Optionally add a mock-payments mode to `e2e/` for end-to-end
  coverage too.
- [x] **Reject a wave whose start burn is stale (replay-attack prevention) — DONE (2026-07-16).**
      Two layers now: (1) the uniform envelope's signed `ts` — the receive edge drops any message
      whose `ts` is older than `GOSSIP_MAX_AGE_MS` (5 min), so a captured `wave-announce` replayed
      later is dropped BEFORE adoption (its `ts` can't be refreshed without the initiator's key);
      (2) `validStartProof` also enforces a freshness window on the signed `burnTs`
      (`MAX_KICKOFF_AGE_MS`), so a still-valid old burn reused in a fresh frame is rejected too.
      Both allow generous clock-skew. The stronger on-chain-tx-timestamp anchor (below) is a
      possible future tightening.
- [ ] **(future tightening) Anchor start freshness to the on-chain tx timestamp.** The current
      freshness check trusts the self-reported (but signed) `burnTs`. For an unforgeable anchor,
      gate on the **on-chain tx timestamp** via `verifyBurnTx` (already fetched at the paid-gate
      verify step) instead. Allow generous clock-skew (peers aren't synchronized).
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
- [ ] Start verification rate: every joiner still reads the _same_ start burn on-chain
      (N reads of 1 immutable tx). Not a concentration bottleneck (distributed, 1 read/joiner)
      and trivially cacheable, but it's the last per-participant on-chain read. Left as-is (it's
      the anti-_wave_-spam gate; making it optimistic would re-open free wave-spam).
- [x] **Uniform gossip message envelope: `origin` + `sig` + `ts` on every message — DONE
      (2026-07-16).** Every message now carries the envelope (protocol.md §5.0, `attest.js`
      `signMessage`/`verifyMessage`/`stableStringify`, stamped at wave.js's `originate()` choke
      point): (1) **`origin`** replaced the per-kind `id`/`by`/`peerId` author field everywhere
      (the only surviving `by` is wave-sync's INITIATOR, distinct from the sync's sender-origin);
      (2) **`sig`** — Ed25519 by `origin` over the canonical (recursively key-sorted) message minus
      `sig`, verified on every message at the receive edge before acting/relaying, so a forgery
      can't be amplified and identity binding (§11.2) is now one shared check; (3) **`ts`** — the
      receive edge drops/never-relays a message older than `GOSSIP_MAX_AGE_MS` (5 min) or too far
      future (`CLOCK_SKEW_MS`) — the hard flood-circulation cap + replay prevention. Enabled the
      catch-up simplification (forward the initiator's stored signed announce verbatim; dropped the
      `catchup` flag). Remaining perf follow-ups (still open, below): the per-message verify on the
      heartbeat hot path pairs with the compact-encoding (raw-byte sig) + per-connection rate-limit
      items.
- [ ] **Harden `pay.send` to report failed transactions** (`wallet.js`). The returned `hash` is the
      txID computed client-side from the signed bytes (`sha256(raw_data)`), so `send` resolves
      `{ hash }` even when the broadcast is rejected or the tx later fails on-chain — e.g. sending
      from an **unfunded** wallet (`WALLET_SEND` via `wave.run.js`) prints `WALLET SENT ... hash=`
      with no error. Check the broadcast result (`res.result`/`code`/`message`) and/or confirm via
      `getTransaction`/`getTransactionInfo` (as `verifyBurnTx` already does) and throw/return a
      failure so the `fund` flow surfaces insufficient-balance instead of a misleading success.

### Future features / ideas

- [ ] **Compress the O(N) gossip messages at scale (`wave-start` / `wave-sync`).** These carry the
      full `writers` set (`{peerId, writerKey, joinSig}` per participant ≈ 256 B of hex+JSON each),
      so they grow O(N) in the roster — the one gossip kind that balloons (heartbeat/announce/join
      are tiny). If large-N ever becomes real (hundreds+ of joiners on one topic), **deflate the
      frame above a size threshold** — NOT the small/frequent kinds (heartbeat especially: gzip's
      ~18 B header + framing makes them _bigger_). Lossless deflate roughly halves the writers array
      (~256 → ~130 B/entry, the crypto-entropy floor). **Keep it lossless.** A prefix-drop scheme
      (ship only peerId prefixes; resolve `writerKey`/`joinSig` from each peer's cached `wave-join`s)
      was considered and **rejected**: it breaks the self-containment `writers` exists to provide (a
      peer that missed a join can't resolve its prefix) and prefix resolution against per-peer-
      divergent id sets is ambiguous + grindable (peerIds gate feed writes + tips) — see
      `protocol.md` §5 `wave-start`. Likewise, `writers` can't be dropped in favour of deriving the
      roster from received `wave-join` floods: flood delivery is racy, so per-peer rosters would
      diverge and desync the deterministic sweep — the initiator's snapshot is the consensus. Note
      the bigger byte win at scale is orthogonal to gossip: the feed moment is a base64 dataURL
      (raw JPEG bytes would save ~33%), but that rides a Hypercore block, not gossip. **Latent — not
      worth it at per-room topic sizes (tens of peers).**
- [x] **Typed RPC seam between renderer/host and worker (`bare-rpc`).** Done — the host↔UI IPC now
      speaks **`bare-rpc`** through a single shared seam (`packages/hyperwave-engine/lib/rpc.js`:
      `serveEngine` host side + `createRpcClient` UI side, JSON-encoded over the existing pipe).
      Request/response commands (`tip` / `send-trx` / `fetch-transactions`) get **native
      request↔reply correlation** — two tips in flight no longer race (proven in `lib/rpc.test.js`
      under out-of-order replies); the one-way stream (state/event/feed/position/wallet…) rides
      bare-rpc's leak-free `event` primitive; and both hosts import the **one** `REQUEST_REPLY`
      source of truth. The engine keeps its transport-free `exec/notify` (an opaque correlation `id`
      is echoed on terminal results so the host can match an async result to its request). **Encoding
      stayed JSON** — `hyperschema` was intentionally dropped: its payoff is cross-version P2P wire
      compat, moot for a single-version internal app IPC, and the entry `payload` is opaque so it
      can't be typed anyway. **Desktop is a main-split** (the renderer is bundler-free ESM and can't
      load bare-rpc): the worker speaks the seam to **Electron main**, which runs the client and
      re-exposes it to the renderer over Electron's own `invoke`/event IPC. **Mobile** runs the seam
      end-to-end (RN JS ↔ worklet). Request/response replies are also surfaced through the event
      stream, so `app.js` / `useEngine.js` result-handling was unchanged. Remaining runtime check
      (can't be done headlessly): confirm the desktop app + iOS sim actually round-trip (bare-rpc in
      Electron main / Hermes — low risk, load-time safe, stream paths unused).
- [x] **Secure seed storage on desktop (OS keychain via Electron `safeStorage`) — DONE (2026-07-16).**
      Electron **main** owns `safeStorage`, encrypts both seeds at `<storage>/{wallet,swarm}.seed.enc`,
      and **injects** the decrypted values into the Bare worker over the IPC pipe (never argv/env). The
      desktop worker is now **init-message-driven** (`serveEngine` `onBootstrap`, like `worklet/app.js`);
      the engine was **unchanged** (it already forwards `config.seed`/`config.swarmSeed`, used-verbatim-
      never-written). Bootstrapping chose **option B** (main generates) over the doc's option A: WDK's
      generator is the standard `bip39@3.1.0`, so main mints a WDK-compatible mnemonic with the same lib
      (verified end-to-end) + a 32-byte-hex swarm seed — no report-seed round-trip. Handles the Linux
      `basic_text` fallback (warn + keep the engine's plaintext files, no false security) and
      plaintext→`.enc` migration (adopt + delete). Honest ceiling unchanged: protects at-rest /
      cross-user, **not** same-user malware (needs a signed build + keychain ACL, ultimately a hardware
      wallet). **Still pending: manual GUI verification** (no headless Electron in CI) — first-run
      `.enc` creation + no plaintext, restart reuse, migration, stable wallet address across restarts.
      **Design + as-built: [`docs/secure-seed-storage.md`](docs/secure-seed-storage.md).**
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
- [ ] **Bloom filter to minimize moment re-use.** A peer can re-post the same image across
      waves (or lift someone else's). Maintain a space-efficient bloom filter of seen
      moment-image hashes (per-peer, and/or gossiped) and reject a `wave-entry`
      whose image hash is probably-already-seen — cheap "have I seen this image?" at scale
      without storing every hash. False positives (rare) just ask the peer to re-shoot; no false
      negatives. Complements the per-entry byte cap + one-per-peer dedup (bounds _content_ reuse,
      not just count). Pairs well with a lightweight perceptual hash to catch near-duplicates.
- [~] **Automatic NSFW filter (desktop) — DONE (2026-07-17).** A **local, on-device** image-safety
  classifier (NSFWJS / MobileNetV2) blurs flagged gallery moments behind a "Show anyway" cover —
  the coherent moderation model for a CRDT gallery (each peer filters its OWN view; the entry
  stays in the log). Runs entirely in the renderer via an esbuild bundle (tfjs + nsfwjs + the
  mobilenet_v2 model **embedded**, so it loads from memory — no fetch, which a sandboxed file://
  renderer blocks). `scripts/build-nsfw.mjs` builds it at postinstall + in the forge package
  hook; `renderer/lib/nsfw.js` lazy-loads it + classifies (~ms/image, fail-open). Considered
  Tether's QVAC but its "vision" is a multimodal **VLM** (GB RAM, seconds/image) — overkill for
  binary NSFW, especially P2P-every-peer + mobile; MobileNet is ~100–1000× cheaper. The
  **report/downvote** mechanism below still complements it for the tail (false negatives).
- [ ] **Downvote / report mechanism for objectionable (e.g. NSFW) moments.** A `wave-entry` is
      an inline image any admitted participant can post, so a peer could post something NSFW or
      abusive. Add a **report/downvote** signal that propagates so each peer can **choose not to
      display** a flagged entry (client-side moderation, not censorship — the entry stays in the
      log; hiding it is a local decision). Design: a signed `downvote` op appended to the
      reporter's own per-wave gallery core (block 1+ — would need relaxing the block-0-only
      download for tiny non-image ops), referencing the target entry (`waveId` + `peerId`, or its
      image hash), **join-attested + one-per-reporter** exactly like a moment (so `mergeGallery`
      tallies at most one downvote per reporter — a sybil can't brigade, and the whole tally is
      deterministic + replicated so every peer converges on the same counts). The renderer hides
      an entry whose downvote count crosses a threshold (with a per-user "show anyway" toggle, and
      a default that errs toward hiding). Prefer a gallery-core op over gossip so counts persist
      with the gallery and converge; keep the report bytes tiny (no image). Pairs with the perceptual-hash / bloom
      item (auto-detection) — this is the human-report half. Note the moderation is inherently
      subjective + decentralized: it's advisory per-peer, not a global takedown.

### Remaining hardening (scale validation)

- [x] **Gallery-as-CRDT: DONE (2026-07-14, commits cd7f6e0 + 7d9b271).** Dropped the
      single Autobase indexer (O(N) funnel + live SPOF) for a multicore CRDT gallery — each
      participant owns one Hypercore (key rides its wave-join, self-certified by the join
      attestation); every peer merges the set locally (`mergeGallery`); no indexer/admission/
      shared key. 8-peer e2e green; 128-peer re-validation still pending. (Design analysis +
      the A/B replication bench that de-risked it are in git history. One finding still worth
      knowing, now baked into the code: each node must ACTIVELY `core.download()` every gallery
      core — log LENGTH propagates for free but block DATA arrives only when requested.)

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

- [ ] World map with flags lighting up as moments arrive (the original design's wow factor)
- [ ] "Past waves" browser (would need galleries to persist across runs — currently a wave
      initiator only retains its own wave's gallery in-run)
- [ ] Tipping UX polish (a "you were tipped" toast for the recipient)

### Housekeeping

- [~] Surface `wave-unpaid` / `join-blocked` more visibly in the UI. **Partially done
  (desktop):** the renderer now shows a **reason-specific** message for each `join-blocked`
  (`roster-full` → "this wave is full — spectating", `wallet-unsupported` → "needs a
  &lt;walletType&gt; wallet", `pending`/`rejected` → payment states) and drops the lobby into
  spectate for the terminal ones (`app.js`); `wave-unpaid` already un-dims + closes. Still
  status-line-based (a toast/modal would be more prominent) — that's the remaining polish.
- [x] **Show the initiator-set join fee before opting in (desktop).** The `fee` now rides the
      `wave-announce` event; the lobby panel shows "· fee N TRX" and the join button reads
      "✋ Count me in (N TRX)" (`lobby.js`), so a joiner sees the cost up front.
- [ ] Configurable fee/tip amounts. **The participation fee is now engine-configurable**
      (`createPayments({ fee })` / `config.walletOptions.fee`, initiator-set per wave) — remaining:
      expose it in the desktop UI (a settings input) + configurable tip amounts.
