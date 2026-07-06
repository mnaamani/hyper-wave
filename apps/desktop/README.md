# HyperWave (desktop MVP)

Electron + Pear desktop app for the HyperWave P2P stadium wave. Forked from
[`holepunchto/hello-pear-electron`](https://github.com/holepunchto/hello-pear-electron).
Design: `../ideas/final-idea.md` (§11 = this desktop MVP).
Docs: [`../docs/`](../docs/) — `architecture.md`, `protocol.md` (on-wire spec, incl. the
fee-burning mechanism), and `scalable-topology.md` (Chord-over-Hyperswarm scaling, phases
1–4 implemented). Demo walkthrough: [`../DEMO.md`](../DEMO.md).

## Run

```bash
npm install    # postinstall normalizes dep engines ranges for Bare (scripts/fix-bare-engines.js)

# Each instance needs its own --storage dir (own identity + Corestore + wallet).
# Every peer is equal — no roles. The peer that kicks off a wave keeps that wave's
# gallery open (archivist for its own wave only). See ../DEMO.md.
npm start -- --storage /tmp/hyperwave/one
npm start -- --storage /tmp/hyperwave/two
```

Wallets must be **funded** to pay fees (the Nile faucet gives 2000 TRX/day:
https://nileex.io/join/getJoinPage — the wallet address is in the 💰 chip / worker log).
Full demo script incl. funding and local-DHT setup: [`../DEMO.md`](../DEMO.md).

> **Discovery latency:** cold discovery on a fresh public-DHT topic takes **~20–35s**. For
> demos use the local DHT bootstrap (below) for instant same-machine discovery.

## Architecture (as wired today)

- **`renderer/`** (Chromium, sandboxed) — UI only. Starts the worker via the preload
  `bridge`, receives events, draws the ring. Never touches the swarm or keys.
- **`electron/main.js`** — the template plus a `media` permission line (webcam). Spawns Bare
  workers with `PearRuntime.run(specifier, [dir, ...])`; `--storage <dir>` becomes the
  worker's `Bare.argv[2]`, giving each instance its own identity, Corestore and wallet.
- **`workers/hyperwave.js`** (Bare) — bridges `lib/wave.js` + `lib/pay.js` to Electron IPC:
  starts the engine, brings up the WDK wallet, charges/verifies the participation fees, and
  relays commands/events.
- **`workers/lib/wave.js`** — runtime-agnostic P2P engine (Bare or Node harness):
  - **Discovery + topology (Chord over Hyperswarm):** Hyperswarm join (configurable
    `matchId`). Ring membership requires real liveness (a connection or gossip); DHT
    discovery (`swarm.peers`) drives which peers we deliberately connect to. Each peer
    **pins** (`swarm.joinPeer`) its Chord pointer set — successor-list (k=3), predecessor,
    and O(log N) finger table (`lib/chord.js`, pure + unit-tested) — so ring edges are
    physical without a full mesh. Includes distributed `findSuccessor` routing
    (`find-succ` RPC, correct under partial membership knowledge), join-time placement, a
    periodic stabilize/repair, and churn handling.
  - **Gossip:** slim pointer-exchange (a single `pointers` heartbeat to pinned neighbours only) for
    membership; wave lifecycle messages (`wave-announce/join/start/end`) are **flooded**
    (relay + dedup by `mid`, `lib/flood.js`) so they reach every peer on a partial mesh.
  - **Token race:** the initiator mints a wave-token; each holder verifies the sender's
    Ed25519 receipt, advances a **constant-size blake2b chain accumulator** (never a growing
    hops[]), signs its own receipt, and forwards to its successor; the lap completes back at
    the originator, which floods a **signed** `wave-end`. A small per-hop dwell (`hopDelayMs`,
    default 250ms) is purely the visible roll pace — selfies are captured in the lobby, so
    the token never waits on a human.
  - **Lifecycle:** idle → (pay) → lobby → racing → idle, one wave at a time, lower-`waveId`
    tie-break, `wave-end` broadcast, timeout fallbacks, `wave-sync` for late joiners, and
    healing (skip a dead successor when its `wave-pos` ACK doesn't arrive).
  - **Gallery (Autobase):** per-wave Autobase created by the originator. The gallery **key is
    signed** by the originator (rides `wave-start`/token/`wave-sync`) so a relay can't swap it
    to a rogue base. Writer admission (`add-writer`) is **burn-gated** — the admitter verifies
    the requester's join burn on-chain before granting write access, so a gallery seat (and thus
    a tippable selfie) requires a real fee burn. `apply()` runs deterministically on all peers:
    verifies every `wave-selfie` signature, admits **one entry per peer**, and keeps the tip
    `address` only if the entry's burn names that wallet (so tips always reach a payer). Selfies
    are captured during the **lobby** and posted when the token reaches that peer (ring order).
- **`workers/lib/pay.js`** + **`lib/fees.js`** — the WDK payment layer (Tron **Nile
  testnet**, native TRX). Self-custodial wallet per instance (seed at `<storage>/wallet.seed`),
  `send()` transfers, `burn(amount, memo)` to Tron's black-hole address with an on-chain memo,
  and `verifyBurnTx()` for the paid-wave gate; `fees.js` is the fee flow shared by both engine
  hosts. WDK is ESM-only; `pay.js` bridges via dynamic `import()`. The money model is simple —
  **burned fees + tips, no sponsor rewards** (all real on-chain):
  - **Participation fees are burned** — the initiator (kick-off) and every joiner pay 1 TRX
    to the unspendable black hole; the burn tx carries `hyperwave:<waveId>:<peerId>` as an
    on-chain memo (see `../docs/protocol.md` §9). Nobody profits — the fee is pure skin in
    the game / anti-spam.
  - **Paid-wave anti-spam gate** — a wave isn't announced until its kick-off burn exists
    on-chain; peers ignore unproven announces and verify the burn before joining.
  - **Burn-gated gallery admission** — the join burn is the ticket to write a selfie: the
    admitter verifies it on-chain before admitting, so every gallery entry is backed by a burn.
  - **Gallery tipping** — 💵 tip a selfie 1 TRX straight to its owner's wallet. The only way
    to actually make money — and always to a peer who paid in.
- **`workers/updater.js`** — the template's OTA updater worker, left intact.

**No roles — every peer is equal.** There is no validator/seed/sponsor role (no `role` option,
no `HYPERWAVE_ROLE`). The only asymmetry is **per-wave and belongs to the peer that kicks it
off**: that **initiator** keeps _its_ wave's gallery open and retains it (archivist for its own
wave only) so latecomers can still fetch it, collects that wave's raffle commits, and — if it
funds a raffle (`HYPERWAVE_RAFFLE_TRX`) — draws and pays the prize from its own wallet after the
wave (it's skipped in the winner walk, so it never pays itself). Every instance wipes its store
on startup, so galleries are ephemeral per run; if the initiator goes offline its wave's gallery
isn't archived elsewhere (accepted simplification).

### Worker → renderer messages

```js
// ring state (on every change)
{ type: 'state', me: { id, angle }, peers: [...], successor: { id, angle } | null }

// wallet + money
{ type: 'wallet', address, trx }                          // self-custodial wallet (chip)
{ type: 'burn-result', hash?|error?, amount, waveId, reason /* kickoff|join */ }
{ type: 'tip-result', hash?|error?, to, amount }

// lifecycle events (idle -> pay -> lobby -> racing -> idle)
{ type: 'token', event: 'paying', waveId }                   // initiator burning the kick-off fee
{ type: 'token', event: 'wave-announce', waveId, by, mine, joined, count, lobbyMs, paid }
{ type: 'token', event: 'wave-verified', waveId, mine? }     // kick-off burn proven -> join allowed
{ type: 'token', event: 'wave-unpaid', waveId, reason }      // failed verification -> abandoned
{ type: 'token', event: 'join-blocked', waveId, reason }     // tried to join before verification
{ type: 'token', event: 'joined' | 'roster', waveId, count }
{ type: 'token', event: 'wave-active', waveId, joined, count }
{ type: 'token', event: 'wave-idle', waveId, reason }
{ type: 'token', event: 'busy', waveId }

// token race events
{ type: 'token', event: 'started', waveId, by }
{ type: 'token', event: 'holding', waveId, hopCount, holder, angle, canSelfie }
{ type: 'token', event: 'position', waveId, hopCount, holder, angle }
{ type: 'token', event: 'forwarded' | 'healed' | 'stalled' | 'completed', ... }

// gallery (Autobase view) — on every change / replication
{ type: 'gallery', items: [ { waveId, peerId, hopCount, caption, image, address, ... } ] }
```

### Renderer → worker commands

```js
{ type: 'start-wave' }                        // burn kick-off fee -> announce + lobby
{ type: 'join-wave' }                         // verify wave paid -> opt in + burn join fee
{ type: 'set-country', country }
{ type: 'stage-selfie', selfie: { image, caption } }  // lobby-captured; posts when the ball arrives
{ type: 'tip', to, amount, peerId }           // real TRX to a selfie owner
```

The ring UI draws a yellow "you" dot, green peer dots, the **successor** in orange with a
baton line, and a 💰 wallet chip. The token is a **⚽ football that rolls clockwise around
the ring on every screen**. **Kick off the wave** burns the fee, then announces. During the
**lobby**, opted-in peers frame their selfie on camera (countdown to kickoff; captured
automatically at kickoff or on 📸). As the ball passes each participant, their staged selfie
posts and features **in the centre of the ring**; a 💵 Tip button under the featured selfie
sends real testnet TRX to its owner.

## Tests (no GUI)

Everything runs under **Bare** — the worker's real runtime (`bare`, not `node`). Tests use
[**brittle**](https://github.com/holepunchto/brittle). From `app/`:

```bash
npm test          # bare test.js — all suites, TAP output, non-zero on failure
```

`test.js` requires each suite; add new `workers/lib/*.test.js` there. Run one directly with
`bare workers/lib/<name>.test.js`:

```bash
bare workers/lib/wave.logic.test.js          # ring: successor, liveness, pickReachable
bare workers/lib/chord.test.js               # Chord math + distributed findSuccessor routing sim
bare workers/lib/flood.test.js               # gossip-flood reach over synthetic partial meshes
bare workers/lib/wave.token.test.js          # receipts, accumulator, burn + wave-end attestations
bare workers/lib/wave.gallery.test.js        # buildGallery ordering/dedup (+ tip address)
bare workers/lib/wave.autobase.test.js       # real Autobase apply/view + receipt write-gate
bare workers/lib/gallery.replication.test.js # transitive replication + initiator persistence (line topology)
bare workers/lib/pay.test.js                 # wallet derivation/persistence (offline)
```

End-to-end (one wave per process — the real worker topology; every peer is equal, no roles).
`AUTOJOIN` opts in, `AUTOSELFIE` stages a fake selfie, `WALLET=1` brings up the wallet (fee
burns need funded wallets); `START=N` makes a peer the **initiator** (kicks off once it sees N
others), and `HYPERWAVE_RAFFLE_TRX` on that same initiator funds a raffle it draws and pays:

```bash
export HYPERWAVE_MATCH="test-$(date +%s)" HYPERWAVE_LOBBY_MS=4000
START=1 AUTOJOIN=1 AUTOSELFIE=1 bare workers/lib/wave.run.js A /tmp/hw/a
AUTOJOIN=1 AUTOSELFIE=1 bare workers/lib/wave.run.js B /tmp/hw/b
# both converge on GALLERY size=2
```

### Fast local discovery (recommended for demos)

`createWave` accepts a `bootstrap` option (and `wave.run.js`/the app read
`HYPERWAVE_BOOTSTRAP=host:port`) to use a **local DHT** instead of the public one:

```bash
bare workers/lib/bootstrap.js          # prints "BOOTSTRAP 127.0.0.1:<port>", stays up
HYPERWAVE_BOOTSTRAP=127.0.0.1:<port> bare workers/lib/wave.run.js A /tmp/hw/a
```

## Notes

- `package.json#upgrade` must be a valid `pear://` link or `electron-forge start` refuses
  to boot (mint via `pear touch`).
- **Bare + npm deps:** some packages declare `engines.node` ranges Bare's semver can't
  parse (`^`, `||`, `>= 16`), which crashes module resolution under pear-runtime. The
  `postinstall` (`scripts/fix-bare-engines.js`) normalizes every such value using
  bare-semver itself as the oracle; re-run it manually if you ever patch `node_modules`.
- Two Hyperswarm instances in the **same** process don't reliably discover each other —
  one instance per process (which is how the app works anyway).
- **Shared topic:** all instances on the same `matchId` join one ring. The app default
  (`hyperwave:demo-match:v1`) is fixed, so public-DHT instances collide across machines —
  isolate with `HYPERWAVE_MATCH`/the `matchId` option, or use the local bootstrap.
- **Per-wave galleries:** each wave's gallery is a separate Autobase namespaced by its
  random `waveId`. Every peer's `storageDir/hyperwave` store is wiped on startup (ephemeral
  per-run — no roles, no cross-run archival). The peer that **initiates** a wave keeps that
  wave's gallery open and retains it, so latecomers can still fetch it while the initiator is
  online; there is no dedicated hub that archives every gallery.
- **Wallet seed** persists at `<storage>/wallet.seed` (outside the wiped store) — fund an
  instance once and it stays funded across restarts.
