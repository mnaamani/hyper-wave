# HyperWave — Future Work: What Else Is This Substrate Good For?

HyperWave is a game, but the machinery under it is general. This doc steps back and asks:
what are the properties of "a Chord overlay on top of Hyperswarm, with signed relays,
flooded control messages, per-event multi-writer stores, and built-in self-custodial
payments" — and what real applications would be worth pursuing on it? For each candidate
we look at prior attempts, how they fared, and why the calculus might be different now.

## 1. What the substrate actually provides

Strip away the football and HyperWave is:

1. **A permissionless, self-organising ring.** Identity = an Ed25519 keypair; position =
   derived from the key. No registration, no allocation authority, Sybil-resistant seat
   _placement_ (you can mint identities, but you can't choose where they land).
2. **O(log N) structured routing** (Chord successor lists + fingers + distributed
   `findSuccessor`), with the crucial practical part solved by Hyperswarm underneath:
   **NAT hole-punching and encrypted transport that actually work** on consumer networks.
   Historically this — not the routing math — is what killed deployed DHTs.
3. **Two propagation primitives** with different guarantees:
   - **the token walk** — a serial, _ordered_, per-hop-signed traversal (every hop
     receipted into a constant-size accumulator → an auditable trace of who did what,
     in order);
   - **epidemic flooding** with dedup — unordered, fast, reaches every seat in a few
     rounds on a partial mesh.
4. **Per-event replicated multi-writer state** (an Autobase per wave) with deterministic,
   locally-enforced write rules — cheap to mint, keyed by the event id, converging on
   every interested peer without coordination.
5. **Native economics.** Every peer has a self-custodial wallet in-process (WDK).
   Anti-spam by **provable burn**, peer-to-peer transfers, and on-chain memos as a
   public, timestamped commitment channel. This is the piece almost no prior P2P system
   had: _incentives and costs as a first-class protocol tool_.
6. **Liveness and healing as a habit.** Heartbeats, successor repair, skip-dead-peer
   forwarding — the overlay assumes churn rather than hoping against it.

Two limits carry over to everything below: a **serial token is O(N)** in wall
clock (fine for auditability, wrong for latency-sensitive fan-out — use the flood or the
planned deterministic sweep instead), and **data outlives peers only if someone chooses
to hold it** (there is no protocol-level storage guarantee — a policy/incentive question,
not a routing one).

## 2. Candidate applications

### 2.1 A global distributed key-value store

The most obvious use of Chord — it's literally what the paper proposed (DHash/CFS).
`put(k, v)` routes `k` to its successor; that peer (plus its successor list) stores the
value; `get(k)` routes the same way.

**Prior art and how it went:**

- **DHash / CFS** (Dabek et al., SOSP 2001, on Chord itself) and **PAST** (on Pastry) —
  academically successful, never deployed beyond testbeds.
- **OpenDHT** (Rhea et al., SIGCOMM 2005) — a genuinely public DHT service on PlanetLab
  with a `put/get` API. Ran for years, then shut down (~2009): sustained operation needed
  someone to pay for it, storage was abusable, and applications found it easier to run
  their own infrastructure.
- **Mainline DHT** (BitTorrent, Kademlia-based) — the outlier: **the most successful DHT
  ever deployed** (tens of millions of nodes, running for two decades). Note what made it
  work: values are tiny, _self-certifying_ (infohash → peer list), ephemeral, and nobody
  needs durability — every stored byte is re-announced by interested parties.
- **Dynamo / Cassandra / Riak** — consistent-hashing rings that won _inside the
  datacenter_, where one operator controls membership. The ideas were sound; the open
  Internet was the hard part.
- **IPFS** — content addressing over a Kademlia DHT; found real adoption, but its DHT
  provides _routing_ (who has this hash), not storage — durability comes from pinning
  services, i.e. paid, centralised-ish actors bolted on after the fact.

**Why the open versions stalled:** (a) **no incentive to store** other people's bytes —
altruistic disk donation doesn't survive contact with abuse; (b) **Sybil/eclipse
attacks** — an attacker can surround a key and censor it (Chord's placement helps
HyperWave's _seats_ but a determined attacker can still grind keys near a target);
(c) **churn vs. durability** — replication maintenance traffic explodes when median
session time is minutes; (d) **liability** — a public blob store fills with content
nobody wants to be hosting.

**What's different on this substrate:** the wallet. Storage can be _paid for per key_
(a burn or a streamed micro-payment to the storing successor, receipt-signed), which is
exactly the missing incentive — and the burn-gate pattern already built for waves is the
anti-abuse half. A worthwhile, scoped version is **not** "a global disk" but a
**metadata/rendezvous KV**: small, signed, owner-updatable records (mutable pointers,
profile records, service discovery — the DNS/rendezvous niche Mainline DHT proved works)
with per-record payment and TTLs. That inherits Mainline's success conditions instead of
OpenDHT's failure conditions.

### 2.2 Secure messaging

The ring gives every key a _place_, so it gives every peer a **mailbox location**:
route a message to `successor(recipientKey)`, and that neighbourhood holds it (encrypted,
sender-signed) until the recipient reconnects and collects. Online peers can just be
routed to directly (Hyperswarm already dials by public key).

**Prior art and how it went:**

- **Briar** — P2P, works over Tor/local radios; genuinely good threat model; niche
  adoption. Offline delivery is the pain: with no always-on infrastructure, messages
  wait until both ends overlap.
- **Tox** — DHT-based messaging after the Snowden moment; worked when both peers were
  online; faded — same offline-delivery gap, plus battery/NAT pain on mobile.
- **Scuttlebutt** — append-only signed feeds + gossip; a beloved community and a real
  contribution (social replication), but "pub" servers quietly became necessary
  infrastructure, and onboarding/multi-device stayed hard.
- **Bitmessage** — flood everything to everyone (metadata-hidden but O(network) per
  message); collapsed under its own scaling model.
- **Whisper** (Ethereum) — dark gossip messaging; abandoned for lack of incentives and
  spam control, explicitly replaced by **Waku**, whose v2 redesign added... rate-limiting
  by proof (RLN) and service payments. The lesson written out by its own successor.
- **Matrix / Signal** — the ones that won adoption are _federated or centralised_:
  always-on servers solve offline delivery and push, at the cost of metadata
  concentration.

**The recurring killers:** offline delivery (someone must hold the message — who, and
why would they?), spam (free sends → flooded mailboxes), mobile realities (push
notifications, battery, NAT), and multi-device key management.

**What's different here:** the substrate has a _native answer to exactly two of the four
killers_. Spam: a **postage burn or micro-payment per message** (the wave's join-fee
pattern verbatim — verifiable by the mailbox holder with `verifyBurnTx`-style checks,
priced high enough to kill bulk spam and low enough for humans). Holding incentive:
mailbox peers get **paid postage** for storage-and-forward, receipt-signed so delivery is
provable. Offline push and multi-device remain genuinely open (and are why a serious
attempt should scope to _asynchronous, non-realtime_ messaging first — closer to signed
P2P email than to WhatsApp). Holepunch's own **Keet** shows the realtime end works
(calls/rooms over Hyperswarm without servers); the unclaimed niche is the asynchronous
end with economic spam control.

### 2.3 The token walk itself: ordered, auditable group processes

The wave's specific trick — a signed token visiting every member in a canonical order,
accumulating receipts — is a **distributed round-robin with an audit trail**. That's a
primitive, and it has serious (if unglamorous) uses:

- **Fair rotation:** committee/leader rotation, round-robin duty assignment (who serves
  the next request, who holds the next shard), on-call rotations across mutually
  distrusting parties — with cryptographic proof the rotation was honoured and healed
  around absentees.
- **Token-based mutual exclusion:** the classic ring algorithms (Le Lann; Raymond's
  tree) assumed cooperative LANs; a signed, receipted, heal-on-death token makes the same
  idea auditable across trust boundaries.
- **Attendance / liveness ceremonies:** the lap _is_ a proof that N specific identities
  were live and responsive within a window — a decentralised roll-call (uptime
  attestation for service networks, proof-of-liveness for validator sets, dead-man
  switches across independent parties).

Prior work treated ring/token algorithms as _intra-datacenter_ tools and dropped them
for quorum protocols (Paxos/Raft) once machines were cheap. The open-network,
adversarial variant — where the interesting output is the **signed trace**, not the
mutual exclusion — is mostly unexplored territory.

### 2.4 Presence + geography: the ring as a live map

HyperWave already renders "who is here right now, globally, with flags" with no server.
That generalises to **serverless presence layers**: live audience maps for broadcasts,
watch-parties, flash-mob coordination, disaster-response check-ins ("everyone in region
X mark yourselves safe" — a wave through an affected cohort is literally a roll-call with
proof). Prior art is thin because presence was always the _most_ server-bound feature
(it's the first thing chat services centralise); Hyperswarm's working hole-punching is
the enabling change.

### 2.5 Pub/sub and content distribution

The flood layer + per-topic Autobases ≈ a **topic mesh**: subscribe = join the swarm
topic, publish = flood + append to a replicated log, with burn-priced publishing as spam
control. Prior art: **Scribe** (on Pastry, academic), **GossipSub** (libp2p — deployed
and successful as Ethereum/Filecoin's message bus, but with no economic spam layer;
consensus rules do that job for it), **Coral CDN** (NSDI 2004 — worked, ran for years on
PlanetLab, died with its testbed and its grant money). A paid-topic pub/sub for
communities that want censorship-resistant fan-out is plausible; the open question is
demand — Nostr's relay model currently serves that niche with much simpler engineering
(clients multi-home across dumb servers), and any pursuit here should articulate why
relay-free matters enough to pay the P2P complexity tax.

## 3. The pattern across all the prior failures

Reading the graveyard, the deaths cluster into four causes, and it's worth being blunt
about which ones this substrate actually addresses:

| Failure cause                                             | Examples                                          | Addressed here?                                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **No incentives / no spam cost**                          | OpenDHT, Whisper, most DHT storage                | **Yes** — wallets + burns are first-class (the one genuinely new card)                                                                      |
| **NAT / transport pain**                                  | Tox, early P2P generally                          | **Yes** — Hyperswarm's hole-punching is the whole reason this stack exists                                                                  |
| **Offline delivery / durability needs someone always-on** | Briar, Tox, SSB pubs, IPFS pinning                | **Partially** — payable storage helps, but paid always-on peers are just service providers wearing a P2P hat; design around that            |
| **A centralised/federated rival is simply better UX**     | Matrix/Signal vs P2P chat, Dropbox vs DHT storage | **No** — this never goes away; pick niches where serverlessness is the _point_ (censorship resistance, no-operator liability, ephemerality) |

## 4. Ranked recommendations

1. **Asynchronous secure messaging with paid postage + paid mailboxes** (§2.2) — the
   substrate's economics attack the two failure modes (spam, holding incentive) that
   killed the closest prior art, and the mailbox-at-`successor(key)` design falls
   directly out of the ring. Highest value, hardest remaining problems (mobile push,
   multi-device).
2. **Rendezvous/metadata KV with per-record payment** (§2.1, scoped) — inherits the
   only proven-successful open-DHT niche (Mainline's) and adds the missing
   incentive/anti-abuse layer. Modest, achievable, broadly useful as infrastructure for
   everything else.
3. **Auditable rotation / liveness primitives as a library** (§2.3) — cheap to
   extract from what's already built (the token walk, receipts), novel
   territory, and monetisable B2B (audit trails for multi-party processes).
4. **Presence/map experiences** (§2.4) — closest to the existing product, best
   demo-to-value ratio, but entertainment-shaped revenue.
5. **Paid pub/sub** (§2.5) — only with a sharpened answer to "why not Nostr-style
   relays?".

## 5. Pointers

- Chord/DHash/CFS: Stoica et al. (SIGCOMM 2001); Dabek et al., "Wide-area cooperative
  storage with CFS" (SOSP 2001) — <https://pdos.csail.mit.edu/papers/cfs:sosp01/cfs_sosp.pdf>
- OpenDHT: Rhea et al., "OpenDHT: A Public DHT Service and Its Uses" (SIGCOMM 2005) —
  <https://doi.org/10.1145/1080091.1080102>
- Dynamo: DeCandia et al. (SOSP 2007) —
  <https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf>
- Coral CDN: Freedman et al. (NSDI 2004) —
  <https://www.cs.princeton.edu/~mfreed/docs/coral-nsdi04.pdf>
- GossipSub spec: <https://github.com/libp2p/specs/tree/master/pubsub/gossipsub>
- Waku (Whisper's successor, incl. its incentive/RLN rationale) — <https://waku.org/>
- Briar — <https://briarproject.org/> · Scuttlebutt — <https://scuttlebutt.nz/> ·
  Matrix — <https://matrix.org/>
- Keet (Holepunch's serverless messenger on this same stack) — <https://keet.io/>
- Raymond, "A tree-based algorithm for distributed mutual exclusion" (TOCS 1989) — the
  token-passing mutual-exclusion lineage.

See [`research.md`](./research.md) for the foundational papers behind the current build,
and [`scalable-topology.md`](./scalable-topology.md) §3B for the propagation-at-scale
decision any of these would inherit.
