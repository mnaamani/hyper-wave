# Design note — scaling via concurrent waves

**Status:** **Phases 1–3 built** — the FSM is multiplexed (concurrent waves), a subscription layer
bounds each peer's core budget to O(subscribed), and control gossip is scoped to a wave's
subscribers (with per-wave sub-topics for discovery). Phase 4 (directory at scale) remains proposed
/ exploratory. [`protocol.md`](./protocol.md) is authoritative for the on-wire protocol; this note
tracks the growth path and the baked-in assumptions it revisited (`one wave at a time` — dropped —
`every peer holds every core` — now per-subscribed-wave — the global ring).

**Date:** 2026-07-15 (Phase 1) · 2026-07-16 (Phases 2–3)

---

## 1. Goal

Support **thousands of peers** on a topic. The current protocol runs **one wave at a time**, and its
feed is **full replication** — every peer opens every participant's Hypercore and converges on a
byte-identical view. This note establishes what actually breaks at that scale, and argues that
**concurrent waves are the sharding mechanism that gets us there** — not a separate feature.

## 2. What scales, and what doesn't (one wave at N = thousands)

Not every mechanism degrades the same way:

| Mechanism                | At N = thousands | Why                                                                                                                          |
| ------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **The sweep**            | ✅ fine          | Timed slots from intrinsic angles; a dead peer's slot simply passes. Choreographing thousands is cheap.                      |
| **`wave-start` writers** | ✅ capped        | Bounded by `MAX_WRITERS` (256) — a wave seats at most that many; the O(N) payload is now O(1). Deflate is an optional extra. |
| **Ring / heartbeat**     | ⚠️ O(N) per peer | Every peer tracks every seat; heartbeat liveness gossip is O(N) churn.                                                       |
| **The feed**             | ❌ **the wall**  | Every peer opens **every** participant's core: **O(N) cores per peer, N×N replication.** Falls over first.                   |

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

### 4.1 Multiplex the wave FSM ✅ **built**

The engine's singleton `let wave` became `Map<waveId, WaveState>`; the `lobby → racing → idle` FSM
now runs **per wave**. "Exactly one wave at a time" and the lower-`waveId`-wins tie-break are gone
(they existed only to enforce the singleton — `shouldAdopt` → `canAdopt`, just the `endedWaves`
check). Each `WaveState` owns its own timers, `EntryPipeline`, roster (`writers`), and paid-gate
status; `CrdtFeed` holds every engaged wave's feed at once and emits `onFeed(waveId, items)`. The
gossip wire is already keyed by `waveId`, so it is unchanged — this was a state-management refactor.
The public command surface stays backwards-compatible: `join(waveId?)` / `stageEntry({waveId?})`
default to the newest joinable / joined wave, and the host's `feed` message gains an additive
`waveId`. Control gossip still floods to every peer on the topic (that is §4.3, Phase 3).

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

1. ✅ **Multiplex the FSM** (still one topic) — **done.** Concurrent waves work end-to-end; control
   still floods. Unblocks the "pick and choose" UX immediately at small scale. (Engine-internal;
   the host UI still shows one feed per wave, keyed by the feed's `waveId`.)
2. ✅ **Subscription layer + per-wave feed lifecycle** — **done.** A wave you're merely AWARE of
   (saw its announce) opens no cores; `subscribe()` opens its feed and `unsubscribe()` closes it
   (join/leave lifecycle) — `autoSubscribe` (default true) subscribes on awareness for the demo UX,
   false gives true browse-then-pick. `join()` implies subscribe. Core budget → O(subscribed).
3. ✅ **Per-wave scoping + sub-topics** — **done.** A wave's join/start/sync are forwarded only to
   neighbours that advertised (via a one-hop `subs` message) they're subscribed to it, so control
   traffic is O(subscribed); the tiny wave-announce still floods the directory (the browse surface,
   with a unicast catch-up re-announce on connect). Each subscribed wave also joins its own
   sub-topic `hash(prefix:topic:wave)` so its participants discover each other off the O(N) mesh.
   Feed replication auto-scopes (a peer only opens cores for waves it subscribed to). Implemented as
   ONE Protomux channel per connection with software send-scoping (per-wave Protomux sub-channels
   were tried first but the dynamic-open pairing races the first flood — the `subs` filter is
   simpler and self-heals via the sync-on-mutual-subscription).
4. **Directory at scale** — index / pagination / filtering (+ the O(known-waves) connect catch-up).
   The hard part; deferred until waves (not just peers) number in the thousands.

## 6. What we give up / tensions

- **The global ring visualization weakens** — with no global membership, the ring becomes
  per-wave. Is there one global ring of participants, or a ring _per_ wave? A product/theme call.
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
- **`wave-start` compression** is now optional — the roster cap (`MAX_WRITERS` = 256, `protocol.md`
  §5) bounds a single wave's `writers` payload to a constant, so deflate is an efficiency nicety, not
  a scale requirement (TODO backlog).

---

_See also:_ [`protocol.md`](./protocol.md) (current single-wave spec — §5 `wave-start`, §6 the
sweep, §8 the feed), and the "compress O(N) gossip" entry in [`../../../TODO.md`](../../../TODO.md).
