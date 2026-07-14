# HyperWave — Scalable Topology (design / plan)

**Status: largely historical.** The Chord phases below were built, verified, and then progressively simplified away once the sweep (§3B) removed every routing need. As built today, the topology is: DHT discovery + **`PIN_BUDGET` sticky random pins** (`pins.js` — random-K replaced the structured ring pinning, §4.3) + churn cooldown + a liveness-only heartbeat (§4.4) + **control-plane flooding** (§4.6) + **the deterministic sweep** (§3B / Phase 5 — it **replaced** the serial token). The distributed `findSuccessor` routing (§4.5) and the ring/finger pin rule (§4.3) were each built, verified, then **retired**. See §8 for remaining items. This doc remains the design record for making HyperWave scale
from a handful of peers to a large, global swarm by aligning our logical ring with the
physical Hyperswarm connection graph — the "make the ring drive connections" idea.

Read [`protocol.md`](./protocol.md) and [`architecture.md`](./architecture.md) first.

## 1. Problem

Originally the ring was a **pure logical overlay**: `angle = f(pubkey)` over _all_ peers,
with no relationship to Hyperswarm's actual connection graph. It worked only because
Hyperswarm **fully meshes small swarms**, so every successor edge happened to be a physical
connection.

Past the mesh limit Hyperswarm connects each peer to an arbitrary _subset_, and the overlay
and the physical graph **diverge**: the (then-serial) token could only be forwarded to a
_reachable_ successor, so the ring silently degraded to "next _reachable_ clockwise" —
skipping peers, approximate order. Root cause: **the overlay doesn't influence which peers
we connect to.**

## 2. Goal & principles

Make the wave work at large scale **without a full mesh**, while keeping the wave mechanic,
gallery, and lifecycle behind clean seams (`ring.js` geometry, `chord.js` pointer math).

- **The ring drives connections (Chord).** Each peer deliberately connects to its
  successor(s), predecessor, and a capped set of long-range _fingers_ — not to everyone.
- **Reuse Hyperswarm.** `swarm.peers` (DHT discovery) for ring membership; `swarm.joinPeer(key)`
  to make ring edges physical; `conn.remotePublicKey` for identity (already used).
- **Isolate the change.** All of it lives behind `successor` / a new `chord` module; the
  wave engine (`wave.js`) keeps calling "who is my successor?".

## 3. Two axes of scale (both matter)

Scaling has **two independent axes**; this plan's primary focus is (A).

**(A) Connectivity, discovery, routing → Chord.** You cannot full-mesh 10k peers. This is
the concrete work below: O(log N) connections + lookup.

**(B) Propagation _time_ → deterministic sweep — IMPLEMENTED (it replaced the token).** A
_serial_ token lap is inherently `O(N)` — each hop adds a network round-trip, so at
N=10,000 the lap takes many seconds even at network speed, which defeats "a wave." Chord
fixes connectivity, **not** lap time. So the propagation model is now the **deterministic
angular sweep** from the original design: `wave-start` floods `(roster, t0, lapMs)` and
every peer _independently_ derives the identical angle-ordered schedule (`sweep.js`:
dedupe, sort by angle with id tie-break, `slot = t0 + round(rank/count × lapMs)`) and
self-triggers at its own slot — the whole ring lights up in one fixed-duration lap
regardless of N, O(1) per peer, no serial passing, no healing (a dead peer's slot simply
passes).

Trade-off (accepted): the sweep drops the **interlocked receipt chain** (each receipt
depended on the predecessor's), because there is no serial hand-off. With sponsor rewards
removed this no longer affects payments (there are none) — the gallery write-gate is now an
independent per-seat proof (the signed **join attestation**, `protocol.md` §2.2), and the
receipt/accumulator machinery was deleted along with the token. The earlier "keep serial
for small waves, sweep for global" option was **not** kept — the sweep is the only
propagation model (one code path; a small roster just gets a `MIN_LAP_MS` floor so the lap
stays visible).

Note the sweep's `(t0, lapMs, roster)` params are exactly what the **control-plane flood**
(§4.6) delivers to every seat — the flood is the kickoff's delivery mechanism, and the only
in-race traffic the wave needs at all.

## 4. Chord design (axis A)

### 4.1 Identifier space

`nodeId(pubkey)` = top 8 bytes of the key as an unsigned 64-bit integer; the ring is
`mod 2^64`. (`angle` stays for display, derived from the same bytes.) 64 bits gives finger
headroom without BigInt-heavy math getting silly; revisit if collisions matter at extreme N.

### 4.2 Membership discovery

- Seed the peer set from **`swarm.peers`** (PeerInfo public keys on the topic) and refresh
  on `swarm.on('update')` — DHT discovery gives ring members before/without gossip.
- Liveness + country ride the **`heartbeat`** to pinned neighbours (no separate presence
  message; it carries no ring structure — see §4.4). Drop the O(N) full `peers` snapshot (§4.6). (There is no `role` field — every peer
  is equal; see §4.7.)

### 4.3 Pointers & connections (the core change)

Maintain, per node:

- **successor list** — the next `k` nodes clockwise (k≈3) for fault tolerance;
- **predecessor**;
- **finger table** — `finger[i]` = first node ≥ `(nodeId + 2^i) mod 2^64`, for i in 0..63.

`swarm.joinPeer()` the successor(s), predecessor, and long-range fingers. Stop depending on
Hyperswarm's incidental meshing for the ring.

**RETIRED — superseded by random-K pins (`pins.js`).** This section's structured pin rule
went through two implemented generations (full O(log N) finger table, then successor-list

- predecessor + the 3 farthest fingers ≈ 7 pins) before being replaced outright: with the
  sweep, nothing consumes successor/predecessor, so ring-shaped pins only bought a
  _deterministic_ connectivity proof. Measured at N=128 (200 fresh graphs/config, the real
  Flood decision, 10% simultaneous kills), **random K=7 pinning matched the ring's 100%
  flood reach and beat it on diameter** (4 rounds flat vs 4.9–6 — uniform random edges are
  better long-range shortcuts than fingers); the reach cliff sits at K≤3. So `wave.js` now
  holds `PIN_BUDGET = 7` **sticky random pins** (kept while alive, topped up on churn —
  never reshuffled), and `chord.js` (nodeId math, successors, predecessor, fingers) is
  deleted. What pinning still buys over no pinning at all: the pins are edges we _chose_ —
  dialed with priority, immune to `maxPeers` — a floor under the flood graph that doesn't
  depend on Hyperswarm's incidental mesh being unbiased (DHT lookup order, join cohorts,
  NAT islands, cap contention). Accepted downside: connectivity is now probabilistic
  rather than proven — see `pins.js`'s header for the full reasoning and the escape hatch
  (raise `PIN_BUDGET`, or resurrect the ring rule from git history).

### 4.4 Stabilization — **removed (the sweep needs none)**

Chord's stabilize/notify protocol (and the succ/pred pointer advert that carried it) was
built, then **removed with the token walk**: pointer _precision_ only mattered while a
serial token had to find its true successor. As built now:

- pins are recomputed on every topology refresh purely from **DHT discovery + live
  connections** (`pinTargets` inside `maintainNeighbours`) — that recompute is the only
  "fixFingers"-like step, and it needs no gossip;
- the `heartbeat` carries **no ring structure** (liveness + country only);
- **churn:** on a pinned connection's close, re-pin immediately (the next successor-list
  entry and a recomputed far-finger set take over).

### 4.5 Routing / lookup — **retired (built, verified, then removed with the token)**

`findSuccessor(target)` = standard Chord lookup: route the query through fingers,
O(log N) hops, so it resolves to the correct successor **even when no single peer knows the
whole ring**. This existed to make the _serial token walk_ correct under partial membership
knowledge — a forwarder had to know its true successor precisely.

It **was built and verified**: a pure per-hop `findSuccessorStep` in `chord.js`, a
`find-succ`/`find-succ-reply` transport RPC (`chord-routing.js`), join-time self-placement
(`findSuccessor(me + 1)` through a seed) and periodic successor repair — tested over
simulated 64-node partial-knowledge networks and end-to-end on the local DHT.

Then the **sweep replaced the token** (§3B), and successor precision stopped mattering:
every peer computes its own slot from the flooded canonical roster, so nothing is ever
routed to "the successor" at all. The control plane only needs a connected flood graph
(§4.3/§4.6). So `chord-routing.js`, the `find-succ`/`find-succ-reply` messages, join-time
self-placement, and the periodic successor repair were **deleted**. `chord.js` keeps the pointer math
(ringOrder/successors/predecessor/fingers/farFingers) that drives pinning purely from
local knowledge (DHT discovery + live connections).

### 4.6 Gossip slimming & flooding

Two changes, both implemented:

- **Slim the membership plane.** The O(N) `peers` snapshot became a pointer exchange,
  which was then slimmed again to a bare **`heartbeat`** (id + country, O(1), to pinned
  neighbours only) once the sweep removed the need for pointer precision (§4.4).
  Membership is DHT-discovered but **liveness-gated** — `swarm.peers` drives
  _who we dial_ (pinning), while a ring **seat** requires a real connection or direct gossip,
  so a stale announce can't become a ghost seat.
- **Flood the lifecycle plane.** The one-hop broadcast that §4.6 originally kept for `wave-*`
  only works on a full mesh — past the mesh limit an announce would reach ~1% of a partial
  random mesh. So `wave-announce` / `wave-join` / `wave-start` are **flooded**: each carries
  a unique `mid`, and a peer relays it to its other neighbours **on first sight**, dropping
  repeats (pure `flood.js`, verified for reach over synthetic partial meshes in
  `flood.test.js`; at the `GOSSIP_SEEN_CAP` the dedup set evicts **oldest-first** instead of
  wholesale clearing). On the random mesh (diameter ≈ log N / log degree) this blankets
  every seat in a few relay rounds. `wave-join` **publishes the joiner's own gallery core**
  (writer key + join attestation + optional burn ride it to _every_ peer, each of which opens
  that core — the CRDT gallery, §4.7) — it's authenticated by its carried join signature, so
  relaying is sound. The token-era `wave-pos`, `wave-end`, and flooded `add-writer` messages
  no longer exist (§3B): the ball animates from the local schedule, the wave ends on a local
  deterministic timer, and there is no admission step at all — a peer posts to its own core.

**`wave-sync` on connect** stays essential as the catch-up path for a peer that joins after a
flood has already passed.

### 4.7 Gallery replication over a partial mesh — **CRDT: every participant holds every core**

The gallery is a **multicore CRDT** (`protocol.md` §8): each participant owns one Hypercore
and appends its single selfie op at block 0; its key rides the flooded `wave-join`. **Every
peer** that sees a join opens that participant's core and downloads block 0, so a peer already
holds the cores of every participant it has heard of — there is no single Autobase, no
indexer, and no shared key. `Corestore.replicate(conn)` runs on every connection; selfie
images are **inline** (JSON dataURL, no separate Hyperblobs), so these per-participant cores
are the only set to propagate. The ordered view is a **pure local merge** (`mergeGallery`):
the same set of cores yields a byte-identical gallery on every peer, so convergence is purely
epidemic ("have I replicated core X?").

**Transitive reach is proven.** The A/B benchmark (`gallery.replication.bench.test.js`) runs
the old single-indexer Autobase gallery (Path A) and the multicore CRDT (Path B) over the
_same_ synthetic partial mesh and asserts **both converge fully** — Path B spreads each
participant's core epidemically with no indexer/admission (measured ~28% faster, no SPOF). The
line-topology case (`gallery.replication.test.js`, still on the Autobase baseline) confirms
the underlying transitive property directly: over A—B—C wired A↔B and B↔C but _not_ A↔C, C's
writes converge to A **purely through B**. So Hypercore/Corestore forwards cores along
connected (ring/finger) paths when intermediates keep them open — no full mesh required.

**Persistence — none needed (the gallery is a CRDT).** There are **no peer roles** (no
validator/seed archivist hub). Every peer is equal and wipes its store per run, so a gallery
only lives while its wave's cores are open. With the multicore CRDT gallery every participant
already replicates every participant's core during the wave, so a departing peer's selfie
survives in everyone's view and any peer could serve the whole gallery — there is no indexer,
no archivist, and nothing to retain. Once a new wave supersedes the old one, its cores are
closed (galleries are ephemeral — no "past waves" feature).

## 5. Migration behind the seam

```mermaid
flowchart LR
  subgraph Now["small (incidental full mesh)"]
    A1["Hyperswarm full mesh"] --> A2["liveRing = all live peers"] --> A3["neighbours = everyone"]
  end
  subgraph Next["scalable (as built)"]
    B1["swarm.peers discovery + joinPeer pins"] --> B2["successor-list, predecessor, far fingers (local math)"] --> B3["constant pin budget (~7)"]
  end
  A3 --> Seam["connected flood graph"]
  B3 --> Seam
  Seam --> Wave["lifecycle floods · sweep schedule · gallery replication"]
```

`ring.js` keeps exposing the geometry (`angleOfId`, `nextClockwise` for display); the wave
itself no longer consumes a successor at all — the sweep derives every slot from the
flooded roster, so the topology's only job is to keep the flood graph connected and the
gallery cores replicating.

## 6. Phases (each shippable + testable)

1. **Discover via `swarm.peers`** — seed the peer map from DHT discovery (additive, low
   risk; ring converges faster, less gossip). **✅ Done:** `wave.js` `discoveredIds()` walks
   `swarm.peers` (PeerInfo keyed by hex key) into the ring (consumed by
   `maintainNeighbours()`), fired on `swarm.on('update')`,
   after `discovery.flushed()`, and each `RINGUPDATE_MS` tick; peers are refreshed while
   discoverable and TTL-pruned once Hyperswarm GCs them. (At the time, token forwarding
   still targeted only _connected_ peers, so this was purely additive.)
2. **`joinPeer` successor + predecessor (+ successor-list)** — make ring edges physical;
   keep full-ring gossip as a fallback initially. **✅ Done:** pure `lib/chord.js`
   (`nodeId`/`successors`/`predecessor`/`connectionTargets`, brittle-tested in
   `chord.test.js`) computes the target neighbour set; `wave.js` `maintainNeighbours()`
   diffs it against a `pinned` set and `swarm.joinPeer`/`leavePeer`s the delta on every
   topology refresh (k=3 successors + predecessor). `leavePeer` only drops the explicit
   pin, so the topic-driven full mesh remains as the fallback until Phase 3.
3. **Finger table + `fixFingers`** — long-range edges; drop full-mesh reliance. **✅ Done
   (now capped):** `chord.js` adds `fingers(ids, myId)` (finger[i] = successor of
   `myNid + 2^i`, i in 0..63, deduped to O(log N) distinct nodes) and `farFingers` (the
   `FAR_FINGERS = 3` farthest by clockwise ring distance), composed into `pinTargets` =
   successor-list ∪ predecessor ∪ far fingers (§4.3 — a constant pin budget). `wave.js`
   `maintainNeighbours()` pins `pinTargets`; recomputing the fingers on each topology
   refresh _is_ `fixFingers`. Brittle-tested in `chord.test.js`. The far-finger set spans
   the ring so flood reach no longer depends on the incidental mesh.
4. **`stabilize` + churn handling + slim gossip** — remove the O(N) `peers` snapshot.
   _(Historical: the pointer advert + stabilize step built here were themselves removed
   after the sweep landed — the heartbeat is now liveness-only, §4.4.)_
   **✅ Done:** the O(N) `peers` snapshot is gone; membership is DHT-discovery-first
   (`swarm.peers`) plus a compact **`pointers`** advert (successor-list + predecessor,
   O(k + log N)) sent only to pinned neighbours — it doubles as the liveness heartbeat.
   `chord.js` added `inOpenInterval` + `stabilizeStep` (brittle-tested); a `pointers` from
   my current successor whose predecessor sits between us triggers an immediate re-pin
   (nextClockwise then adopts the closer successor). Churn: on a pinned-neighbour close we
   re-pin immediately (successor-list failover / finger repair), and a churn cooldown
   stops DHT re-seeding from resurrecting a just-dead peer. Verified end-to-end on the local
   DHT: 4 peers converge + gallery replicates with the slim gossip; killing a node mid-wave
   leaves no ghost seat (at the time, the token healed around it; today its slot simply
   passes).
5. **Propagation at scale — the deterministic angular sweep.** **✅ Done (it replaced the
   serial token):** `sweep.js` derives the identical angle-ordered schedule on every peer
   from the flooded `(roster, t0, lapMs)`; each peer self-triggers at its own slot, the ball
   animates from the local schedule, and the wave ends on a local deterministic timer
   (§3B; `protocol.md` §6). The token walk, receipts/accumulator, healing, `wave-pos`,
   `wave-end`, and the distributed `findSuccessor` routing (§4.5) were deleted with it.

## 7. Testing

- **Pure unit tests (brittle):** `nodeId` from key; finger targets + the far-finger cap;
  successor-list/predecessor/pin targets. Put the ring math in a
  pure module (`packages/hyperwave-engine/lib/chord.js`) so it's unit-testable without a swarm.
- **Partial-topology flood harness** (`flood.test.js`): drives the real per-node flood
  decision (`flood.js`) over synthetic graphs (line, ring, star, random partial mesh,
  disconnected) — Hyperswarm full-meshes small swarms, so this is how we prove **relay
  reach** without the transport. Asserts full reach in the connected component, exactly-once
  dedup, sends ≤ 2·|E|, and diameter-ish rounds (the N=200 partial mesh asserts full reach
  within a ≤ 20-round bound; a disconnected component is correctly _not_ reached).
- **Line-topology gallery replication + initiator persistence** (`gallery.replication.test.js`):
  real Corestores/Autobases with no swarm. (1) A↔B, B↔C (no A↔C) — the gallery replicates
  _transitively_ (C converges to A's writes through B). (2) with the CRDT gallery every participant holds every
  gallery, other participants leave, a latecomer connected _only_ to the initiator still gets
  the full gallery. The §4.7 reach + persistence tests (on the Autobase baseline).
- **Gallery CRDT** (`gallery-crdt.test.js`) + **the A/B replication benchmark**
  (`gallery.replication.bench.test.js`): the CRDT gallery's per-participant cores, block-0-only
  download, and one-per-peer merge, plus a controlled compare that runs the old single-indexer
  Autobase (Path A) and the multicore CRDT (Path B) over the _same_ partial mesh and asserts
  both converge fully (§4.7).
- **Local DHT integration** (`dht-local.js` + the e2e harness): N processes; assert the ring
  converges, a wave's roster converges, every roster member's sweep slot fires, and the
  gallery replicates across the partial mesh.
- **Churn:** kill a node mid-wave; assert re-pin failover; the
  sweep is unaffected (the dead peer's slot passes) and the wave still ends on time.

## 8. Remaining work / risks

Everything structural is built: Phases 1–4, the control-plane flood, the capped far-finger
pin budget (§4.3), **and the sweep** (§3B / Phase 5 — the O(N) serial token is gone, so
wave duration is a chosen constant at any N). Gallery reach + per-wave persistence are
covered too (§4.7), and the **single-indexer gallery bottleneck/SPOF is now resolved**: the
gallery is a **multicore CRDT** (one core per participant, merged locally — no indexer, no
admission funnel; §4.7 / `protocol.md` §8), so the old O(N) fan-in/out through the initiator
and its live SPOF are gone. What remains is validation and a few bounded refinements:

1. **Unpin hysteresis.** The `maintainNeighbours` "never unpin a live channel" rule folds
   every live connection back into the pin set (deliberate — pin flapping is what broke the
   old token walk), so at small/medium N the pinned graph is effectively the whole
   topology. A truly bounded neighbour count at large N needs hysteresis on unpinning
   (drop a stale pin only after it has been out of `pinTargets` for a while), not just the
   constant target set.
2. **Large-N churn/flood validation.** The flood harness proves reach over synthetic
   partial meshes, and a 128-peer local run validated the lifecycle at that scale under the
   token era — **re-run the 128-peer dispatch on the sweep build** (roster convergence,
   every slot fires, deterministic end) and push N/churn further. Real partial-mesh
   behaviour (Hyperswarm connection caps + churn) can't be fully forced locally.
3. **Replication-lag measurement (§4.7).** Transitive gallery reach is proven; convergence
   _lag_ at depth/scale is unmeasured (how long until a far peer's gallery settles as its
   participant cores replicate through the mesh).
4. **No late joins — deliberate.** A peer whose `wave-join` misses the lobby close is a
   spectator: the roster freezes into the schedule at lobby close, so a late join can't take a
   slot it could never fill. (There is no admission step to be late for — a participant owns
   its own core — but the roster/schedule snapshot is still fixed at one moment.) A
   late-join fallback was considered and **deliberately dropped** for the MVP, so the roster,
   the schedule, and the paid gate all derive from the same snapshot.

Secondary: no explicit periodic `checkPredecessor` (conn-close covers it today); and Chord
remains real code — keep the pointer math isolated and pure (`chord.js`) so a bug can't
destabilize the wave logic.

## 9. Wow factor

A wave that is genuinely global: **thousands of peers, no servers**, a ⚽ sweeping a
worldwide ring in one fixed-length lap, selfies flooding a shared gallery, flags lighting a
**world map** as they arrive — and (with the payment layer) real self-custodial
micro-payments riding it. Chord-over-Hyperswarm plus the deterministic sweep is what makes
"the whole planet in one wave" technically real rather than a demo of five laptops.
