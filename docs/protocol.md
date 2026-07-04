# HyperWave — Protocol & State Machine

A specification of the **on-wire protocol** and the per-peer **state machine**, detailed
enough to implement a compatible client in another language/framework. Everything here is
what peers exchange over the network; the Electron/renderer split (see
[`architecture.md`](./architecture.md)) is one implementation and is **not** part of the
protocol.

Reference implementation: `app/workers/lib/{wave,ring,token,gallery}.js`.

---

## 1. Concepts & roles

- A **match** is a swarm identified by a `matchId` string. Everyone on the same match is
  on one **ring**.
- A **peer**'s cryptographic identity (an Ed25519 key pair) determines its fixed **seat**
  on the ring (an angle derived from its public key).
- A **wave** is a single, one-at-a-time event with a random `waveId`. Its lifecycle is
  **idle → lobby → racing → idle**. An **originator** announces it; peers **opt in**
  (the **roster**); then a **token** (the ⚽) is passed peer-to-peer around the ring,
  each holder signing a **receipt**. When it returns to the originator the wave ends.
- Each roster member may post a **selfie** to the wave's **gallery** (an Autobase
  multi-writer log), gated by their token receipt.

There is no server and no coordinator beyond the per-wave originator. All peers run the
same logic.

## 2. Cryptographic primitives

| Primitive | Algorithm | Encoding on the wire |
|---|---|---|
| Key pair | Ed25519 | — |
| Peer id (`peerId`, `id`, `holder`, `by`, `senderPeerId`) | Ed25519 public key (32 bytes) | lowercase hex (64 chars) |
| Hash (`crypto.hash`) | BLAKE2b-256 (32 bytes) | lowercase hex (64 chars) |
| Signature (`receiptSig`) | Ed25519 sign/verify | lowercase hex (128 chars) |
| `waveId` | 16 random bytes | lowercase hex (32 chars) |
| `timestamp`, `hopCount` | integers | JSON numbers (base-10) |

Hex is lowercase throughout. Byte concatenation is raw bytes (not hex strings).

### 2.1 Ring angle (seat)

Given a 32-byte public key `K`:

```
n     = K[0]*256^5 + K[1]*256^4 + K[2]*256^3 + K[3]*256^2 + K[4]*256 + K[5]   // top 6 bytes, big-endian
angle = (n / 2^48) * 360      // degrees in [0, 360)
```

Angle is **always derived locally** from a peer's id; it is never trusted from the wire.

**Successor** = the next live peer clockwise: among live peers sorted by ascending angle,
the first with `angle > myAngle`, wrapping to the smallest if none is greater. (A peer's
own angle is not in the set.)

### 2.2 Receipt

A receipt binds a peer to a specific hop of a specific wave.

```
receiptHash(waveId, hopCount, chainHash, timestamp)
    = BLAKE2b-256( utf8( waveId + "|" + hopCount + "|" + chainHash + "|" + timestamp ) )

receiptSig  = hex( Ed25519_sign( receiptHash, mySecretKey ) )
verify      = Ed25519_verify( receiptHash, fromHex(receiptSig), fromHex(peerId) )
```

`hopCount` and `timestamp` are rendered as plain base-10 integers; `chainHash` is the
64-char hex accumulator value (see below). For the originator's hop 0, `chainHash` is the
genesis value `ZERO_HASH`.

### 2.3 Chain accumulator (constant-size receipt chain)

Instead of carrying a growing list of receipts, the token carries a rolling hash:

```
ZERO_HASH        = hex(32 zero bytes)                                  // 64 × '0'
advanceChain(prevHex, receiptSigHex)
    = hex( BLAKE2b-256( fromHex(prevHex) ++ fromHex(receiptSigHex) ) )  // 32 ++ 64 = 96 bytes → 32
```

A validator (or any observer collecting the per-hop receipts) can reproduce the final
accumulator by folding `advanceChain` over the receipts in hop order starting from
`ZERO_HASH`:

```mermaid
flowchart LR
  Z["ZERO_HASH"] -->|"⊕ receipt₀"| H1["chainHash₁"]
  H1 -->|"⊕ receipt₁"| H2["chainHash₂"]
  H2 -->|"⊕ receipt₂"| H3["chainHash₃"]
  H3 -->|"…"| Hn["chainHashₙ"]
```

where `⊕ receiptᵢ` means `advanceChain(prev, receiptSigᵢ) = BLAKE2b(prev ++ receiptSigᵢ)`.

## 3. Transport

- **Topic:** `topic = BLAKE2b-256( utf8(matchId) )` (32 bytes). Join the Hyperswarm DHT
  with `join(topic, { server: true, client: true })`. Default `matchId` in the reference
  build is `"hyperwave:demo-match:v1"`.
- **Per connection** (Noise-encrypted duplex stream from Hyperswarm):
  1. `Corestore.replicate(conn)` — replicates the Autobase gallery cores (see §8).
  2. A **Protomux** channel with protocol id `"hyperwave/gossip"`, carrying a single
     message type whose encoding is `compact-encoding` **`string`** (length-prefixed
     UTF-8). Each message is a **JSON object** with a `kind` field.
- **Broadcast** = send a message on every open gossip channel. **Direct** = send only on
  a specific peer's channel (used to forward the token to the successor).
- The gossip channel and the Corestore replication share the same underlying stream
  (Protomux multiplexes them).

All timing constants are in §10.

### 3.1 Message propagation & relay rules

Past Hyperswarm's mesh limit a large swarm is only a **partial random mesh** — each peer
is directly connected to ~its connection-limit's worth of a random subset, so a plain
one-hop broadcast reaches only a fraction of the swarm. Different message classes are
propagated differently to match what each needs:

| Class | Messages | Fanout |
|---|---|---|
| **Flood (relayed + dedup)** | `wave-announce`, `wave-join`, `wave-start`, `wave-end` | every peer |
| **One-hop broadcast** | `wave-pos`, `add-writer` | direct neighbours only |
| **Neighbour-scoped** | `presence`, `pointers` | pinned ring neighbours (O(k + log N)) |
| **To validators** | `wave-proof` | each connected validator/seed |
| **Unicast** | `token`, `wave-sync` | one specific peer |

**Flood (epidemic broadcast).** The wave *lifecycle* messages must reach every seat, so they
are relayed hop-to-hop:
- The originator stamps the message with a unique `mid` (random id) and broadcasts it to all
  direct connections.
- On **first** receipt of a given `mid`, a peer records it, **re-broadcasts** to its other
  neighbours (everyone except the sender), and then processes it locally. On any **repeat**
  `mid` it does nothing (drops the duplicate) — this dedup is what stops loops and bounds the
  flood.
- On the partial random mesh (average degree ≈ connection limit, diameter ≈ log N / log
  degree ≈ a few hops) this blankets the whole swarm in ~2–3 relay rounds — hundreds of ms,
  far inside the lobby — and is robust to peer/link loss thanks to the many redundant paths.
- Cost is O(edges) message-sends per flood; fine for the handful of small, infrequent
  lifecycle messages. Seen-`mid`s are capped (`GOSSIP_SEEN_CAP`) so the dedup set can't grow
  unbounded over a long session.

**One-hop broadcast (no relay).** `wave-pos` is emitted every hop (~`HOP_DELAY_MS`); flooding
it would be a storm, and it doesn't need to reach everyone — its role as the heal-ACK only
needs to reach the **predecessor** (a pinned neighbour), and distant ball-animation is a
nice-to-have. `add-writer` is one-hop today; gallery admission across a partial mesh is
tracked with gallery replication (`scalable-topology.md` §4.7).

**Unicast.** The **token** is sent only to the current successor and deliberately relayed
**hop by hop** as the wave mechanic — each holder *re-stamps* it with a fresh receipt before
forwarding (§6). **`wave-sync`** is sent point-to-point to a newcomer on connect (§7.4).

**Membership** is **DHT-discovered but liveness-gated.** `swarm.peers` (Hyperswarm's PeerInfo
set on the topic) drives *which peers we dial* (Chord pinning), not the visible ring — a DHT
announcement alone is just "this key advertised the topic once", so a stale announce from a
since-closed instance is never shown as a seat. A **seat requires real liveness**: a live
connection or direct gossip. On top of that, a slim **pointer exchange** (`pointers`: each
peer advertising only its own successor-list + predecessor, O(k + log N)) propagates local
ring structure, replacing the old O(N) full-table snapshot.

The ring **drives connections** (Chord over Hyperswarm, Phases 1–4 in
[`scalable-topology.md`](./scalable-topology.md)): each peer deliberately `swarm.joinPeer`s
its successor-list, predecessor, and O(log N) finger table, so the successor is reachable
without a full mesh. Flooding rides the same connections, so lifecycle messages reach every
seat whether or not the swarm is fully meshed; **`wave-sync`** on connect remains the catch-up
path for a peer that joins after a flood has already passed.

## 4. Peer map (membership & liveness)

Each peer maintains a map of **other** peers (never itself), keyed by id:
`id -> { id, angle, lastSeen, country }`. `angle` is derived from `id` (§2.1) — never
trusted from the wire; `country` is a cosmetic ISO-3166-1 alpha-2 code (or null).

Inputs that build the map:

| Event | Effect |
|---|---|
| **DHT discovery** (`swarm.peers`, refreshed on `swarm.on('update')` + each tick) | `upsert(id, now)` for every discovered PeerInfo — the primary membership source. |
| connection **open** | `upsert(remoteId, now)`; also mark **reachable** (eligible token successor); lift any churn cooldown. A direct connection is authoritative liveness. |
| connection **close** | delete the peer (and its reachable mark); set a `goneUntil` cooldown (`TTL_MS`) so DHT re-seeding can't immediately resurrect the dead peer. |
| `presence { id, country }` | `upsert(id, now, country)` |
| `pointers { id, country, succ: [id…], pred: id }` | `upsert(id, now, country)`; upsert each `succ`/`pred` id at `now − TTL/2` (discovery hint); run one stabilize step. |

```
upsert(id, lastSeen, country):
  if id == me: return
  cur = map[id]
  if cur is missing OR lastSeen > cur.lastSeen:
      map[id] = { id, angle: angleOf(id), lastSeen, country: country ?? cur?.country ?? null }
  else if country is set:
      cur.country = country          # country always tracks the latest report
```

So `lastSeen` is **monotonic per peer** (only advances) and `angle` is always recomputed
from the id.

**Liveness, ring, successor.** A peer is **live** if `now − lastSeen < TTL_MS`. The **ring**
is the live peers sorted by angle; the **successor** is the next live peer clockwise
(§2.1). A direct disconnect removes a peer immediately (and cools it down against DHT
re-seeding); the TTL only expires peers known *indirectly* (a `pointers` discovery hint, or
a `swarm.peers` entry that has since gone) once they stop being refreshed.

**Reachable vs known.** A peer may be *known* (in the map, e.g. DHT-discovered or a
`pointers` hint) without being *reachable* (no direct connection). The token is only
forwarded to a **reachable** live successor; healing (§7.3) skips known-but-unreachable peers.

```mermaid
flowchart LR
  Dht["swarm.peers (DHT discovery)"] --> U0["upsert id, now"]
  Conn["connection open"] --> U["upsert id, now"]
  Pres["presence"] --> U2["upsert id, now, country"]
  Ptr["pointers (succ/pred)"] --> U3["upsert sender now; hints at now minus TTL/2; stabilize"]
  U0 --> M[("peer map")]
  U --> M
  U2 --> M
  U3 --> M
  Close["connection close"] -->|delete + cooldown| M
  M --> L["live = now minus lastSeen &lt; TTL, sorted by angle"]
  L --> S["successor = next clockwise"]
```

On connect, a peer **greets** the newcomer with a `presence`, its `pointers`, and — if a
wave is active — a `wave-sync` (§7.4), so the newcomer's map *and* wave state converge
immediately.

## 5. Gossip message catalog

All are JSON objects on the `hyperwave/gossip` channel. Unknown `kind`s are ignored.

### presence — to pinned neighbours, every `PRESENCE_MS`
```json
{ "kind": "presence", "id": "<peerId>", "country": "BR" | null, "role": "peer" | "validator" }
```
Heartbeat. Receiver upserts the peer (`lastSeen = now`, `country`). Sent only to pinned ring
neighbours (Chord successor-list + predecessor + fingers), not every connection. `role`
`validator`/`seed` marks a **gallery seed**: peers deliberately pin it (so it's a
well-connected replication hub that keeps galleries alive after participants leave, §4.7).

### pointers — to pinned neighbours, every `RINGUPDATE_MS`
```json
{ "kind": "pointers", "id": "<peerId>", "country": "BR" | null,
  "succ": ["<peerId>", ...], "pred": "<peerId>" | null }
```
The sender's own Chord pointers — successor-list (`succ`, ≤ `K_SUCCESSORS`) + predecessor
(`pred`). O(k + log N), replacing the old O(N) full peer snapshot. Receiver upserts the
sender (`lastSeen = now`) and each advertised id as a discovery hint (`lastSeen = now −
TTL/2`), then runs one Chord stabilize step (`scalable-topology.md` §4.4). Primary membership comes from DHT discovery
(`swarm.peers`), so pointers are structure/liveness hints, not the authoritative peer set.

The four `wave-*` lifecycle messages below are **flooded** (§3.1): each carries a unique
`mid` (random hex id); receivers relay on first sight and drop repeats.

### wave-announce — flooded (originator, on kick-off)
```json
{ "kind": "wave-announce", "mid": "<hex8>", "waveId": "<hex16>", "by": "<peerId>", "lobbyMs": 15000,
  "paid": { /* kick-off burn-proof, §8.4 — present when the paid-wave gate is enforced */ } }
```
Opens the lobby. Receivers that accept it (§7.1 adoption) enter `lobby` for `waveId`.

**Paid-wave gate (anti-spam).** When enforced (every instance has a wallet), the initiator
**does not announce until it has burned the kick-off fee and confirmed it on-chain** — the
announce then carries `paid`, the kick-off `burn-proof`. A peer **ignores any announce whose
`paid` proof is missing or not validly signed** (an unpaid/spam wave is invisible), and before
it will **join** (and pay its own fee) it verifies the burn **on-chain** (`verifyBurnTx`:
`to == ` the black hole, `amount ≥ fee`, memo commits `waveId`). `join()` is refused until the
kick-off is `verified`. So no peer ever pays into a wave the initiator hasn't paid for. The
same `paid` proof rides `wave-sync`, so a mid-lobby newcomer can verify too. (Without wallets
— headless/tests — enforcement is off and waves announce immediately, unpaid.)

### wave-join — flooded (a peer opting in during lobby)
```json
{ "kind": "wave-join", "mid": "<hex8>", "waveId": "<hex16>", "peerId": "<peerId>" }
```
Receiver adds `peerId` to the wave's roster (if it's the current wave). Flooded so it reaches
the initiator (which assembles the roster) even across a partial mesh.

### wave-start — flooded (originator, when the lobby closes)
```json
{ "kind": "wave-start", "mid": "<hex8>", "waveId": "<hex16>", "by": "<peerId>",
  "roster": ["<peerId>", ...], "key": "<autobaseKeyHex>" }
```
Finalizes the roster and begins the race. `key` is the wave's gallery Autobase bootstrap
key (§8). Receivers open the gallery and transition `lobby → racing`.

### token — DIRECT to the successor (the ⚽)
```json
{ "kind": "token", "waveId": "<hex16>", "originator": "<peerId>",
  "hopCount": 3, "prevChainHash": "<hex32>",
  "senderPeerId": "<peerId>", "senderReceiptSig": "<hex64>",
  "timestamp": 1719705612080, "autobaseKey": "<autobaseKeyHex>" }
```
The token as forwarded by `senderPeerId` at hop `hopCount`. `senderReceiptSig` is that
sender's receipt over `(waveId, hopCount, prevChainHash, timestamp)`. Processing: §6.

### wave-pos — one-hop broadcast (a peer when it becomes the holder)
```json
{ "kind": "wave-pos", "waveId": "<hex16>", "holder": "<peerId>", "hopCount": 3 }
```
Tells direct neighbours the ball is now at `holder` (so they can animate it). Also serves as
the **ACK** that healing (§7.3) waits for — the predecessor is a pinned neighbour, so it's
received without needing a flood. Deliberately **not** relayed (emitted every hop).

### wave-end — flooded (originator on completion, or any peer on a dead-end stall)
```json
{ "kind": "wave-end", "mid": "<hex8>", "waveId": "<hex16>", "by": "<peerId>",
  "hops": 7, "chainHash": "<hex32>", "stalled": false }
```
Ends the wave for everyone. `stalled: true` means a peer hit a dead end (no reachable
successor); `hops`/`chainHash` are present on normal completion.

### add-writer — one-hop broadcast (a peer requesting gallery write access)
```json
{ "kind": "add-writer", "key": "<requesterAutobaseLocalKeyHex>", "peerId": "<peerId>",
  "waveId": "<hex16>", "hopCount": 3, "chainHash": "<hex32>",
  "receiptTs": 1719705612080, "receiptSig": "<hex64>" }
```
Asks the gallery host to admit `key` as an Autobase writer, presenting a valid receipt
(§8.2). Any current writer that verifies the receipt appends an `add-writer` op.

### wave-proof — direct to connected validators/seeds (each hop)
```json
{ "kind": "wave-proof", "waveId": "<hex16>", "hopCount": 3, "peerId": "<peerId>",
  "receiptSig": "<hex64>", "chainHash": "<hex32>", "receiptTs": 1719705612080, "address": "T…" }
```
Every holder pushes its hop receipt to each connected validator (`role: validator`) — so the
validator collects the **whole ordered chain**, including relayers who never post a selfie
(their receipt reaches it no other way). The validator verifies each receipt (§2.2) and keys
it by `(waveId, hopCount)`; the reassembled chain drives the interlocked payout (final-idea).
`address` is the sender's payout wallet. A validator that is itself a relay records its own
hop directly. Not flooded — sent only to pinned seeds (which everyone pins, §4.6).

### wave-sync — DIRECT to a newly-connected peer (join-time state)
```json
{ "kind": "wave-sync", "waveId": "<hex16>", "phase": "lobby" | "racing",
  "by": "<peerId>", "roster": ["<peerId>", ...], "key": "<autobaseKeyHex>|null",
  "lobbyMsLeft": 8000 }
```
Lets a peer joining mid-wave sync (§7.4).

## 6. Token processing

When a peer receives a `token`:

1. **Verify** `senderReceiptSig` against `receiptHash(waveId, hopCount, prevChainHash,
   timestamp)` and `senderPeerId`. If invalid, drop.
2. **Wave filter:** if `!shouldAdopt(waveId)` (§7.1), drop (it's a competing/finished
   wave).
3. **Completion:** if `originator == me` and `hopCount > 0`, the token has returned:
   broadcast `wave-end { hops: hopCount, chainHash: prevChainHash, by: me }`, finish the
   wave locally, stop.
4. **Dedup / cap:** key = `waveId + "|" + hopCount`; if already in `seen`, or `hopCount >
   MAX_HOPS`, drop. Else add to `seen`.
5. **Adopt & learn gallery:** ensure engaged with this wave and `racing` (a peer that
   missed announce/start catches up here); open the gallery from `autobaseKey`.
6. **Advance & stamp:** compute `newChainHash = advanceChain(prevChainHash,
   senderReceiptSig)`, `hopCount' = hopCount + 1`, and a fresh receipt over `(waveId,
   hopCount', newChainHash, now)`. This is *my* hop.
7. **Hold & forward:**
   - Broadcast `wave-pos { holder: me, hopCount' }`.
   - If I'm in the roster, **post my staged selfie now** (see below): I have my receipt for
     this hop, and my image was captured back in the lobby.
   - After `HOP_DELAY_MS` (a **minimal** dwell — just the visible roll pace), forward the
     new token to my **successor** (§7.3 handles a dead successor).

**The selfie is captured up-front, in the lobby.** The token must never wait on a human, so
capture and posting are split:
- **Capture (lobby, synchronized):** when a peer opts in, the renderer opens the camera and
  shows a countdown to kickoff. At kickoff (or on a manual press) it grabs one frame and
  **stages** it to the worker (`stage-selfie` command → `stagedSelfie`). Everyone captures
  around the same moment, at a relaxed pace — independent of ring size or dwell.
- **Post (race, on the ball):** when the token reaches me I record my hop's receipt
  (`recordMyReceipt`) and post the staged image to the gallery, gated on that receipt (the
  add-writer credential). `tryPostSelfie` fires once **both** the staged image and the
  receipt are present, so it's robust to either arriving first (e.g. the originator, which
  stages and holds at hop 0 almost simultaneously). Posted exactly once per wave.

So `HOP_DELAY_MS` can be small (250ms) — it never has to cover a human taking a selfie — and
selfies still land in the gallery in **ring order**, as the ball passes each participant.

The originator starts the chain at hop 0: `prevChainHash = ZERO_HASH`, its own receipt,
then hold & forward as above.

```mermaid
flowchart TD
  T["receive token"] --> V{"receipt valid?"}
  V -- no --> D1["drop"]
  V -- yes --> A{"shouldAdopt waveId?"}
  A -- no --> D2["drop — competing/ended wave"]
  A -- yes --> C{"originator is me and hop &gt; 0?"}
  C -- yes --> E["broadcast wave-end · finish wave"]
  C -- no --> S{"seen or hop &gt; MAX_HOPS?"}
  S -- yes --> D3["drop — dupe / cap"]
  S -- no --> H["adopt + open gallery ·<br/>advance chain · stamp my receipt ·<br/>broadcast wave-pos ·<br/>dwell then forward to successor"]
```

## 7. Wave lifecycle state machine

Each peer holds at most one `wave = { id, phase, by, roster:Set, joined:bool }` (or
`null` = **idle**), plus `endedWaves:Set` (finished ids) and `seen:Set`.

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> lobby: kick off (idle only), or hear wave-announce / wave-sync(lobby)
  lobby --> racing: lobby timer (originator), or wave-start / wave-sync(racing) / token
  lobby --> idle: lobby timeout
  racing --> idle: wave-end (completed or stalled), or timeout
```

A full wave, three peers (successor order O → B → C → O):

```mermaid
sequenceDiagram
  autonumber
  participant O as Originator
  participant B as Peer B
  participant C as Peer C
  Note over O,C: idle
  O-)B: wave-announce broadcast
  O-)C: wave-announce
  B-)O: wave-join broadcast
  B-)C: wave-join
  Note over O,C: lobby, roster O and B
  Note right of O: lobby timer fires
  O-)B: wave-start with roster and galleryKey
  O-)C: wave-start
  Note over O,C: racing
  O->>B: token hop 0, direct to successor
  Note over O,C: wave-pos holder O broadcast, ball at O
  B->>C: token hop 1
  Note over O,C: wave-pos holder B, ball rolls O to B
  C->>O: token hop 2, back to originator
  Note over O,C: wave-pos holder C, ball rolls B to C
  Note right of O: back at originator, wave completes
  O-)B: wave-end with hops and chainHash
  O-)C: wave-end
  Note over O,C: idle
```

(Solid arrows = the token, sent **direct** to the successor; open arrows = **broadcast**
gossip. Each hop the holder broadcasts `wave-pos`, and — if in the roster — takes a selfie.)

### 7.1 Adoption & tie-break (`shouldAdopt(waveId)`)
- If `waveId ∈ endedWaves` → **reject** (a finished wave never restarts).
- If idle, or `waveId == wave.id` → **accept**.
- Else accept **iff `waveId < wave.id`** (lexicographic on hex). Lower id wins, so
  concurrent starts deterministically converge on one wave. On accepting a different
  wave, the old one is abandoned (added to `endedWaves`).

### 7.2 Roles in a wave
- **Originator:** the peer that called `startWave` — sends `wave-announce`, runs the lobby
  timer, sends `wave-start`, starts the token at hop 0, and detects completion.
- **Joiner (roster):** opted in during the lobby; gets a selfie prompt.
- **Spectator:** engaged with the wave but not in the roster; relays the token if it
  passes, but no selfie prompt. (The ball visits *everyone*, keeping the full-ring
  visual; only the roster selfies.)

### 7.3 Healing
When forwarding, pick the **next reachable peer clockwise** (directly connected, not
already skipped). After forwarding, watch for the wave to advance past my hop — the
successor's `wave-pos` is the ACK. If none arrives within `HEAL_TIMEOUT_MS`, mark that
successor skipped and re-forward to the next reachable peer. If none remain, it's a
**dead end**: broadcast `wave-end { stalled: true }` and finish.

```mermaid
sequenceDiagram
  autonumber
  participant A as Holder A
  participant X as Dead successor X
  participant Y as Next peer Y
  A->>X: token hop n
  Note right of A: arm heal timer, await wave-pos past hop n
  Note over X: unreachable, never holds
  Note right of A: HEAL_TIMEOUT_MS with no ACK, skip X
  A->>Y: token hop n re-forward
  Y-)A: wave-pos holder Y, the ACK
  Note right of A: advance done, heal cleared
```

### 7.4 Join-time sync
Lifecycle broadcasts fire once, so a peer connecting mid-wave would miss them. On each new
connection, existing peers send a **direct** `wave-sync`. The newcomer:
- `phase: lobby` → enter the lobby (join window with `lobbyMsLeft` remaining), merge roster.
- `phase: racing` → open the gallery from `key` and go straight to `racing` (spectator
  unless it holds the token).
Either way it's now engaged, so it can't start a competing wave.

### 7.5 Ending & anti-revival
A wave ends on completion (originator), a stall, `wave-end`, or the `WAVE_TIMEOUT_MS`
fallback. On ending: add `waveId` to `endedWaves`, clear `seen`, return to idle. Because
`endedWaves` blocks re-adoption, a straggler token/gossip can't revive a finished wave.

## 8. Gallery (Autobase multi-writer log)

Each wave has its own gallery: an **Autobase** (Holepunch multi-writer append log with a
deterministic linearized view), namespaced per wave so it starts empty.

### 8.1 Setup
- The **originator** creates the Autobase (bootstrap key = null → its own key), and
  publishes the resulting **`autobaseKey`** (hex) in `wave-start` and in every `token`.
- Other peers **open** the same Autobase by that bootstrap key. It replicates over the
  existing `Corestore.replicate(conn)` on each connection.
- `valueEncoding`: JSON. The linearized **view** is an append-only list of `wave-selfie`
  entries (in hop/timestamp order after `buildGallery`, §8.3).

### 8.2 Writer admission & the receipt gate (anti-spam)
Autobase writes only count from keys in the writer set, and only an existing writer can
admit a new one. Membership + content are gated by receipts:
- **Admission:** to post, a non-writer broadcasts `add-writer` with its Autobase local key
  **and a valid receipt for the current wave**. A current writer (initially the
  originator) verifies the receipt and, if valid, appends an `add-writer` **op** to the
  base. Once linearized, the requester becomes a writer.
- **`apply()` (runs deterministically on every peer):**
  - `{ type: 'add-writer', key }` → `addWriter(key)`.
  - `{ type: 'wave-selfie', ... }` → append to the view **only if** its `receiptSig`
    verifies (Ed25519) for `(waveId, hopCount, chainHash, receiptTs)` by `peerId`.
    Invalid/unsigned/impersonated entries are dropped identically everywhere.
  - `{ type: 'burn-proof', ... }` → append **only if** its `sig` verifies (Ed25519) by
    `peerId` over the burn tuple (§8.4). Same gate, dedicated signature.

```mermaid
sequenceDiagram
  autonumber
  participant P as Poster not yet a writer
  participant H as Host a current writer
  participant AB as Autobase view
  Note over P: ball reached me, took a selfie
  P-)H: add-writer, my key plus receipt, broadcast
  Note right of H: verify receipt for this wave
  H->>AB: append add-writer op
  Note over AB: apply on every peer, addWriter key
  Note right of P: now writable
  P->>AB: append wave-selfie
  Note over AB: apply verifies receiptSig, append or drop
  AB-->>P: view updates, replicates to all
```

> **Scope of the gate:** this is *authenticity* — entries are provably from the claimed
> peer. It is **not** proof-of-participation: a peer can self-sign a receipt for a hop it
> never held. Full proof requires cross-checking the receipt against the real token chain
> (a validator's job, out of scope here).

### 8.3 `wave-selfie` op (Autobase entry)
```json
{ "type": "wave-selfie", "waveId": "<hex16>", "peerId": "<peerId>",
  "hopCount": 3, "receiptSig": "<hex64>", "chainHash": "<hex32>", "receiptTs": 1719705612080,
  "country": "BR", "caption": "Vamos! 🇧🇷", "image": "data:image/jpeg;base64,...",
  "address": "T…", "timestamp": 1719705650000 }
```
`image` is an inline JPEG data URL (a compressed thumbnail) in the reference build;
Hyperblobs is the scaling path. `address` is the poster's Tron (TRX) wallet, carried so a
viewer can **tip** this selfie with a real testnet transfer (renderer `tip` → worker
`pay.send(address, amount)`; §WDK). Ordering (`buildGallery`): one entry per `(waveId,
peerId)` (newest `timestamp` wins), sorted by `hopCount` then `timestamp`.

### 8.4 `burn-proof` op (participation-fee attestation)
```json
{ "type": "burn-proof", "waveId": "<hex16>", "peerId": "<peerId>",
  "reason": "kickoff" | "join", "amount": 1, "txHash": "<tron-tx-hash>",
  "tronAddress": "T…", "burnTs": 1719705612080, "sig": "<hex128>" }
```
Proves the peer **burned** its participation fee *for this wave*. Two independent bindings
make this verifiable (the Tron key that signs the burn is a different keypair from the ring
identity, so both are needed):
1. **On-chain memo.** The burn tx carries `data = "hyperwave:<waveId>:<peerId>"` (readable via
   `gettransactionbyid`). The burn *itself names the wave* — a third party can confirm it
   from-chain, and it can't be an old burn replayed for another wave (each carries its own
   random `waveId`, unguessable in advance).
2. **Ring attestation.** `sig` = Ed25519 by `peerId` over
   `(waveId, peerId, reason, amount, txHash, tronAddress, burnTs)` — binds the ring
   participant to the on-chain tx + payout address. `apply()` admits the op only if `sig`
   verifies (§8.2).

A **validator** reading these (`readBurns`) still cross-checks each `txHash` on-chain:
`to == ` the black hole `T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb`, `amount ≥ fee`, memo commits
`waveId`, confirmed in a block, and each `txHash` claimed once (dedup). A peer posts its
burn-proof once it holds the token (has a receipt → can be admitted as a writer), so a
join-fee payer surfaces its proof even if it never posts a selfie.

### 8.5 Interlocked payout (validator, off-wire)
When a wave ends, the **validator** rewards participants from its own budget (a *sponsor*
spend, never a split pot). It's the consumer of the collected `wave-proof` receipts:

1. **Reassemble + verify the chain** (`longestValidChain`): sort the hop receipts, walk from
   hop 0, and for each hop verify (a) its `receiptSig` signs the accumulator it carries and
   (b) the accumulator links to the previous hop (`chainHash₍ₙ₊₁₎ == advanceChain(chainHashₙ,
   receiptSigₙ)`). The walk **stops at the first broken/forged/missing link** — so a
   self-signed receipt for a hop never held, a gap, or a tampered link can't extend the chain.
   Result: the longest *cryptographically valid* prefix.
2. **The golden rule** (`payableFromChain`): peer N is paid only if peer **N+1 continued** —
   i.e. N+1 is in the valid chain. Every hop but the last qualifies; the **last** hop
   qualifies only if the wave **completed** (the token returned to the originator, `wave-end`
   with `hops == ` the last hop), which proves the last hop forwarded onward too. On a
   stall/break this is the longest valid **prefix** (the peer at the break isn't paid — its
   continuation is unproven).
3. **Pay** a fixed `REWARD_TRX` to each payable hop's on-chain `address`, once per wave; the
   validator skips its **own** hop (it relays the ball but sponsors, it doesn't reward
   itself). Emits `payout` / `payout-done`.

The chain-walk is pure (`token.js`, unit-tested); only the transfers touch the chain.

## 9. Participation fees — burning & verification

The money layer's anti-spam mechanism, consolidated. (Wire/message details: the paid-wave
gate on `wave-announce` §5, the `burn-proof` gallery op §8.4, the payout §8.5.)

### 9.1 The mechanism: fees are burned, not paid

Starting a wave (**kick-off fee**) and opting into one (**join fee**) each cost a fixed
amount (1 TRX in the reference build), and the payment is **burned**: sent to Tron's
black-hole address

```
T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb        (base58check of the all-zero EVM address)
```

for which no private key exists — the funds are provably unspendable by *anyone*. This is
deliberate: the fee creates **skin in the game with no beneficiary**. Nobody (not the
validator, not the initiator) profits from fees, so there is no censorship or collusion
incentive, no custodial ledger, and no refund path to dispute. (Tron rejects zero-amount
transfers, so a burn is a real small transfer; Tron also burns tx fees at the protocol
level.) Spamming waves or Sybil-joining costs real, irrecoverable value.

### 9.2 Binding a burn to its wave and its peer

A raw burn tx only proves "someone sent TRX to the black hole." Two independent bindings
make it *"ring peer P burned specifically for wave W"* — two are needed because the Tron
key that signs the tx is a **different keypair** from the peer's Ed25519 ring identity:

1. **On-chain memo (burn ↔ wave, third-party auditable).** The burn tx carries
   `data = "hyperwave:<waveId>:<peerId>"`. Anyone can read it back via
   `gettransactionbyid` — the burn *names the wave on-chain*. Replay across waves is
   impossible: each `waveId` is 16 random bytes, unguessable before the wave exists, and
   the memo is part of the signed tx.
2. **Ring attestation (burn ↔ ring identity).** The peer signs, with its **ring** Ed25519
   key, the tuple `(waveId, peerId, reason, amount, txHash, tronAddress, burnTs)` and
   publishes it as a `burn-proof` op in the wave's gallery (§8.4). `apply()` admits it only
   if the signature verifies — binding the ring participant to that specific tx and payout
   address.

### 9.3 Verification (who checks what, when)

- **Before joining (every peer):** a `wave-announce` must carry the initiator's kick-off
  `burn-proof`, validly signed — otherwise the announce is **ignored** (an unpaid wave is
  invisible). Before a peer joins (and pays its own fee), it verifies the kick-off burn
  **on-chain** — `verifyBurnTx`: the tx exists, is a `TransferContract` **to the black
  hole**, from the attested address, `amount ≥ fee`, and the **memo commits this
  `waveId`**. `join()` is refused until this passes, so no peer ever pays into a wave the
  initiator hasn't paid for. The initiator, symmetrically, does not announce until its own
  burn is readable on-chain.
- **At payout (the validator):** re-verifies each `burn-proof` the same way, plus dedup
  (each `txHash` creditable once).
- **Anyone, later:** because the memo is on-chain and the `burn-proof` is in the replicated
  gallery, a third party can audit every fee of every wave with nothing but a Tron node —
  no trust in the validator's bookkeeping required.

Enforcement is active whenever an instance has a wallet; walletless test/headless runs skip
the gate (waves announce immediately, unpaid).

## 10. Constants (reference build)

| Constant | Value | Meaning |
|---|---|---|
| `PRESENCE_MS` | 2000 | presence heartbeat cadence |
| `RINGUPDATE_MS` | 4000 | peers-snapshot cadence |
| `TTL_MS` | 12000 | drop a peer not refreshed within this |
| `HOP_DELAY_MS` | 250 | per-hop dwell (visible roll pace; selfie is decoupled, §6) |
| `LOBBY_MS` | 15000 | lobby / opt-in window |
| `WAVE_TIMEOUT_MS` | 90000 | force-idle if a wave doesn't finish |
| `HEAL_TIMEOUT_MS` | 3000 | no advance past my hop ⇒ skip successor |
| `MAX_HOPS` | 5000 | runaway-token safety cap |
| writer-admission wait | 8000 | give up if not admitted to the gallery |

These are timing/UX tunables, not wire-format; a compatible client should keep them in the
same ballpark for interop but exact values aren't required to match.

## 11. Security & trust notes

- **Angle/seat** is bound to the public key and can't be forged without grinding keys.
- **Receipts** authenticate each hop and each gallery entry to a peer identity; the
  **chain accumulator** lets an observer reconstruct/verify hop order from collected
  receipts.
- The **gallery write-gate** is authenticity, not proof-of-participation (§8.2). A malicious
  fork can drop/ignore anything locally (open P2P); the protocol keeps *honest* peers
  consistent. A real reward system needs a validator arbitrating the token chain.
- Country is cosmetic and self-reported.

## Appendix A — app-internal IPC (informative, not on-wire)

The reference build splits worker (protocol) from renderer (UI); they exchange these over
a local IPC bridge. A different client would have its own UI and need not match these —
only §3–§8 are the interop surface.

**Renderer → worker (commands):** `start-wave`, `join-wave`, `set-country {country}`,
`stage-selfie {selfie:{image,caption}}` (the lobby-captured selfie; the worker attaches the
receipt and posts it when the token arrives), `tip {to, amount, peerId}` (send a real TRX
tip to a selfie owner's wallet).

**Worker → renderer (events):** `state {me,peers,successor}`; `gallery {items}`;
`wallet {address, trx}` (self-custodial TRX wallet); `tip-result {hash?, error?}`;
`burn-result {hash?, amount?, error?, waveId, reason}` (a **participation fee** — 1 TRX burned
to Tron's black hole address `T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb`, i.e. the all-zero EVM
address: unspendable by anyone, so the fee proves skin in the game without enriching any
party. `reason: 'kickoff'` for the initiator on `start-wave`, `'join'` for each opt-in on
`join-wave`. Fired alongside the action, never blocking the wave); and
`token` events: `wave-announce`, `paying` (initiator burning the kick-off fee before
announcing), `wave-verified` (kick-off burn proven — join is now allowed), `wave-unpaid`
(kick-off failed verification — wave abandoned), `join-blocked {reason}` (tried to join
before the kick-off is verified), `joined`, `roster`, `wave-active`, `wave-idle`, `busy`,
`started`, `holding {canSelfie,angle,...}` (ball reached me — my staged selfie posts now),
`position`, `forwarded`, `completed`, `healed`, `stalled`,
`proof {waveId,hopCount,count}` (validator collected a hop receipt),
`payout {hopCount,peerId,address,amount,hash}` + `payout-done {paid,reward}` (validator paid
an interlocked reward), `gallery-error`.
