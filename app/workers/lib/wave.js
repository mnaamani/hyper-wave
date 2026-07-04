// HyperWave orchestrator. Wires the transport (Hyperswarm + Protomux gossip) to the
// three pure domains — ring geometry (ring.js), the token race (token.js), and the
// selfie gallery (gallery.js). Runs under Bare (the worker) or Node harness.
// The Bare worker (hyperwave.js) bridges this to the renderer; wave.run.js drives it
// headlessly. The payment layer will attach here as its own module.

const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const Autobase = require('autobase')
const Protomux = require('protomux')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const fs = require('bare-fs')

const { angleOf, angleOfId, liveRing, nextClockwise, pickReachable } = require('./ring')
const {
  pinTargets,
  successors,
  predecessor,
  stabilizeStep,
  findSuccessorStep,
  closestPrecedingNode,
  nodeIdOfHex,
  RING
} = require('./chord')
const { createFlood } = require('./flood')
const {
  ZERO_HASH,
  signReceipt,
  verifyReceipt,
  verifyToken,
  advanceChain,
  signBurn
} = require('./token')
const { galleryConfig, readGallery, readBurns } = require('./gallery')

const MATCH = 'hyperwave:demo-match:v1'
const PRESENCE_MS = 2000 // heartbeat cadence
const RINGUPDATE_MS = 4000 // pointer-exchange + re-pin cadence (Phase 4 slim gossip)
const TTL_MS = 12000 // drop peers not refreshed within this window
const MAX_HOPS = 5000 // safety cap against runaway tokens
// Dwell per hop — kept minimal so the ⚽ races around the ring quickly. The selfie is
// captured up-front in the lobby (not during the race), so the dwell never has to cover
// a human; it's purely the visible roll pace. Configurable per wave.
const HOP_DELAY_MS = 250
// Lobby: after "kick off", the wave is announced and peers get this long to opt in
// (get ready / choose to selfie) before the token starts racing.
const LOBBY_MS = 15000
// A wave is a single, one-at-a-time event. If it doesn't complete within this
// window (peer dropped, stall), peers fall back to idle so a new wave can start.
const WAVE_TIMEOUT_MS = 90000
// After forwarding, if the wave doesn't advance past my hop within this window,
// treat the successor as dead: skip it and re-forward to the next live peer. The
// `wave-pos` a peer broadcasts when it holds doubles as the ACK.
const HEAL_TIMEOUT_MS = 3000
// Successor-list length (scalable-topology.md §4.3): how many peers clockwise we
// deliberately connect to for fault tolerance. Predecessor is pinned too.
const K_SUCCESSORS = 3
// Wave lifecycle control messages that must reach *every* peer (not just direct
// neighbours). At scale Hyperswarm is only a partial random mesh, so these are
// flooded — relayed hop-to-hop with per-message dedup (protocol.md §3.1). The chatty
// `wave-pos` is deliberately NOT relayed (its heal-ACK only needs the predecessor).
const RELAYED_KINDS = new Set(['wave-announce', 'wave-join', 'wave-start', 'wave-end'])
// Cap on remembered message ids (flood dedup). Cleared wholesale when exceeded — a
// straggling duplicate might then re-flood once, which is harmless and very rare.
const GOSSIP_SEEN_CAP = 4096
// Distributed findSuccessor routing (§4.5): safety cap on lookup hops (O(log N)
// expected), how long the origin waits for a reply, and how long a routing-discovered
// successor stays a pin candidate.
const LOOKUP_TTL = 24
const LOOKUP_TIMEOUT_MS = 5000
const ROUTED_TTL_MS = 30000
// After my first connection, wait this long (for a few fingers to connect → better
// routing start) then place myself in the ring via findSuccessor (Chord join, §4.5).
const BOOTSTRAP_MS = 1500

function shortId(hex) {
  return hex.slice(0, 8)
}

function createWave({
  storageDir,
  onState,
  onToken = () => {},
  onGallery = () => {},
  log = () => {},
  bootstrap = null,
  matchId = MATCH,
  hopDelayMs = HOP_DELAY_MS,
  waveTimeoutMs = WAVE_TIMEOUT_MS,
  healTimeoutMs = HEAL_TIMEOUT_MS,
  lobbyMs = LOBBY_MS,
  role = 'peer' // 'peer' | 'validator' (a.k.a. seed): keeps galleries alive after peers leave
}) {
  // A validator/seed is a first-class swarm peer whose job is to make the gallery survive:
  // it opens every wave's gallery and RETAINS it (never closes, store not wiped), so it can
  // keep serving it once participants disconnect. Regular peers are ephemeral per-run.
  const isSeed = role === 'validator' || role === 'seed'
  // Prune old galleries (peers only): the store is per-run (galleries keyed by random
  // waveId, nothing persists across runs), so wipe it on startup to reclaim disk. A seed
  // instead keeps its store so it archives galleries across runs.
  const storePath = storageDir + '/hyperwave'
  if (!isSeed) {
    try {
      fs.rmSync(storePath, { recursive: true, force: true })
    } catch {}
  }
  const store = new Corestore(storePath)
  // bootstrap: pass a local DHT for instant same-machine discovery (tests / single
  // -laptop demo). Omit for the public DHT (cross-machine, ~20-35s cold discovery).
  const swarm = new Hyperswarm(bootstrap ? { bootstrap } : {})

  const meKey = swarm.keyPair.publicKey
  const me = { id: b4a.toString(meKey, 'hex'), angle: angleOf(meKey), country: null }
  let walletAddress = null // my TRX wallet address (set by the worker once WDK is ready)
  const peers = new Map() // id -> { id, angle, lastSeen, country }
  const senders = new Map() // peerId -> gossip message send fn (for direct forwarding)
  const pinned = new Set() // ids we've swarm.joinPeer()'d (our physical ring edges)
  const goneUntil = new Map() // id -> ts: suppress re-seeding a just-closed peer (churn)
  const routed = new Map() // id -> expiry: successor found via distributed lookup (pin candidate)
  const pendingLookups = new Map() // qid -> { resolve, timer }: findSuccessor lookups I originated
  const lookupRoute = new Map() // qid -> upstream id: reverse path to return a lookup reply
  let bootstrapTimer = null // one-shot join-time findSuccessor placement
  let bootstrapDone = false
  const seen = new Set() // waveId|hopCount already processed (drop dupes/loops); cleared per wave
  const endedWaves = new Set() // waves that finished — never re-adopt (prevents revival)
  const flood = createFlood({ cap: GOSSIP_SEEN_CAP }) // flood dedup for relayed control msgs

  let base = null // the CURRENT wave's gallery Autobase (created by originator, opened by others)
  let autobaseKey = null // hex bootstrap key of `base`, shared via gossip + token
  let currentWaveId = null // which wave `base` belongs to (galleries are per-wave)
  const galleries = new Map() // waveId -> base: a seed retains every gallery it opens
  const seedPeers = new Set() // ids advertising role=validator — pin them (well-connected seed)
  const proofs = new Map() // (validator) waveId -> Map(hopCount -> proof): collected hop receipts

  // Wave lifecycle: idle -> lobby -> racing -> idle. One wave engaged at a time;
  // concurrent starts resolve deterministically (lower waveId wins). During the
  // lobby, peers opt in; only opted-in peers (the roster) get a selfie prompt — the
  // ball still visits everyone (relays), keeping the full-ring visual.
  //   wave = { id, phase: 'lobby'|'racing', by, roster: Set<id>, joined: bool } | null
  let wave = null
  let lobbyEndsAt = 0 // ~when the lobby closes (for syncing a late joiner's countdown)
  let lobbyTimer = null // fires the race (initiator) or a fallback to idle (others)
  let waveTimer = null // racing timeout
  let healTimer = null // watches my forward; fires if the wave doesn't advance
  let healPending = null // { waveId, hop } I'm currently watching

  // Selfie is captured up-front during the lobby (renderer stages it here), then posted
  // to the gallery when the token actually reaches me — signed with my hop's receipt.
  let stagedSelfie = null // { image, caption } captured in the lobby, awaiting my hop
  let myReceipt = null // my hop's receipt once the token reaches me, awaiting the selfie
  let selfiePosted = false // guard: post my selfie exactly once per wave
  let pendingBurn = null // signed burn-proof attestation, awaiting a gallery write (my hop)
  let burnPosted = false // guard: post my burn-proof exactly once per wave
  let admissionPromise = null // in-flight add-writer request (shared by concurrent posters)

  // --- ring / peer table -----------------------------------------------------
  function emit() {
    const ring = liveRing([...peers.values()], Date.now(), TTL_MS)
    onState({ me, peers: ring, successor: nextClockwise(me.angle, ring) })
  }

  // Angle is always derived from the peer id, never trusted from the wire. Country
  // is the nation a peer supports (self-reported flag, purely cosmetic).
  function upsert(id, lastSeen, country) {
    if (id === me.id) return
    const cur = peers.get(id)
    if (!cur || lastSeen > cur.lastSeen) {
      peers.set(id, {
        id,
        angle: angleOfId(id),
        lastSeen,
        country: country ?? cur?.country ?? null
      })
    } else if (country && cur) {
      cur.country = country
    }
  }

  // Phase 1 (scalable-topology.md §4.2/§6): the peer keys Hyperswarm has DISCOVERED on
  // our topic (`swarm.peers`, PeerInfo keyed by hex key). This drives *who we try to
  // connect to* (Chord pinning below) — NOT the visible ring. A DHT announcement only
  // means "this key advertised the topic once"; a stale announce from a since-closed
  // instance would otherwise become a permanent ghost seat. A seat requires real
  // liveness (a connection or gossip); discovery just tells us who to dial.
  function discoveredIds() {
    const now = Date.now()
    const ids = []
    for (const info of swarm.peers.values()) {
      const id = b4a.toString(info.publicKey, 'hex')
      // Skip a peer we just saw disconnect (Hyperswarm keeps retrying it) so we don't
      // re-pin a dead neighbour; the cooldown clears on reconnect or when it expires.
      const gone = goneUntil.get(id)
      if (gone) {
        if (now < gone) continue
        goneUntil.delete(id)
      }
      ids.push(id)
    }
    return ids
  }

  // Phase 2+3 (scalable-topology.md §4.3/§4.5/§6): make the ring's edges *physical*.
  // We deliberately swarm.joinPeer() our successor-list (k clockwise) + predecessor
  // (the token walk / fault tolerance) plus our finger table (O(log N) ring-spanning
  // reachability), then diff against `pinned` as the ring churns — joinPeer new
  // targets, leavePeer former ones. Recomputing the fingers here each refresh *is*
  // Chord's fixFingers. leavePeer only drops the explicit pin (not a live topic-
  // driven connection), so the full mesh stays as a fallback until gossip is slimmed
  // (Phase 4); the finger set means we no longer *rely* on that mesh for reachability.
  //
  // Candidates = DHT-discovered ∪ already-connected ∪ gossip-known (live seats). The
  // token-walk seats (`peers`) still come only from connections + gossip, so a stale
  // discovery we can't reach is pinned (dialed) but never shown as a seat.
  function maintainNeighbours() {
    const now = Date.now()
    for (const [id, exp] of routed) if (exp <= now) routed.delete(id) // drop stale routing hints
    const cand = new Set([...discoveredIds(), ...senders.keys(), ...peers.keys(), ...routed.keys()])
    cand.delete(me.id)
    const targets = pinTargets([...cand], me.id, K_SUCCESSORS)
    for (const s of seedPeers) if (s !== me.id) targets.add(s) // always connect to seeds
    for (const id of targets) {
      if (pinned.has(id)) continue
      pinned.add(id)
      try {
        swarm.joinPeer(b4a.from(id, 'hex'))
        log('pin neighbour', shortId(id))
      } catch {}
    }
    for (const id of pinned) {
      if (targets.has(id)) continue
      pinned.delete(id)
      try {
        swarm.leavePeer(b4a.from(id, 'hex'))
        log('unpin neighbour', shortId(id))
      } catch {}
    }
  }

  // Re-pin our ring edges from current discovery/connectivity, and repaint.
  function refreshTopology() {
    maintainNeighbours()
    emit()
  }

  // The nation this peer supports; rides presence gossip + selfie entries (cosmetic).
  function setCountry(code) {
    me.country = code || null
    emit()
  }

  // Phase 4 (scalable-topology.md §4.6): the compact pointer advertisement that
  // replaces the O(N) `peers` snapshot. Each peer tells its neighbours only its own
  // successor-list + predecessor — O(k + log N), not O(N). Recipients learn the local
  // ring structure around us (transitive discovery, bounded) and run one stabilize
  // step. Primary membership still comes from DHT discovery (`swarm.peers`).
  function myPointers() {
    const ids = liveRing([...peers.values()], Date.now(), TTL_MS).map((p) => p.id)
    return {
      kind: 'pointers',
      id: me.id,
      country: me.country,
      succ: successors(ids, me.id, K_SUCCESSORS),
      pred: predecessor(ids, me.id)
    }
  }

  function handleGossip(m, fromId) {
    // Flood relayable control messages across the partial mesh: process each exactly
    // once, and on first sight re-broadcast to my other neighbours (dedup by `mid`).
    if (m.mid && RELAYED_KINDS.has(m.kind)) {
      if (!flood.firstSight(m.mid)) return // already seen -> drop (stops loops)
      relayFlood(m, fromId)
    }
    if (m.kind === 'token') return processToken(m)
    if (m.kind === 'find-succ') return handleFindSucc(m, fromId)
    if (m.kind === 'find-succ-reply') return handleFindSuccReply(m)
    if (m.kind === 'wave-pos') {
      // only animate the ball for the wave we're racing (angle derived locally)
      if (wave && wave.phase === 'racing' && m.waveId === wave.id) {
        // the wave advanced past my hop — my successor is alive, stop watching
        if (healPending && m.waveId === healPending.waveId && m.hopCount > healPending.hop) {
          clearHeal()
        }
        onToken({
          event: 'position',
          waveId: m.waveId,
          holder: m.holder,
          angle: angleOfId(m.holder),
          hopCount: m.hopCount
        })
      }
      return
    }
    if (m.kind === 'wave-sync') {
      // a peer told us the wave state when we joined mid-lobby / mid-race
      if (!m.waveId || !shouldAdopt(m.waveId)) return
      if (m.phase === 'racing') {
        if (!wave || wave.id !== m.waveId) enterLobby(m.waveId, m.by, false, 0, true)
        if (m.key) openGallery(m.waveId, b4a.from(m.key, 'hex'))
        beginRace(m.roster)
      } else {
        if (!wave || wave.id !== m.waveId) enterLobby(m.waveId, m.by, false, m.lobbyMsLeft)
        for (const id of m.roster || []) wave.roster.add(id)
        onToken({ event: 'roster', waveId: wave.id, count: wave.roster.size })
      }
      return
    }
    if (m.kind === 'wave-announce') {
      if (shouldAdopt(m.waveId)) enterLobby(m.waveId, m.by, false, m.lobbyMs)
      return
    }
    if (m.kind === 'wave-join') {
      if (wave && m.waveId === wave.id && m.peerId) {
        wave.roster.add(m.peerId)
        onToken({ event: 'roster', waveId: wave.id, count: wave.roster.size })
      }
      return
    }
    if (m.kind === 'wave-start') {
      // initiator finalized the roster and kicked off the race
      if (m.waveId && m.key && shouldAdopt(m.waveId)) {
        if (!wave || wave.id !== m.waveId) enterLobby(m.waveId, m.by, false)
        openGallery(m.waveId, b4a.from(m.key, 'hex'))
        beginRace(m.roster)
      }
      return
    }
    if (m.kind === 'wave-end') {
      // originator ended it (completed) or a peer hit a dead end (stalled) — everyone
      // finishes together instead of each waiting out the timeout
      if (wave && m.waveId === wave.id) {
        finishWave(m.waveId, {
          stalled: m.stalled,
          hops: m.hops,
          chainHash: m.chainHash,
          byId: m.by
        })
      }
      return
    }
    if (m.kind === 'add-writer') {
      // Admit only participants of the current wave: the request must carry a receipt
      // validly signed by the requester for this wave. (apply() re-checks each selfie.)
      const ok =
        base &&
        base.writable &&
        m.key &&
        m.waveId === currentWaveId &&
        verifyReceipt(m.peerId, m.waveId, m.hopCount, m.chainHash, m.receiptTs, m.receiptSig)
      if (ok) base.append({ type: 'add-writer', key: m.key })
      return
    }
    if (m.kind === 'wave-proof') {
      // Only a validator collects proofs; each must carry a receipt validly self-signed
      // for its hop (authenticity gate — apply()/payout re-checks the chain links too).
      if (
        isSeed &&
        verifyReceipt(m.peerId, m.waveId, m.hopCount, m.chainHash, m.receiptTs, m.receiptSig)
      ) {
        collectProof(m)
      }
      return
    }
    const now = Date.now()
    if (m.kind === 'presence') {
      upsert(m.id, now, m.country)
      // note validators/seeds so we deliberately connect to them (a well-connected seed
      // is always reachable for gallery replication, §4.7).
      if (m.role === 'validator' || m.role === 'seed') {
        if (!seedPeers.has(m.id)) {
          seedPeers.add(m.id)
          maintainNeighbours()
        }
      }
    } else if (m.kind === 'pointers') {
      // sender is a live neighbour (direct channel); its advertised succ/pred are
      // discovery hints, marked slightly stale so they age out unless independently
      // refreshed. Skip a hint for a peer we just saw disconnect (goneUntil), so a
      // third peer's advert can't resurrect a ghost seat.
      upsert(m.id, now, m.country)
      const learned = now - Math.floor(TTL_MS / 2)
      for (const id of [...(m.succ || []), m.pred]) {
        if (id && !(goneUntil.get(id) > now)) upsert(id, learned)
      }
      stabilize(m)
    }
    emit()
  }

  // Chord stabilize (§4.4): if this pointer advert came from my current successor and
  // its predecessor sits between us, that peer is my true successor — I've just
  // upserted it, so re-pin now (nextClockwise over the ring adopts it automatically).
  // My own periodic `pointers` advert is the reciprocal "notify" to my successor.
  function stabilize(m) {
    if (!m.pred) return
    const ring = liveRing([...peers.values()], Date.now(), TTL_MS)
    const succ = nextClockwise(me.angle, ring)
    if (!succ || succ.id !== m.id) return
    if (stabilizeStep(me.id, succ.id, m.pred) !== succ.id) {
      log('stabilize: closer successor', shortId(m.pred))
      maintainNeighbours()
    }
  }

  function broadcast(obj) {
    const str = JSON.stringify(obj)
    for (const send of senders.values()) {
      try {
        send(str)
      } catch {}
    }
  }

  // Originate a flooded control message: stamp a unique id, remember it (so it doesn't
  // loop back into me), and broadcast to every direct connection. Receivers relay it on
  // (relayFlood) until it has blanketed the whole partial mesh.
  function floodGossip(obj) {
    obj.mid = b4a.toString(crypto.randomBytes(8), 'hex')
    flood.firstSight(obj.mid) // mark mine seen so relays can't loop back into me
    broadcast(obj)
  }

  // Re-broadcast a flooded message to my other neighbours (everyone except whoever sent
  // it to me — dedup handles the remaining echoes). This is the relay step that carries
  // an announcement across a swarm too large to be a full mesh.
  function relayFlood(m, fromId) {
    const str = JSON.stringify(m)
    for (const [id, send] of senders) {
      if (id === fromId) continue
      try {
        send(str)
      } catch {}
    }
  }

  function trySend(id, obj) {
    const send = senders.get(id)
    if (!send) return false
    try {
      send(JSON.stringify(obj))
      return true
    } catch {
      return false
    }
  }

  // My current successor id (next reachable clockwise) + the finger/successor ids I know
  // — the inputs to Chord's per-hop routing decision.
  function mySuccessorId() {
    const s = nextClockwise(me.angle, liveRing([...peers.values()], Date.now(), TTL_MS))
    return s ? s.id : null
  }
  function myKnownIds() {
    return [...new Set([...pinned, ...senders.keys()])]
  }

  // --- distributed findSuccessor (Chord routing, §4.5) -----------------------
  // Locate the true successor of a keyspace position by routing the query through
  // fingers, so it's correct even when no single peer knows the whole ring. The request
  // hops along connected fingers (findSuccessorStep chooses the next); the reply retraces
  // the same path back to the origin. Resolves to a peer id, or null on timeout/no peers.
  function findSuccessorRemote(target) {
    return new Promise((resolve) => {
      const start = closestPrecedingNode(myKnownIds(), me.id, target) || mySuccessorId()
      if (!start || !senders.has(start)) return resolve(null) // nobody to ask
      const qid = b4a.toString(crypto.randomBytes(8), 'hex')
      const timer = setTimeout(() => {
        pendingLookups.delete(qid)
        resolve(null)
      }, LOOKUP_TIMEOUT_MS)
      pendingLookups.set(qid, { resolve, timer })
      if (!trySend(start, { kind: 'find-succ', qid, target: target.toString(), hops: 0 })) {
        clearTimeout(timer)
        pendingLookups.delete(qid)
        resolve(null)
      }
    })
  }

  // A find-succ request reached me: answer if the target falls in (me, successor], else
  // forward to my closest preceding finger, remembering the upstream for the reply.
  function handleFindSucc(m, fromId) {
    let target
    try {
      target = BigInt(m.target)
    } catch {
      return
    }
    const step = findSuccessorStep(me.id, mySuccessorId(), myKnownIds(), target)
    if (step.done || (m.hops || 0) >= LOOKUP_TTL) {
      trySend(fromId, {
        kind: 'find-succ-reply',
        qid: m.qid,
        successor: step.done ? step.successor : mySuccessorId()
      })
      return
    }
    if (!senders.has(step.next)) {
      trySend(fromId, { kind: 'find-succ-reply', qid: m.qid, successor: mySuccessorId() })
      return
    }
    lookupRoute.set(m.qid, fromId)
    setTimeout(() => lookupRoute.delete(m.qid), LOOKUP_TIMEOUT_MS)
    trySend(step.next, { kind: 'find-succ', qid: m.qid, target: m.target, hops: (m.hops || 0) + 1 })
  }

  // A find-succ-reply reached me: resolve it if I'm the origin, else pass it back up the
  // reverse path toward whoever asked me.
  function handleFindSuccReply(m) {
    const pend = pendingLookups.get(m.qid)
    if (pend) {
      clearTimeout(pend.timer)
      pendingLookups.delete(m.qid)
      pend.resolve(m.successor || null)
      return
    }
    const up = lookupRoute.get(m.qid)
    if (up) {
      lookupRoute.delete(m.qid)
      trySend(up, m)
    }
  }

  // Chord repair: verify my successor via distributed routing and, if the lookup surfaces
  // a truer successor my local view missed (a node between me and who I think is next),
  // add it as a pin candidate so maintainNeighbours connects to it. Additive and safe: a
  // no-op at small scale (local knowledge already resolves the lookup with no hops).
  async function repairSuccessor() {
    if (senders.size === 0) return
    const succId = await findSuccessorRemote((nodeIdOfHex(me.id) + 1n) % RING)
    if (succId && succId !== me.id && !senders.has(succId)) {
      routed.set(succId, Date.now() + ROUTED_TTL_MS)
      maintainNeighbours()
    }
  }

  // Chord join (§4.5): once I have my first connection(s), place myself in the ring by
  // asking a seed to route findSuccessor(me) — so a joiner finds its true successor via
  // O(log N) routing even when its own DHT sample is incomplete, instead of waiting for
  // the slow periodic repair. One-shot per connected session; re-armed if I go solo.
  function scheduleBootstrap() {
    if (bootstrapDone || bootstrapTimer) return
    bootstrapTimer = setTimeout(() => {
      bootstrapTimer = null
      bootstrapDone = true
      log('join: placing myself via findSuccessor')
      repairSuccessor().catch(() => {})
    }, BOOTSTRAP_MS)
  }

  // Send only to our pinned ring neighbours (successor-list + predecessor + fingers).
  // Used for the slimmed membership gossip (presence + pointers) — O(k + log N) fanout
  // instead of hitting every connection. wave-* fanout stays on broadcast() (the
  // visual ball / roster still need broad reach) pending the Phase-5 sweep decision.
  function broadcastToNeighbours(obj) {
    const str = JSON.stringify(obj)
    for (const id of pinned) {
      const send = senders.get(id)
      if (!send) continue
      try {
        send(str)
      } catch {}
    }
  }

  // --- gallery (Autobase multi-writer) --------------------------------------

  // Open (or, with bootstrapKey=null, create) the gallery Autobase for `waveId`.
  // Galleries are PER-WAVE: the namespace is keyed by waveId so each wave (and each
  // fresh run, since waveId is random) starts empty instead of accumulating old
  // selfies. All peers share the originator's base; writes come from many admitted
  // writers, merged into one ordered view. Replication rides store.replicate(conn).
  function openGallery(waveId, bootstrapKey) {
    if (currentWaveId === waveId && base) return base
    const kept = galleries.get(waveId)
    if (kept) {
      // seed already holds this gallery — make it the current one, don't reopen
      base = kept
      currentWaveId = waveId
      autobaseKey = b4a.toString(kept.key, 'hex')
      return base
    }
    // A seed keeps old galleries open (so it can keep serving them after peers leave); a
    // regular peer closes the previous wave's gallery when it moves on.
    if (base && !isSeed) {
      base.close().catch(() => {})
      if (currentWaveId) galleries.delete(currentWaveId)
    }
    currentWaveId = waveId
    autobaseKey = null
    const b = new Autobase(store.namespace('wave-gallery:' + waveId), bootstrapKey, galleryConfig())
    base = b
    galleries.set(waveId, b)
    b.on('update', () => {
      if (base === b) emitGallery()
    })
    b.ready().then(() => {
      if (galleries.get(waveId) !== b) return // superseded (peer moved on and closed it)
      const key = b4a.toString(b.key, 'hex')
      if (base === b) autobaseKey = key
      log(
        'gallery ready',
        shortId(waveId),
        'key',
        shortId(key),
        'writable',
        b.writable,
        isSeed ? '(seed)' : ''
      )
      if (base === b) emitGallery()
    })
    return b
  }

  // (validator) Record a verified hop receipt, keyed by wave then hop. The chain is
  // reassembled in hop order at payout time (step 6); collecting relayers' proofs — not
  // just selfie-takers' — is what lets the validator know the whole participation chain.
  function collectProof(m) {
    let byHop = proofs.get(m.waveId)
    if (!byHop) proofs.set(m.waveId, (byHop = new Map()))
    if (byHop.has(m.hopCount)) return // first proof per hop wins
    byHop.set(m.hopCount, {
      hopCount: m.hopCount,
      peerId: m.peerId,
      receiptSig: m.receiptSig,
      chainHash: m.chainHash,
      receiptTs: m.receiptTs,
      address: m.address || ''
    })
    log('proof: wave', shortId(m.waveId), 'hop', m.hopCount, 'from', shortId(m.peerId))
    onToken({ event: 'proof', waveId: m.waveId, hopCount: m.hopCount, count: byHop.size })
  }

  // Collected hop receipts for a wave, ordered by hop (contiguous from 0). For the
  // interlocked payout (step 6) to walk and cross-check the chain.
  function chainProofs(waveId) {
    const byHop = proofs.get(waveId)
    if (!byHop) return []
    return [...byHop.values()].sort((a, b) => a.hopCount - b.hopCount)
  }

  // (validator) The verified burn-proofs (participation-fee attestations) for a wave, read
  // from that wave's gallery. Sig-valid by construction (apply gate); the validator still
  // cross-checks each txHash on-chain (to==black hole, amount, memo commits waveId).
  async function chainBurns(waveId) {
    const g = galleries.get(waveId)
    if (!g) return []
    await g.update().catch(() => {})
    return readBurns(g)
  }

  async function emitGallery() {
    if (!base) return
    onGallery(await readGallery(base))
  }

  // Become an admitted gallery writer: broadcast an add-writer request presenting my
  // receipt for this wave (the anti-spam gate — the host admits my writer core), then wait
  // until writable. Shared by the selfie and burn-proof posters — concurrent callers reuse a
  // single in-flight request (`admissionPromise`) instead of racing two broadcasts + waits.
  function ensureWriter(receipt) {
    if (!base) return Promise.resolve(false)
    if (base.writable) return Promise.resolve(true)
    if (admissionPromise) return admissionPromise
    admissionPromise = base.ready().then(() => {
      if (base.writable) return true
      broadcast({
        kind: 'add-writer',
        key: b4a.toString(base.local.key, 'hex'),
        peerId: me.id,
        waveId: receipt.waveId,
        hopCount: receipt.hopCount,
        chainHash: receipt.chainHash,
        receiptTs: receipt.receiptTs,
        receiptSig: receipt.receiptSig
      })
      return waitFor(() => base.writable, 8000)
    })
    admissionPromise.finally(() => {
      admissionPromise = null
    })
    return admissionPromise
  }

  // Post my selfie to the gallery (admission first, then append).
  async function postSelfie({
    waveId,
    hopCount,
    receiptSig,
    chainHash,
    receiptTs,
    caption,
    image
  }) {
    if (!base) {
      onToken({ event: 'gallery-error', reason: 'no-gallery-yet' })
      return
    }
    if (!(await ensureWriter({ waveId, hopCount, chainHash, receiptTs, receiptSig }))) {
      onToken({ event: 'gallery-error', reason: 'not-admitted' })
      return
    }
    await base.append({
      type: 'wave-selfie',
      waveId,
      peerId: me.id,
      hopCount,
      receiptSig,
      chainHash,
      receiptTs,
      country: me.country || '',
      caption: caption || '',
      image: image || '',
      address: walletAddress || '', // my TRX wallet, so viewers can tip this selfie (§WDK)
      timestamp: Date.now()
    })
    log('posted selfie hop', hopCount)
    emitGallery()
  }

  // The worker reports a successful burn (kick-off/join fee). Build + sign the burn-proof
  // attestation NOW (ring key binds my identity to the on-chain tx), stash it, and post it
  // to the gallery once I hold the token (become an admitted writer). Fires flushBurnProof
  // in case the receipt already arrived (e.g. the initiator burns at/after hop 0).
  function recordBurn({ reason, amount, txHash }) {
    if (!wave || burnPosted) return
    const fields = {
      waveId: wave.id,
      peerId: me.id,
      reason,
      amount,
      txHash,
      tronAddress: walletAddress || '',
      burnTs: Date.now()
    }
    pendingBurn = { type: 'burn-proof', ...fields, sig: signBurn(swarm.keyPair, fields) }
    flushBurnProof()
  }

  // Post my stashed burn-proof once I have a receipt for this wave (so I can be admitted as
  // a writer). Works for non-selfie participants too — a relayer that paid the join fee.
  async function flushBurnProof() {
    if (burnPosted || !pendingBurn || !myReceipt || !base) return
    if (pendingBurn.waveId !== myReceipt.waveId) return
    burnPosted = true
    const proof = pendingBurn
    if (!(await ensureWriter(myReceipt))) {
      burnPosted = false // let a later attempt retry
      return
    }
    await base.append(proof)
    log('posted burn-proof', proof.reason, shortId(proof.txHash))
  }

  function waitFor(pred, timeoutMs) {
    return new Promise((resolve) => {
      if (pred()) return resolve(true)
      const started = Date.now()
      const iv = setInterval(() => {
        if (pred()) {
          clearInterval(iv)
          resolve(true)
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(iv)
          resolve(false)
        }
      }, 200)
    })
  }

  // --- wave lifecycle (idle -> lobby -> racing -> idle) ----------------------

  // Accept this wave? Idle -> yes; same wave -> yes; a competing wave only if its
  // id is lower (deterministic tie-break so every peer converges on one wave).
  function shouldAdopt(waveId) {
    if (endedWaves.has(waveId)) return false // a finished wave never comes back
    if (!wave || waveId === wave.id) return true
    return waveId < wave.id
  }

  function teardown() {
    clearTimeout(lobbyTimer)
    clearTimeout(waveTimer)
    clearHeal()
  }

  // Enter the lobby for `waveId` (announced by `by`; `mine` if I'm the initiator).
  // `silent` skips the wave-announce UI event (used when catching up straight into a
  // race, so no bogus lobby countdown flashes).
  function enterLobby(waveId, by, mine, dur = lobbyMs, silent = false) {
    if (wave && wave.id === waveId) return
    if (wave) {
      // superseded by a lower-id wave — abandon the old one
      endedWaves.add(wave.id)
      teardown()
    }
    resetSelfie() // fresh wave — clear any staged selfie/receipt from a prior one
    wave = { id: waveId, phase: 'lobby', by, roster: new Set([by]), joined: !!mine }
    if (mine) wave.roster.add(me.id)
    lobbyEndsAt = Date.now() + dur
    // fallback: if the race never starts (initiator vanished), drop back to idle
    clearTimeout(lobbyTimer)
    lobbyTimer = setTimeout(() => goIdle('lobby-timeout'), lobbyMs + 10000)
    if (silent) return
    onToken({
      event: 'wave-announce',
      waveId,
      by,
      mine: !!mine,
      joined: wave.joined,
      count: wave.roster.size,
      lobbyMs: dur
    })
  }

  // Opt in to the current lobby (renderer command / harness). Returns the joined waveId
  // (so the worker can charge the join fee on a real opt-in), or null if it was a no-op.
  function join() {
    if (!wave || wave.phase !== 'lobby' || wave.joined) return null
    wave.joined = true
    wave.roster.add(me.id)
    floodGossip({ kind: 'wave-join', waveId: wave.id, peerId: me.id })
    onToken({ event: 'joined', waveId: wave.id, count: wave.roster.size })
    return wave.id
  }

  // Transition the current wave from lobby to racing.
  function beginRace(rosterIds) {
    if (!wave) return
    wave.phase = 'racing'
    if (rosterIds) for (const id of rosterIds) wave.roster.add(id)
    clearTimeout(lobbyTimer)
    clearTimeout(waveTimer)
    waveTimer = setTimeout(() => goIdle('timeout'), waveTimeoutMs)
    onToken({ event: 'wave-active', waveId: wave.id, joined: wave.joined, count: wave.roster.size })
  }

  function goIdle(reason) {
    if (!wave) return
    const waveId = wave.id
    endedWaves.add(waveId)
    wave = null
    resetSelfie() // drop any staged selfie / receipt for the next wave
    seen.clear() // only needed within the active wave; bound its growth
    teardown()
    onToken({ event: 'wave-idle', waveId, reason })
  }

  // Finish the current wave: emit the outcome to the UI and return to idle. Shared by
  // the originator (local completion), a dead-end stall, and receiving a `wave-end`.
  function finishWave(waveId, { stalled = false, hops = 0, chainHash = '', byId = me.id } = {}) {
    if (stalled) onToken({ event: 'stalled', waveId, reason: 'no successor' })
    else onToken({ event: 'completed', waveId, hops, chainHash, angle: angleOfId(byId) })
    goIdle(stalled ? 'stalled' : 'ended')
  }

  // Am I opted in to the current wave (a roster member who took a lobby selfie)?
  function canSelfieNow() {
    return !!(wave && wave.roster.has(me.id))
  }

  // The renderer captured my selfie during the lobby and stages it here; it's posted
  // to the gallery when the token reaches me (below). Staging may arrive before or
  // after my hop — tryPostSelfie() fires once both the image and my receipt are ready.
  function stageSelfie({ image, caption } = {}) {
    stagedSelfie = { image: image || '', caption: caption || '' }
    tryPostSelfie()
  }

  // Record my hop's receipt when the token reaches me — the write-gate credential for
  // my staged selfie. Paired with stageSelfie() by tryPostSelfie().
  function recordMyReceipt(waveId, hopCount, receiptSig, chainHash, receiptTs) {
    if (!canSelfieNow()) return
    myReceipt = { waveId, hopCount, receiptSig, chainHash, receiptTs }
    tryPostSelfie()
    flushBurnProof() // I can now be admitted as a writer — post any stashed burn-proof
  }

  // Post my lobby selfie once BOTH the receipt (token reached me) and the staged image
  // (captured in the lobby) are available, exactly once per wave.
  function tryPostSelfie() {
    if (selfiePosted || !myReceipt || !stagedSelfie) return
    if (!wave || myReceipt.waveId !== wave.id) return
    selfiePosted = true
    postSelfie({ ...myReceipt, image: stagedSelfie.image, caption: stagedSelfie.caption })
  }

  function resetSelfie() {
    stagedSelfie = null
    myReceipt = null
    selfiePosted = false
    pendingBurn = null
    burnPosted = false
    admissionPromise = null
  }

  // Emit a holding event; canSelfie tells the renderer this peer is a participant (its
  // staged selfie will post now). Everyone else just relays the ball.
  function emitHolding(waveId, hopCount, receiptSig, chainHash, receiptTs) {
    recordMyReceipt(waveId, hopCount, receiptSig, chainHash, receiptTs)
    onToken({
      event: 'holding',
      waveId,
      hopCount,
      holder: me.id,
      angle: me.angle,
      canSelfie: canSelfieNow()
    })
  }

  // --- token race ------------------------------------------------------------

  // Tell every peer the ball is at me now, so all windows animate it here.
  function announcePosition(waveId, hopCount) {
    broadcast({ kind: 'wave-pos', waveId, holder: me.id, hopCount })
  }

  // Next reachable peer clockwise from me (directly connected, not already skipped).
  function pickSuccessor(skipped) {
    const ring = liveRing([...peers.values()], Date.now(), TTL_MS)
    return pickReachable(ring, me.angle, new Set(senders.keys()), skipped)
  }

  // Forward a token (already stamped with my receipt) to the next reachable peer,
  // and watch for the wave to advance; if it doesn't, skip that peer and retry.
  function forwardToken(token, skipped = new Set()) {
    const succ = pickSuccessor(skipped)
    if (!succ) {
      // dead end (kicked off solo, or all successors gone) — end the wave now so every
      // peer returns to idle instead of waiting out the timeout
      clearHeal()
      onToken({
        event: 'stalled',
        waveId: token.waveId,
        reason: skipped.size ? 'no-reachable-successor' : 'no successor'
      })
      floodGossip({ kind: 'wave-end', waveId: token.waveId, by: token.originator, stalled: true })
      goIdle('stalled')
      return
    }
    senders.get(succ.id)(JSON.stringify(token))
    onToken({ event: 'forwarded', waveId: token.waveId, hopCount: token.hopCount, to: succ.id })

    // heal: expect a wave-pos past my hop soon (the successor's hold ACKs it)
    clearTimeout(healTimer)
    healPending = { waveId: token.waveId, hop: token.hopCount }
    healTimer = setTimeout(() => {
      healPending = null
      skipped.add(succ.id)
      log('healing: successor', shortId(succ.id), 'silent — skipping')
      onToken({ event: 'healed', waveId: token.waveId, skipped: succ.id })
      forwardToken(token, skipped)
    }, healTimeoutMs)
  }

  function clearHeal() {
    clearTimeout(healTimer)
    healPending = null
  }

  // Build the next token this peer forwards, stamping hop `hopCount` with my receipt.
  function stampToken(waveId, originator, hopCount, prevChainHash, autobaseKeyHex) {
    const timestamp = Date.now()
    const senderReceiptSig = signReceipt(swarm.keyPair, waveId, hopCount, prevChainHash, timestamp)
    return {
      kind: 'token',
      waveId,
      originator,
      hopCount,
      prevChainHash,
      senderPeerId: me.id,
      senderReceiptSig,
      timestamp,
      autobaseKey: autobaseKeyHex
    }
  }

  // I now hold this token: post my lobby selfie (if opted in — emitHolding records my
  // receipt, which pairs with the staged image), tell everyone the ball is at me, and
  // forward to my successor after the dwell.
  function holdAndForward(token) {
    emitHolding(
      token.waveId,
      token.hopCount,
      token.senderReceiptSig,
      token.prevChainHash,
      token.timestamp
    )
    pushProof(token)
    announcePosition(token.waveId, token.hopCount)
    setTimeout(() => forwardToken(token), hopDelayMs)
  }

  // Push my hop's receipt to any connected validator/seed so it can reassemble the full
  // ordered chain — including relayers who never selfie (their receipt reaches the
  // validator no other way). Direct to pinned seeds (§ interlocked payout, final-idea).
  function pushProof(token) {
    const proof = {
      waveId: token.waveId,
      hopCount: token.hopCount,
      peerId: me.id,
      receiptSig: token.senderReceiptSig,
      chainHash: token.prevChainHash,
      receiptTs: token.timestamp,
      address: walletAddress || ''
    }
    if (isSeed) collectProof(proof) // a validator relays too — record its own hop directly
    if (seedPeers.size === 0) return
    const str = JSON.stringify({ kind: 'wave-proof', ...proof })
    for (const s of seedPeers) {
      const send = senders.get(s)
      if (send) {
        try {
          send(str)
        } catch {}
      }
    }
  }

  function processToken(token) {
    if (!verifyToken(token)) {
      log('token: bad receipt from', shortId(token.senderPeerId || ''))
      return
    }
    // Ignore tokens from a competing/losing wave (single active wave at a time).
    if (!shouldAdopt(token.waveId)) return

    // Completion: the token has returned to its originator. Tell everyone, then finish.
    if (token.originator === me.id && token.hopCount > 0) {
      floodGossip({
        kind: 'wave-end',
        waveId: token.waveId,
        hops: token.hopCount,
        chainHash: token.prevChainHash,
        by: me.id
      })
      finishWave(token.waveId, { hops: token.hopCount, chainHash: token.prevChainHash })
      return
    }
    const key = token.waveId + '|' + token.hopCount
    if (seen.has(key) || token.hopCount > MAX_HOPS) return
    seen.add(key)

    // adopt into the race (may switch from a higher-id wave, or catch up if we
    // missed the announce/start) and learn this wave's gallery
    if (!wave || wave.id !== token.waveId) {
      enterLobby(token.waveId, token.originator, false, 0, true)
    }
    if (wave.phase !== 'racing') beginRace()
    if (token.autobaseKey && token.waveId) {
      openGallery(token.waveId, b4a.from(token.autobaseKey, 'hex'))
    }

    const newChainHash = advanceChain(token.prevChainHash, token.senderReceiptSig)
    const next = stampToken(
      token.waveId,
      token.originator,
      token.hopCount + 1,
      newChainHash,
      token.autobaseKey
    )
    holdAndForward(next)
  }

  // Announce a new wave and open the lobby (any peer can start when idle). After the
  // lobby window the initiator finalizes the roster and the token starts racing.
  function startWave() {
    if (isSeed) return null // a seed archives galleries; it doesn't run waves
    if (wave) {
      onToken({ event: 'busy', waveId: wave.id })
      return null
    }
    const waveId = b4a.toString(crypto.randomBytes(16), 'hex')
    log('announcing wave', shortId(waveId))
    enterLobby(waveId, me.id, true) // initiator auto-joins
    floodGossip({ kind: 'wave-announce', waveId, by: me.id, lobbyMs })
    // initiator's lobby timer starts the race (overrides the idle fallback)
    clearTimeout(lobbyTimer)
    lobbyTimer = setTimeout(() => finalizeAndStart(waveId), lobbyMs)
    return waveId
  }

  async function finalizeAndStart(waveId) {
    if (!wave || wave.id !== waveId || wave.phase !== 'lobby') return
    openGallery(waveId, null) // create this wave's gallery, then wait for its key
    await base.ready()

    log(
      'starting wave',
      shortId(waveId),
      'roster',
      wave.roster.size,
      'gallery',
      shortId(autobaseKey)
    )
    floodGossip({
      kind: 'wave-start',
      waveId,
      by: me.id,
      roster: [...wave.roster],
      key: autobaseKey
    })
    beginRace()
    onToken({ event: 'started', waveId, by: me.id })

    // the originator is hop 0 — hold (proof window if joined) and forward
    holdAndForward(stampToken(waveId, me.id, 0, ZERO_HASH, autobaseKey))
  }

  // --- connections -----------------------------------------------------------
  swarm.on('connection', (conn) => {
    store.replicate(conn) // carries gossip mux + Autobase gallery replication

    const id = b4a.toString(conn.remotePublicKey, 'hex')
    goneUntil.delete(id) // reconnected — lift any churn cooldown
    upsert(id, Date.now())
    log('peer connected', shortId(id))

    const mux = Protomux.from(conn)
    const channel = mux.createChannel({ protocol: 'hyperwave/gossip' })
    const message = channel.addMessage({
      encoding: c.string,
      onmessage(str) {
        let m
        try {
          m = JSON.parse(str)
        } catch {
          return
        }
        handleGossip(m, id)
      }
    })
    channel.open()

    const send = (str) => message.send(str)
    senders.set(id, send)
    scheduleBootstrap() // first connection -> place myself in the ring via findSuccessor

    // greet: presence + my compact pointers (Phase 4 — no O(N) snapshot). The
    // newcomer converges via DHT discovery (swarm.peers) + pointer exchange; at small
    // N the mesh also upserts every peer directly on connect.
    send(JSON.stringify({ kind: 'presence', id: me.id, country: me.country, role }))
    send(JSON.stringify(myPointers()))
    // if a wave is forming/racing, tell the newcomer so their UI syncs and they can't
    // start a competing one (broadcasts they missed won't reach them otherwise)
    if (wave) {
      send(
        JSON.stringify({
          kind: 'wave-sync',
          waveId: wave.id,
          phase: wave.phase,
          by: wave.by,
          roster: [...wave.roster],
          key: autobaseKey,
          lobbyMsLeft: wave.phase === 'lobby' ? Math.max(0, lobbyEndsAt - Date.now()) : 0
        })
      )
    }
    emit()

    conn.on('close', () => {
      senders.delete(id)
      peers.delete(id) // direct disconnect is authoritative for that peer
      seedPeers.delete(id) // re-learned from presence if it comes back
      goneUntil.set(id, Date.now() + TTL_MS) // cooldown: don't re-pin/re-hint it yet
      if (senders.size === 0) bootstrapDone = false // went solo -> re-bootstrap on reconnect
      log('peer disconnected', shortId(id))
      // churn (§4.4): if a pinned ring neighbour dropped, re-pin immediately —
      // promotes the next successor-list entry and repairs fingers without waiting
      // for the next tick. `pinned` still holds the dead id; maintainNeighbours diffs
      // it out (leavePeer) and pins the replacement from the now-smaller ring.
      if (pinned.has(id)) maintainNeighbours()
      emit()
    })
    conn.on('error', () => {})
  })

  // DHT discovery feeds ring membership (Phase 1) and drives which peers we pin
  // (Phase 2): every time Hyperswarm learns of or drops peers on the topic, re-seed
  // the ring from `swarm.peers` and re-pin our successor-list + predecessor.
  swarm.on('update', refreshTopology)

  const topic = crypto.hash(b4a.from(matchId))
  const discovery = swarm.join(topic, { server: true, client: true })
  discovery.flushed().then(() => {
    log('joined match', matchId, 'topic', shortId(b4a.toString(topic, 'hex')), 'as', shortId(me.id))
    refreshTopology() // initial seed + pin once the topic announce/lookup has flushed
  })

  // --- timers ----------------------------------------------------------------
  const tPresence = setInterval(() => {
    broadcastToNeighbours({ kind: 'presence', id: me.id, country: me.country, role })
  }, PRESENCE_MS)
  const tRing = setInterval(() => {
    // re-pin ring edges from current discovery even if no 'update' fired
    maintainNeighbours()
    // slim pointer exchange (Phase 4) replaces the O(N) peers snapshot; sent after
    // maintainNeighbours so `pinned` is current and reflects our latest succ/pred
    broadcastToNeighbours(myPointers())
    emit() // also re-evaluate TTL pruning
    // pull replicated gallery writes. A seed updates ALL retained galleries so each keeps
    // syncing (and stays a live source for latecomers); a peer just its current one.
    if (isSeed) {
      for (const b of galleries.values()) b.update().catch(() => {})
      if (base) emitGallery()
    } else if (base) {
      base
        .update()
        .then(emitGallery)
        .catch(() => {})
    }
  }, RINGUPDATE_MS)
  // Chord repair via distributed findSuccessor — correct a successor pointer my local
  // (possibly partial) view missed. Slow cadence; a no-op when local knowledge suffices.
  const tRepair = setInterval(() => {
    repairSuccessor().catch(() => {})
  }, RINGUPDATE_MS * 4)

  return {
    me,
    role,
    startWave,
    join,
    setCountry,
    stageSelfie,
    setWallet: (address) => {
      walletAddress = address || null
    },
    recordBurn, // a peer reports its paid participation fee -> sign + post burn-proof
    chainProofs, // (validator) collected hop receipts for a wave, ordered by hop
    chainBurns, // (validator) verified burn-proofs for a wave (from the gallery)
    // Distributed Chord lookup: the true successor of a peer id's ring position (or a
    // raw BigInt keyspace target). Resolves to a peer id, or null. (§4.5)
    findSuccessor: (target) =>
      findSuccessorRemote(typeof target === 'bigint' ? target : nodeIdOfHex(target)),
    async close() {
      clearInterval(tPresence)
      clearInterval(tRing)
      clearInterval(tRepair)
      clearTimeout(lobbyTimer)
      clearTimeout(waveTimer)
      clearTimeout(healTimer)
      clearTimeout(bootstrapTimer)
      for (const { timer } of pendingLookups.values()) clearTimeout(timer)
      await swarm.destroy()
      for (const b of galleries.values()) await b.close().catch(() => {})
      await store.close()
    }
  }
}

module.exports = { createWave, MATCH }
