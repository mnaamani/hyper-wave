# Design note — scaling via concurrent waves

**Status:** Proposed / exploratory — **not built.** [`protocol.md`](./protocol.md) is authoritative
for the current, single-wave system; this note explores how to grow past it and deliberately
revisits several baked-in assumptions (`one wave at a time`, `every peer holds every core`, the
global ring). Nothing here is on the wire yet.

**Date:** 2026-07-15

---

## 1. Goal

Support **thousands of peers** on a topic. The current protocol runs **one wave at a time**, and its
feed is **full replication** — every peer opens every participant's Hypercore and converges on a
byte-identical view. This note establishes what actually breaks at that scale, and argues that
**concurrent waves are the sharding mechanism that gets us there** — not a separate feature.

## 2. What scales, and what doesn't (one wave at N = thousands)

Not every mechanism degrades the same way:

| Mechanism                | At N = thousands  | Why                                                                                                        |
| ------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| **The sweep**            | ✅ fine           | Timed slots from intrinsic angles; a dead peer's slot simply passes. Choreographing thousands is cheap.    |
| **`wave-start` writers** | ⚠️ large, fixable | O(N) message, but losslessly compressible (deflate — see `protocol.md` §5 and the TODO backlog).           |
| **Ring / heartbeat**     | ⚠️ O(N) per peer  | Every peer tracks every seat; heartbeat liveness gossip is O(N) churn.                                     |
| **The feed**             | ❌ **the wall**   | Every peer opens **every** participant's core: **O(N) cores per peer, N×N replication.** Falls over first. |

The feed's O(N)-cores-per-peer is the hard ceiling — and it is **the same property that makes it
elegant** (everyone holds every core → byte-identical, no indexer, no admission). You cannot have a
single wave of thousands **and** keep that. Making one wave that big forces you to relax full
replication (sampling, gossiped digests, hierarchical aggregation), which reintroduces exactly the
indexers and partial views the design removed. The **sweep** would still work at thousands; the
**"everyone holds everyone's entry" feed** would not.

## 3. Key insight: concurrent waves = horizontal sharding

Instead of making one wave hold thousands, **spread thousands of peers across many bounded waves**,
each keeping the full-replication feed intact within its small roster. A peer holds cores only for
the waves it **subscribed** to → **O(subscribed), not O(N).** Concurrency is not fighting scale; it
_is_ the shard key.

A second unlock makes this clean: **the sweep needs only the per-wave roster, never the global
ring.** Each id's seat angle is intrinsic (`angleOf(id)`), not relative to other seats — so a wave's
schedule is derived from its own roster alone (see `protocol.md` §6). Per-wave rosters are bounded,
and the global O(N) membership ring becomes **optional** — a visualization nicety, not a correctness
requirement.

## 4. Proposed design

### 4.1 Multiplex the wave FSM

The engine's singleton `let wave` becomes `Map<waveId, WaveState>`; the `lobby → racing → idle` FSM
runs **per wave**. Drop "exactly one wave at a time" and the lower-`waveId`-wins tie-break (they
exist only to enforce the singleton). The gossip wire is already keyed by `waveId`, so most of the
protocol is unchanged — this is largely a state-management refactor.

### 4.2 Subscription layer (the new concept)

Distinguish **aware of** a wave (you received its `wave-announce`) from **participating in** it
(you joined → hold its cores → sweep it). The application **browses discovered waves and joins a
chosen subset**; an un-joined peer may still relay a wave's gossip (flood) but never opens its cores.
This "pick and choose" is the feature the user asked for, and it is exactly what bounds each peer's
core budget.

Per-wave state that is currently singleton and must become per-wave: the feed (already namespaced
`wave-feed:<waveId>`), the `EntryPipeline` (one staged entry per joined wave), the burn-proof
ticket, and the feed lifecycle (keep several open concurrently; close each when **its** wave ends,
dropping the current "wipe/supersede on the next wave" logic).

### 4.3 Transport scoping — the decisive fork

This choice determines whether it truly reaches thousands:

- **Option A — one topic, multiplex.** Simplest. But control gossip (`announce`/`join`/`start`)
  still **floods to every peer on the topic**, so the _control plane_ is O(total activity) seen by
  _everyone_. The feed is subscription-scoped, but the gossip is not. Fine for dozens of waves; does
  not scale the control plane to thousands of peers.
- **Option B — per-wave sub-topics + a light directory (recommended).** A lightweight **directory
  topic** carries only tiny announcements (`{waveId, title, count}`); each wave's heavy traffic
  (`join`/`start`/`sync` + feed replication) lives on its **own topic** `hash(waveId)`, which only
  its participants join. A peer sees traffic for the waves it joined + the directory → **true
  O(subscribed).** One Hyperswarm _instance_ can `join()` many topics (the "two swarm _instances_
  don't discover each other" gotcha does **not** apply to multiple joins on one instance).

**Recommendation: Option B.** It shards the control plane too, and the elegant full-replication feed
survives _inside_ each bounded wave.

### 4.4 The directory (discovery)

With Option B, the directory is the one surface still shared by everyone. Keep it minimal
(announce-only). At **thousands of waves** it cannot flood every announcement to every peer either —
it needs pagination / filtering / an index (a gossiped digest, or a DHT-backed lookup). This is the
**new frontier problem**, but it is far more tractable than N×N feed replication, and it is the right
place to spend the complexity.

## 5. Migration phases

Each phase is independently shippable and testable:

1. **Multiplex the FSM** (still one topic). Concurrent waves work end-to-end; control still floods.
   Unblocks the "pick and choose" UX immediately at small scale.
2. **Subscription layer + per-wave feed lifecycle** (keep multiple feeds open; join/leave).
3. **Per-wave sub-topics** — move `join`/`start`/`sync` + feed replication onto `hash(waveId)`
   topics; add the minimal directory topic. This is where per-peer traffic becomes O(subscribed).
4. **Directory at scale** — index / pagination / filtering. The hard part; deferred until waves
   (not just peers) number in the thousands.

## 6. What we give up / tensions

- **The global "stadium" ring visualization weakens** — with no global membership, the ring becomes
  per-wave. Is the stadium one wave, or a stadium _of_ waves? A product/theme call.
- **Drops the "exactly one wave at a time" rule** and the singleton FSM.
- **Drops "every peer holds every core" as a _global_ property** — it is preserved _per wave_.
- **The directory-at-scale problem is new** (§4.4).

## 7. Invariants preserved

- **No peer roles.** Every peer still runs identical code; the only asymmetry stays per-wave (the
  initiator archives its own wave's cores). Concurrency does not add roles.
- **Money model** (burned fees + tips; no sponsor rewards) is **per wave** and unaffected — each
  wave's participants burn for that wave; tips still go to entry owners.
- **Deterministic sweep** and its per-wave canonical roster snapshot (`wave-start.writers`) are
  unchanged — determinism was always per-wave.
- **Byte-identical, no-indexer feed** is preserved **within each bounded wave** — the whole point.
- **Testnet only**, JSON gossip wire (subject to the §3 encoding note in `protocol.md`).

## 8. Alternative considered — scale a _single_ wave to thousands

Keep one wave; relax the feed via sampling, gossiped digests, or hierarchical aggregation so no peer
holds all N cores. **Rejected:** it dismantles the no-indexer / full-replication / byte-identical
property that defines the feed, and reintroduces partial views (and pressure toward roles). The
sweep alone _could_ scale this way, but the feed cannot without ceasing to be what it is.
Concurrent-waves keeps the feed's design and moves the scaling into a dimension (many bounded waves)
where it is cheap.

## 9. Open questions

- **Directory index**: gossiped digest vs DHT-backed lookup; filtering/paging semantics.
- **Core budget**: how many concurrent waves a peer should hold (memory/replication ceiling) and how
  the UI communicates "you're at capacity."
- **Global ring**: drop entirely, keep as an opt-in visualization, or regionalize?
- **Cross-wave identity/reputation**: out of scope — money and credentials stay per-wave, which also
  keeps sybil surface bounded per wave.
- **`wave-start` compression** still matters if any _single_ wave grows large (see the TODO backlog
  entry + `protocol.md` §5).

---

_See also:_ [`protocol.md`](./protocol.md) (current single-wave spec — §5 `wave-start`, §6 the
sweep, §8 the feed), and the "compress O(N) gossip" entry in [`../../../TODO.md`](../../../TODO.md).
