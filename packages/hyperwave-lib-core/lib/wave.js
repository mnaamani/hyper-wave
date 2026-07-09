// HyperWave orchestrator. Wires the transport (Hyperswarm + Protomux gossip) to the
// pure domains — ring geometry (ring.js), Chord topology (chord.js), flood dedup
// (flood.js), token crypto (token.js), and the selfie gallery (gallery.js).
// The payment layer (pay.js, WDK) is injected by the worker via setWallet(): wallet
// address (for gallery tips) + the on-chain burn verifier (the paid-wave anti-spam gate).
// Money model: burned fees (skin in the game) + gallery tips; there are no sponsor rewards.
// Runs under Bare (the worker) or a Node harness. The Bare worker (hyperwave.js) bridges
// this to the renderer; wave.run.js drives it headlessly.

const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const Autobase = require('autobase')
const Protomux = require('protomux')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const fs = require('bare-fs')

const { angleOf, angleOfId, liveRing, nextClockwise, pickReachable } = require('./ring')
const { pinTargets, successors, predecessor, stabilizeStep } = require('./chord')
const { createChordRouting } = require('./chord-routing')
const { createFlood } = require('./flood')
const {
  ZERO_HASH,
  signReceipt,
  verifyReceipt,
  verifyToken,
  advanceChain,
  signBurn,
  verifyBurn,
  burnAuthorizes,
  signGalleryKey,
  verifyGalleryKey,
  signWaveEnd,
  verifyWaveEnd
} = require('./token')
const { galleryConfig, readGallery } = require('./gallery')

const MATCH = 'hyperwave:demo-match:v1'
const HEARTBEAT_MS = 2000 // pointers-heartbeat cadence (liveness + Chord pointer exchange)
const RINGUPDATE_MS = 4000 // re-pin + gallery-pull maintenance cadence
const PEER_STALE_MS = 12000 // a peer whose last heartbeat is older than this is stale (dropped)
const MAX_HOPS = 5000 // safety cap against runaway tokens
// The token races at network speed — there is no per-hop dwell. Visual pacing is a pure
// renderer concern (the host replays the completed, hopCount-ordered gallery as a fixed-duration
// sweep — see docs/protocol.md §6). The selfie is captured up-front in the lobby (not during the
// race), so nothing on the hot path ever has to cover a human.
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
// add-writer floods too: a gallery seat is granted only by a current writer, so on a sparse
// (Chord) mesh — especially after peers die and churn connections — a requester may not be
// directly connected to any writer. Relaying lets the request reach one several hops away.
// Authenticity is the carried receipt signature (admitWriter → verifyReceipt), not the hop.
const RELAYED_KINDS = new Set([
  'wave-announce',
  'wave-join',
  'wave-start',
  'wave-end',
  'add-writer'
])
// Identity binding: for a message that describes its OWN sender, the claimed id must equal
// the Noise-authenticated connection id it arrived on (`fromId`). Hyperswarm authenticates
// *who* we're talking to; without this the app would still believe whatever a modified
// client *claims* to be — letting one peer inject presence/holds/receipts/proofs under keys
// it doesn't control (ring pollution, heal suppression, sybil proof stuffing). Only the
// direct-path (unicast / one-hop) messages are listed; flooded messages (wave-*) are relayed
// so their `by`/`peerId` is a third party at relay hops — those are authenticated by their
// carried signatures (kick-off burn-proof, receipts) instead, not by the connection.
const SELF_ID_FIELD = {
  pointers: 'id', // the heartbeat sender
  'wave-pos': 'holder', // whoever currently holds the ball (broadcast by the holder)
  token: 'senderPeerId' // the immediate forwarder (re-stamped every hop)
  // NB: add-writer is NOT here — it's relayed (RELAYED_KINDS), so at relay hops its `peerId`
  // is a third party; it's authenticated by its carried receipt signature (admitWriter), not
  // the connection. Binding it to `fromId` would make every relay drop it.
}
// Cap on remembered message ids (flood dedup). Cleared wholesale when exceeded — a
// straggling duplicate might then re-flood once, which is harmless and very rare.
const GOSSIP_SEEN_CAP = 4096
// How long the initiator waits for its kick-off burn to confirm + announce before aborting
// the wave back to idle (paid-wave gate). Generous: the burn broadcasts in ~2s but on-chain
// read-back can lag; must exceed the worker's confirmation poll budget.
const PAY_TIMEOUT_MS = 60000
// Gallery-writer admission (§8.2). The requester re-broadcasts its add-writer every
// ADMIT_RETRY_MS (a single one-hop broadcast can race connection setup) until admitted or
// ADMIT_TIMEOUT_MS — generous because in a fast few-peer wave the race finishes first (the
// admitter's check itself is a cheap local signature check — burnAuthorizes, no on-chain
// call); the gallery persists after the wave, so a late admission still lands. BURN_WAIT_MS:
// how long to wait for my own join burn to be recorded before requesting admission.
const ADMIT_TIMEOUT_MS = 25000
const ADMIT_RETRY_MS = 3000
const BURN_WAIT_MS = 10000

function shortId(hex) {
  return hex.slice(0, 8)
}

// Parse a HYPERWAVE_BOOTSTRAP-style "host:port[,host:port…]" list into Hyperswarm's
// bootstrap option (a local DHT for instant same-machine discovery); falsy → null
// (the public DHT). Shared by both engine hosts.
function parseBootstrap(str) {
  if (!str) return null
  return str.split(',').map((hp) => {
    const [host, port] = hp.split(':')
    return { host, port: Number(port) }
  })
}

function createWave({
  storageDir,
  onState,
  onEvent = () => {},
  onGallery = () => {},
  log = () => {},
  bootstrap = null,
  matchId = MATCH,
  lobbyMs = LOBBY_MS
}) {
  // No roles — every peer is equal. The one asymmetry is per-wave: the peer that INITIATES a
  // wave keeps that wave's gallery open (so it survives for latecomers/replication);
  // everyone else treats galleries as ephemeral and closes them when moving on.
  // The store is per-run (galleries are keyed by the random waveId, so nothing persists
  // meaningfully across runs); wipe it on startup to reclaim disk.
  const storePath = storageDir + '/hyperwave'
  try {
    fs.rmSync(storePath, { recursive: true, force: true })
  } catch {}
  const store = new Corestore(storePath)
  // bootstrap: pass a local DHT for instant same-machine discovery (tests / single
  // -laptop demo). Omit for the public DHT (cross-machine, ~20-35s cold discovery).
  const swarm = new Hyperswarm(bootstrap ? { bootstrap } : {})

  const meKey = swarm.keyPair.publicKey
  const me = { id: b4a.toString(meKey, 'hex'), angle: angleOf(meKey), country: null }
  let walletAddress = null // my TRX wallet address (set by the worker once WDK is ready)
  let enforcePaid = false // gate waves on a proven kick-off burn (enabled once wallet is up)
  let verifyBurnOnChain = null // on-chain burn check (set once the wallet is up, via setWallet)
  const peers = new Map() // id -> { id, angle, lastSeen, country }
  const senders = new Map() // peerId -> gossip message send fn (for direct forwarding)
  const pinned = new Set() // ids we've swarm.joinPeer()'d (our physical ring edges)
  const goneUntil = new Map() // id -> ts: suppress re-seeding a just-closed peer (churn)
  const seen = new Set() // waveId|hopCount already processed (drop dupes/loops); cleared per wave
  const endedWaves = new Set() // waves that finished — never re-adopt (prevents revival)
  const flood = createFlood({ cap: GOSSIP_SEEN_CAP }) // flood dedup for relayed control msgs

  let base = null // the CURRENT wave's gallery Autobase (created by originator, opened by others)
  let autobaseKey = null // hex bootstrap key of `base`, shared via gossip + token
  let currentWaveId = null // which wave `base` belongs to (galleries are per-wave)
  const galleries = new Map() // waveId -> base (I retain the galleries for waves I initiated)
  const initiatedWaves = new Set() // waveIds I started — I keep their galleries open (archivist)

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
  let admissionPromise = null // in-flight add-writer request (dedup concurrent callers)
  let myBurnProof = null // my signed fee-burn attestation — my gallery-admission ticket
  const admittedKeys = new Set() // (admitter) writer core keys I've already admitted this wave

  // Distributed findSuccessor routing (chord-routing.js) — the Chord control plane over the
  // gossip mesh: join-time self-placement, periodic successor repair, and the find-succ RPC.
  // `trySend`/`maintainNeighbours` are function declarations below (hoisted), safe to pass here.
  const chord = createChordRouting({
    me,
    peers,
    senders,
    pinned,
    staleMs: PEER_STALE_MS,
    trySend,
    maintainNeighbours,
    log
  })

  // --- ring / peer table -----------------------------------------------------
  function emit() {
    const ring = liveRing([...peers.values()], Date.now(), PEER_STALE_MS)
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
    // Candidates: DHT-discovered ∪ connected ∪ gossip-known ∪ routing-discovered (chord).
    const cand = new Set([
      ...discoveredIds(),
      ...senders.keys(),
      ...peers.keys(),
      ...chord.pinCandidates()
    ])
    cand.delete(me.id)
    const targets = pinTargets([...cand], me.id, K_SUCCESSORS)
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

  // The nation this peer supports; rides the pointers heartbeat + selfie entries (cosmetic).
  function setCountry(code) {
    me.country = code || null
    emit()
  }

  // Phase 4 (scalable-topology.md §4.6): the compact pointer advertisement that
  // replaces the O(N) `peers` snapshot. Each peer tells its neighbours only its own
  // successor-list + predecessor — O(k + log N), not O(N). Recipients learn the local
  // ring structure around us (transitive discovery, bounded) and run one stabilize
  // step. Primary membership still comes from DHT discovery (`swarm.peers`).
  // Doubles as the liveness heartbeat (it refreshes lastSeen and carries country),
  // so there is no separate `presence` message.
  function myPointers() {
    const ids = liveRing([...peers.values()], Date.now(), PEER_STALE_MS).map((p) => p.id)
    return {
      kind: 'pointers',
      id: me.id,
      country: me.country,
      succ: successors(ids, me.id, K_SUCCESSORS),
      pred: predecessor(ids, me.id)
    }
  }

  function handleGossip(m, fromId) {
    // Identity binding (see SELF_ID_FIELD): drop a self-describing message that didn't come
    // from the peer it claims to be. Cheap string compare, before any signature work.
    const idField = SELF_ID_FIELD[m.kind]
    if (idField && m[idField] !== fromId) return

    // Flood relayable control messages across the partial mesh: process each exactly
    // once, and on first sight re-broadcast to my other neighbours (dedup by `mid`).
    if (m.mid && RELAYED_KINDS.has(m.kind)) {
      if (!flood.firstSight(m.mid)) return // already seen -> drop (stops loops)
      relayFlood(m, fromId)
    }
    if (m.kind === 'token') return processToken(m)
    if (m.kind === 'find-succ') return chord.handleFindSucc(m, fromId)
    if (m.kind === 'find-succ-reply') return chord.handleFindSuccReply(m)
    if (m.kind === 'wave-pos') {
      // only animate the ball for the wave we're racing (angle derived locally)
      if (wave && wave.phase === 'racing' && m.waveId === wave.id) {
        // Heal-ACK: my forward is only ACKed when the peer I actually forwarded to holds the
        // ball (m.holder is connection-bound to the real sender). Requiring the *successor*
        // id — not just any hopCount past mine — stops a hostile peer from broadcasting a
        // bogus wave-pos to suppress healing while my real successor is dead.
        if (
          healPending &&
          m.waveId === healPending.waveId &&
          m.holder === healPending.succId &&
          m.hopCount > healPending.hop
        ) {
          clearHeal()
        }
        onEvent({
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
      // anti-spam: adopt a synced wave (lobby OR racing) only with a valid kick-off proof.
      // Previously a *racing* sync skipped this — a hostile peer could unicast a fabricated
      // racing wave-sync on connect to force a newcomer into a bogus wave, bypassing the
      // paid gate. The signed burn-proof can't be forged for a key the attacker lacks.
      if (enforcePaid && !validKickoff(m.paid, m.waveId, m.by)) return
      if (m.phase === 'racing') {
        if (!wave || wave.id !== m.waveId) enterLobby(m.waveId, m.by, false, 0, true)
        if (m.paid) wave.kickoffProof = m.paid
        wave.paid = 'verified'
        verifyAndOpenGallery(m.waveId, m.key, m.keySig, m.by)
        beginRace(m.roster)
      } else {
        if (!wave || wave.id !== m.waveId) enterLobby(m.waveId, m.by, false, m.lobbyMsLeft)
        if (enforcePaid && m.paid && !wave.kickoffProof) {
          wave.kickoffProof = m.paid
          verifyKickoff(m.waveId, m.paid)
        }
        for (const id of m.roster || []) wave.roster.add(id)
        onEvent({ event: 'roster', waveId: wave.id, count: wave.roster.size })
      }
      return
    }
    if (m.kind === 'wave-announce') {
      // anti-spam: an enforced peer ignores any announce lacking a validly-signed kick-off
      // proof (unpaid/spam waves are invisible). Then it verifies the burn on-chain.
      if (enforcePaid && !validKickoff(m.paid, m.waveId, m.by)) return
      if (!shouldAdopt(m.waveId)) return
      enterLobby(m.waveId, m.by, false, m.lobbyMs)
      if (enforcePaid && m.paid) {
        wave.kickoffProof = m.paid
        verifyKickoff(m.waveId, m.paid)
      }
      return
    }
    if (m.kind === 'wave-join') {
      if (wave && m.waveId === wave.id && m.peerId) {
        wave.roster.add(m.peerId)
        onEvent({ event: 'roster', waveId: wave.id, count: wave.roster.size })
      }
      return
    }
    if (m.kind === 'wave-start') {
      // initiator finalized the roster and kicked off the race. Gate on the same kick-off
      // proof as the announce, so a forged wave-start can't conjure a race + gallery either.
      if (enforcePaid && !validKickoff(m.paid, m.waveId, m.by)) return
      if (m.waveId && m.key && shouldAdopt(m.waveId)) {
        if (!wave || wave.id !== m.waveId) enterLobby(m.waveId, m.by, false)
        if (m.paid) wave.kickoffProof = m.paid // carry it so we can re-sync newcomers
        verifyAndOpenGallery(m.waveId, m.key, m.keySig, m.by)
        beginRace(m.roster)
      }
      return
    }
    if (m.kind === 'wave-end') {
      // The originator ended it (completed) or a real participant hit a dead end (stalled) —
      // everyone finishes together instead of each waiting out the timeout. wave-end is
      // flooded (forgeable by any relay), so it's only honoured with proof it's genuine:
      //  - completion: an Ed25519 signature by the originator over (waveId, hops, chainHash);
      //  - stall: the staller's own hop receipt, proving it was an admitted participant.
      // An outside attacker holding neither can no longer force-terminate a live wave.
      if (!wave || m.waveId !== wave.id) return
      const authentic = m.stalled
        ? verifyReceipt(m.staller, m.waveId, m.hopCount, m.chainHash, m.receiptTs, m.receiptSig)
        : verifyWaveEnd(m.by, m.waveId, m.hops, m.chainHash, m.sig)
      if (!authentic) return
      finishWave(m.waveId, {
        stalled: m.stalled,
        hops: m.hops,
        chainHash: m.chainHash,
        byId: m.by
      })
      return
    }
    if (m.kind === 'add-writer') {
      admitWriter(m)
      return
    }
    if (m.kind !== 'pointers') return
    // sender is a live neighbour (direct channel); its advertised succ/pred are
    // discovery hints, marked slightly stale so they age out unless independently
    // refreshed. Skip a hint for a peer we just saw disconnect (goneUntil), so a
    // third peer's advert can't resurrect a ghost seat.
    const now = Date.now()
    upsert(m.id, now, m.country)
    const learned = now - Math.floor(PEER_STALE_MS / 2)
    for (const id of [...(m.succ || []), m.pred]) {
      if (id && !(goneUntil.get(id) > now)) upsert(id, learned)
    }
    stabilize(m)
    emit()
  }

  // Chord stabilize (§4.4): if this pointer advert came from my current successor and
  // its predecessor sits between us, that peer is my true successor — I've just
  // upserted it, so re-pin now (nextClockwise over the ring adopts it automatically).
  // My own periodic `pointers` advert is the reciprocal "notify" to my successor.
  function stabilize(m) {
    if (!m.pred) return
    const ring = liveRing([...peers.values()], Date.now(), PEER_STALE_MS)
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

  // Send only to our pinned ring neighbours (successor-list + predecessor + fingers).
  // Used for the slimmed membership gossip (the pointers heartbeat) — O(k + log N)
  // fanout instead of hitting every connection. wave-* fanout stays on broadcast() (the
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
      // I already hold this gallery (a wave I initiated) — make it current, don't reopen
      base = kept
      currentWaveId = waveId
      autobaseKey = b4a.toString(kept.key, 'hex')
      return base
    }
    // Close the previous wave's gallery when moving on — UNLESS I initiated it, in which case
    // I keep it open to archive it (so it survives for latecomers).
    if (base && !initiatedWaves.has(currentWaveId)) {
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
        initiatedWaves.has(waveId) ? '(mine)' : ''
      )
      if (base === b) emitGallery()
    })
    return b
  }

  // Open a gallery a peer advertised (wave-start / token / wave-sync), but ONLY after
  // verifying the key is the one the wave's originator signed (§ gallery-key attestation).
  // Blocks a malicious relay from swapping the (unsigned, relayed) key to point us at an
  // attacker-controlled Autobase. The verified sig is stashed on `wave` so we can re-advertise
  // it to newcomers we sync. `originatorId` is the wave's originator as this message claims it;
  // it must match the originator we already adopted (no mid-wave originator swap).
  function verifyAndOpenGallery(waveId, keyHex, keySig, originatorId) {
    if (!keyHex) return
    if (wave && wave.id === waveId && wave.by !== originatorId) {
      return log('gallery-key: originator mismatch for wave', shortId(waveId))
    }
    if (!verifyGalleryKey(originatorId, waveId, keyHex, keySig)) {
      return log('gallery-key: rejected unsigned/forged key for wave', shortId(waveId))
    }
    if (wave && wave.id === waveId) wave.keySig = keySig
    openGallery(waveId, b4a.from(keyHex, 'hex'))
  }

  async function emitGallery() {
    if (!base) return
    onGallery(await readGallery(base))
  }

  // (Admitter side) Grant gallery write access — OPTIMISTIC admission. Only a current writer
  // (the originator, or an already-admitted writer) admits, and only if the requester presents:
  //   1. a valid hop receipt for the current wave (authenticity: the receipt signature binds
  //      the request to peerId, so it stays sound even when flooded through relays), and
  //   2. a fee-burn attestation SIGNED for that peerId + wave (burnAuthorizes) — carrying the
  //      txHash + tip address, but NOT verified on-chain here.
  // We deliberately do *not* verify the burn on-chain at admission: that's O(N) REST calls
  // concentrated on the admitter and doesn't scale. Instead the burn is verified only when it
  // pays off — by tippers/auditors via the entry's `burnTx`. Spam is bounded locally: one entry
  // per peer + a byte-size cap on the image (gallery.js apply). So a fake-burn entry is cheap to
  // make but is worthless to tip and is publicly detectable. Fully local + synchronous.
  function admitWriter(m) {
    if (!base || !base.writable || !m.key || m.waveId !== currentWaveId) return
    if (admittedKeys.has(m.key)) return
    if (!verifyReceipt(m.peerId, m.waveId, m.hopCount, m.chainHash, m.receiptTs, m.receiptSig)) {
      return
    }
    if (enforcePaid && !burnAuthorizes(m.burn, m.peerId, m.waveId)) return // needs a signed burn attestation
    admittedKeys.add(m.key)
    base.append({ type: 'add-writer', key: m.key })
    log('admitted gallery writer', shortId(m.peerId))
  }

  // Become an admitted gallery writer: broadcast an add-writer request presenting (a) my hop
  // receipt for this wave and (b) my fee-burn attestation — admission is OPTIMISTIC: the
  // admitter checks only the attestation signature (burnAuthorizes), no on-chain call; the
  // burn is verified later where it pays off (tippers/auditors via burnTx). Then
  // wait until writable. `admissionPromise` dedups concurrent callers into one in-flight request.
  // (The originator is already a writer and never comes here — it paid its kick-off burn.)
  function ensureWriter(receipt) {
    if (!base) return Promise.resolve(false)
    if (base.writable) return Promise.resolve(true)
    if (admissionPromise) return admissionPromise
    admissionPromise = base
      .ready()
      // when enforcing, my burn attestation is my admission ticket; wait for the burn tx to be
      // recorded (join burns are fire-and-forget from the lobby) before requesting admission
      .then(() => (enforcePaid && !myBurnProof ? waitFor(() => !!myBurnProof, BURN_WAIT_MS) : true))
      .then(() => requestAdmission(receipt))
    admissionPromise.finally(() => {
      admissionPromise = null
    })
    return admissionPromise
  }

  // Flood add-writer and wait until admitted, re-flooding every ADMIT_RETRY_MS (each retry gets
  // a fresh flood id via floodGossip, so it re-blankets the mesh rather than being deduped away
  // — the reach a churny post-heal topology needs). The burn (my admission ticket) is pinned
  // into the request now, so a later resetSelfie can't blank it mid-wait. Resolves true once
  // writable, false on timeout.
  function requestAdmission(receipt) {
    return new Promise((resolve) => {
      if (base.writable) return resolve(true)
      const req = {
        kind: 'add-writer',
        key: b4a.toString(base.local.key, 'hex'),
        peerId: me.id,
        waveId: receipt.waveId,
        hopCount: receipt.hopCount,
        chainHash: receipt.chainHash,
        receiptTs: receipt.receiptTs,
        receiptSig: receipt.receiptSig,
        burn: myBurnProof || undefined
      }
      const started = Date.now()
      const tick = () => {
        if (base.writable) return resolve(true)
        if (Date.now() - started > ADMIT_TIMEOUT_MS) return resolve(false)
        floodGossip(req) // re-stamps req.mid each tick → floods anew across the partial mesh
        setTimeout(tick, ADMIT_RETRY_MS)
      }
      tick()
    })
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
      onEvent({ event: 'gallery-error', reason: 'no-gallery-yet' })
      return
    }
    // Capture closure state NOW, before the admission await: in a fast (few-peer) wave the
    // race can complete during ensureWriter, and goIdle→resetSelfie would clear this before
    // the append — dropping our own tip address. (The staged image/receipt are already captured
    // as args.)
    const burnProof = myBurnProof
    if (!(await ensureWriter({ waveId, hopCount, chainHash, receiptTs, receiptSig }))) {
      // distinguish the two failure modes so the UI can tell the user what actually went wrong:
      // no burn ticket at all (fee never paid/confirmed) vs. a valid ticket that timed out being
      // admitted (network/mesh). enforcePaid off (headless) → always the timeout case.
      const reason = enforcePaid && !myBurnProof ? 'fee-unpaid' : 'admit-timeout'
      onEvent({ event: 'gallery-error', reason })
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
      // my burn attestation — apply() keeps the tip `address` only if it's the wallet this
      // burn came from, so a tip always reaches the wallet that paid in (§ tip-address gate).
      // It's verified then dropped from the stored entry (kept lean); `tronAddress === address`.
      burn: burnProof || undefined,
      timestamp: Date.now()
    })
    log('posted selfie hop', hopCount)
    emitGallery()
  }

  // The worker reports a successful fee burn. Sign a burn attestation (ring key binds my
  // identity to the on-chain tx), stash it as my gallery-admission ticket, and return it.
  // Two consumers: the initiator attaches its KICK-OFF proof to the wave-announce (the
  // paid-wave gate, announcePaid); and any participant presents its proof (kick-off OR join)
  // when it requests to write a selfie — so a gallery seat requires a real burn (ensureWriter).
  function recordBurn({ reason, amount, txHash, waveId }) {
    // The burn is for `waveId` (threaded from payFee). Record it even if the wave has already
    // ended — the race completes at network speed, before a fee burn confirms, and the burn is
    // the ticket for a LATE gallery admission into the (still-open) originator gallery. Only drop
    // it if we've moved past that wave entirely (its gallery is no longer current) — never let a
    // stale burn overwrite the current wave's ticket.
    const wid = waveId || wave?.id
    if (!wid || (wid !== wave?.id && wid !== currentWaveId)) return null
    const fields = {
      waveId: wid,
      peerId: me.id,
      reason,
      amount,
      txHash,
      tronAddress: walletAddress || '',
      burnTs: Date.now()
    }
    myBurnProof = { ...fields, sig: signBurn(swarm.keyPair, fields) }
    return myBurnProof
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
    myBurnProof = null // a genuinely new wave (guarded above): drop the previous wave's burn ticket
    // paid: 'verified' when the kick-off burn is confirmed (or enforcement is off);
    // 'pending' while a peer verifies it on-chain; 'rejected' if it isn't a real burn.
    wave = {
      id: waveId,
      phase: 'lobby',
      by,
      roster: new Set([by]),
      joined: !!mine,
      paid: enforcePaid ? 'pending' : 'verified',
      kickoffProof: null,
      keySig: null // originator's signature over (waveId, galleryKey); set when we learn the key
    }
    if (mine) wave.roster.add(me.id)
    lobbyEndsAt = Date.now() + dur
    // fallback: if the race never starts (initiator vanished), drop back to idle
    clearTimeout(lobbyTimer)
    lobbyTimer = setTimeout(() => goIdle('lobby-timeout'), lobbyMs + 10000)
    if (silent) return
    onEvent({
      event: 'wave-announce',
      waveId,
      by,
      mine: !!mine,
      joined: wave.joined,
      count: wave.roster.size,
      lobbyMs: dur,
      paid: wave.paid // 'verified' (enforcement off / already paid) | 'pending' (verifying)
    })
  }

  // Opt in to the current lobby (renderer command / harness). Returns the joined waveId
  // (so the worker can charge the join fee on a real opt-in), or null if it was a no-op.
  function join() {
    if (!wave || wave.phase !== 'lobby' || wave.joined) return null
    // anti-spam: never join (and pay) a wave whose kick-off fee isn't proven paid
    if (wave.paid !== 'verified') {
      onEvent({ event: 'join-blocked', waveId: wave.id, reason: wave.paid })
      return null
    }
    wave.joined = true
    wave.roster.add(me.id)
    floodGossip({
      kind: 'wave-join',
      waveId: wave.id,
      peerId: me.id
    })
    onEvent({ event: 'joined', waveId: wave.id, count: wave.roster.size })
    return wave.id
  }

  // Transition the current wave from lobby to racing.
  function beginRace(rosterIds) {
    if (!wave) return
    wave.phase = 'racing'
    if (rosterIds) for (const id of rosterIds) wave.roster.add(id)
    clearTimeout(lobbyTimer)
    clearTimeout(waveTimer)
    waveTimer = setTimeout(() => goIdle('timeout'), WAVE_TIMEOUT_MS)
    onEvent({ event: 'wave-active', waveId: wave.id, joined: wave.joined, count: wave.roster.size })
  }

  function goIdle(reason) {
    if (!wave) return
    const waveId = wave.id
    endedWaves.add(waveId)
    wave = null
    resetSelfie() // drop any staged selfie / receipt for the next wave
    seen.clear() // only needed within the active wave; bound its growth
    teardown()
    onEvent({ event: 'wave-idle', waveId, reason })
  }

  // Finish the current wave: emit the outcome to the UI and return to idle. Shared by
  // the originator (local completion), a dead-end stall, and receiving a `wave-end`.
  function finishWave(waveId, { stalled = false, hops = 0, chainHash = '', byId = me.id } = {}) {
    if (stalled) onEvent({ event: 'stalled', waveId, reason: 'no successor' })
    else onEvent({ event: 'completed', waveId, hops, chainHash, angle: angleOfId(byId) })
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
    admissionPromise = null
    // NB: myBurnProof is NOT cleared here. The wave ends the instant the token completes
    // (it races at network speed), but a joiner's fee burn can confirm slightly later; the gallery
    // persists (the originator keeps it open) precisely so a late admission still lands, and
    // the burn attestation is that admission ticket. It's bound to its waveId (burnAuthorizes
    // checks burn.waveId), so keeping it is safe — it can only ever admit its own wave. It's
    // cleared instead when a genuinely new wave's lobby begins (enterLobby).
    admittedKeys.clear()
  }

  // Emit a holding event; canSelfie tells the renderer this peer is a participant (its
  // staged selfie will post now). Everyone else just relays the ball.
  function emitHolding(waveId, hopCount, receiptSig, chainHash, receiptTs) {
    recordMyReceipt(waveId, hopCount, receiptSig, chainHash, receiptTs)
    onEvent({
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
    const ring = liveRing([...peers.values()], Date.now(), PEER_STALE_MS)
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
      onEvent({
        event: 'stalled',
        waveId: token.waveId,
        reason: skipped.size ? 'no-reachable-successor' : 'no successor'
      })
      // Carry my hop receipt so peers can tell a genuine dead-end (from an admitted
      // participant) from a forged stall (an outsider trying to kill the wave).
      floodGossip({
        kind: 'wave-end',
        waveId: token.waveId,
        by: token.originator,
        stalled: true,
        staller: me.id,
        hopCount: token.hopCount,
        chainHash: token.prevChainHash,
        receiptTs: token.timestamp,
        receiptSig: token.senderReceiptSig
      })
      goIdle('stalled')
      return
    }
    senders.get(succ.id)(JSON.stringify(token))
    onEvent({ event: 'forwarded', waveId: token.waveId, hopCount: token.hopCount, to: succ.id })

    // heal: expect the peer I forwarded to (succ) to hold the ball soon; its wave-pos is the
    // ACK. Record succ.id so only *its* position clears the watch (see the wave-pos handler).
    clearTimeout(healTimer)
    healPending = { waveId: token.waveId, hop: token.hopCount, succId: succ.id }
    healTimer = setTimeout(() => {
      healPending = null
      skipped.add(succ.id)
      log('healing: successor', shortId(succ.id), 'silent — skipping')
      onEvent({ event: 'healed', waveId: token.waveId, skipped: succ.id })
      forwardToken(token, skipped)
    }, HEAL_TIMEOUT_MS)
  }

  function clearHeal() {
    clearTimeout(healTimer)
    healPending = null
  }

  // Build the next token this peer forwards, stamping hop `hopCount` with my receipt. The
  // gallery key travels with the token (the catch-up path for peers that missed wave-start),
  // carrying the originator's signature over it so a forwarder can't swap it (§ gallery-key).
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
      autobaseKey: autobaseKeyHex,
      autobaseKeySig: wave ? wave.keySig : null
    }
  }

  // I now hold this token: post my lobby selfie (if opted in — emitHolding records my
  // receipt, which pairs with the staged image), tell everyone the ball is at me, and
  // forward to my successor (at network speed — no dwell).
  function holdAndForward(token) {
    emitHolding(
      token.waveId,
      token.hopCount,
      token.senderReceiptSig,
      token.prevChainHash,
      token.timestamp
    )
    announcePosition(token.waveId, token.hopCount)
    forwardToken(token)
  }

  function processToken(token) {
    // Cheap rejects BEFORE the Ed25519 verify, to blunt a token-flood CPU DoS: drop a
    // competing/losing wave (single active wave at a time), and drop already-seen or
    // over-cap hops. Identity binding already guaranteed senderPeerId === the connection.
    if (!shouldAdopt(token.waveId)) return
    const key = token.waveId + '|' + token.hopCount
    // Completion only counts for a wave I'm actually running (else a token with
    // originator=me for a wave I never started could forge a completion).
    const isCompletion =
      wave && wave.id === token.waveId && token.originator === me.id && token.hopCount > 0
    if (!isCompletion && (seen.has(key) || token.hopCount > MAX_HOPS)) return

    if (!verifyToken(token)) {
      log('token: bad receipt from', shortId(token.senderPeerId || ''))
      return
    }

    // Completion: the token has returned to its originator. Tell everyone (signed so the
    // flooded wave-end can't be forged), then finish.
    if (isCompletion) {
      floodGossip({
        kind: 'wave-end',
        waveId: token.waveId,
        hops: token.hopCount,
        chainHash: token.prevChainHash,
        by: me.id,
        sig: signWaveEnd(swarm.keyPair, token.waveId, token.hopCount, token.prevChainHash)
      })
      finishWave(token.waveId, { hops: token.hopCount, chainHash: token.prevChainHash })
      return
    }
    seen.add(key)

    // adopt into the race (may switch from a higher-id wave, or catch up if we
    // missed the announce/start) and learn this wave's gallery
    if (!wave || wave.id !== token.waveId) {
      enterLobby(token.waveId, token.originator, false, 0, true)
    }
    if (wave.phase !== 'racing') beginRace()
    verifyAndOpenGallery(token.waveId, token.autobaseKey, token.autobaseKeySig, token.originator)

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
    if (wave) {
      onEvent({ event: 'busy', waveId: wave.id })
      return null
    }
    const waveId = b4a.toString(crypto.randomBytes(16), 'hex')
    initiatedWaves.add(waveId) // I own this wave: I keep its gallery open (archivist)
    enterLobby(waveId, me.id, true) // initiator auto-joins (marks its own lobby)
    if (enforcePaid) {
      // Anti-spam: don't announce yet. Wait for the worker to burn the kick-off fee and
      // prove it (announcePaid). Fall back to idle if that never happens.
      log('wave', shortId(waveId), '— awaiting kick-off payment')
      clearTimeout(lobbyTimer)
      lobbyTimer = setTimeout(() => goIdle('unpaid'), PAY_TIMEOUT_MS)
      onEvent({ event: 'paying', waveId })
    } else {
      doAnnounce(waveId, null) // legacy/no-wallet path: announce immediately, unpaid
    }
    return waveId
  }

  // Flood the wave-announce (carrying the kick-off `paid` proof when present) and start the
  // lobby→race timer. Shared by the paid and unpaid initiator paths.
  function doAnnounce(waveId, paidProof) {
    log('announcing wave', shortId(waveId), paidProof ? '(paid)' : '')
    floodGossip({
      kind: 'wave-announce',
      waveId,
      by: me.id,
      lobbyMs,
      paid: paidProof || undefined
    })
    clearTimeout(lobbyTimer)
    lobbyTimer = setTimeout(() => finalizeAndStart(waveId), lobbyMs)
  }

  // The worker proved the kick-off burn (after it confirmed on-chain) — attach the proof
  // and NOW announce. The initiator trusts its own confirmed burn (paid = 'verified').
  function announcePaid(proof) {
    if (!wave || wave.phase !== 'lobby' || !enforcePaid) return
    if (!validKickoff(proof, wave.id, me.id)) return
    wave.kickoffProof = proof
    wave.paid = 'verified'
    doAnnounce(wave.id, proof)
    onEvent({ event: 'wave-verified', waveId: wave.id, mine: true })
  }

  // A kick-off proof is structurally valid: signed (Ed25519) by the initiator over a
  // kick-off burn for this wave. (On-chain reality is checked separately, async.)
  function validKickoff(p, waveId, byId) {
    return !!(
      p &&
      p.reason === 'kickoff' &&
      p.waveId === waveId &&
      p.peerId === byId &&
      verifyBurn(p, p.sig)
    )
  }

  // Verify a wave's kick-off burn ON-CHAIN, then settle wave.paid. Abandons the wave if the
  // burn isn't real (anti-spam). No-op if enforcement is off or no verifier is wired.
  function verifyKickoff(waveId, proof) {
    if (!enforcePaid || !verifyBurnOnChain) return
    verifyBurnOnChain(proof.txHash, {
      waveId,
      from: proof.tronAddress,
      minTrx: proof.amount
    })
      .then((res) => {
        if (!wave || wave.id !== waveId || wave.phase !== 'lobby') return
        if (res && res.ok) {
          wave.paid = 'verified'
          onEvent({ event: 'wave-verified', waveId })
        } else {
          wave.paid = 'rejected'
          onEvent({ event: 'wave-unpaid', waveId, reason: res && res.reason })
          goIdle('unpaid-rejected')
        }
      })
      .catch(() => {})
  }

  async function finalizeAndStart(waveId) {
    if (!wave || wave.id !== waveId || wave.phase !== 'lobby') return
    openGallery(waveId, null) // create this wave's gallery, then wait for its key
    await base.ready()
    // I'm the originator: sign (waveId, galleryKey) so peers can trust the key I publish
    // (it rides unsigned/relayed fields otherwise — § gallery-key attestation).
    wave.keySig = signGalleryKey(swarm.keyPair, waveId, autobaseKey)

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
      key: autobaseKey,
      keySig: wave.keySig,
      paid: wave.kickoffProof || undefined // so peers adopting via start can re-sync newcomers
    })
    beginRace()
    onEvent({ event: 'started', waveId, by: me.id })

    // the originator is hop 0 — hold (post staged selfie if joined) and forward
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
    chord.scheduleBootstrap() // first connection -> place myself in the ring via findSuccessor

    // greet: my compact pointers (Phase 4 — no O(N) snapshot; carries liveness +
    // country too). The newcomer converges via DHT discovery (swarm.peers) +
    // pointer exchange; at small N the mesh also upserts every peer directly on connect.
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
          keySig: wave.keySig || undefined, // originator's signed gallery key (§ gallery-key)
          paid: wave.kickoffProof || undefined, // so a mid-lobby newcomer can verify + join
          lobbyMsLeft: wave.phase === 'lobby' ? Math.max(0, lobbyEndsAt - Date.now()) : 0
        })
      )
    }
    emit()

    conn.on('close', () => {
      senders.delete(id)
      peers.delete(id) // direct disconnect is authoritative for that peer
      goneUntil.set(id, Date.now() + PEER_STALE_MS) // cooldown: don't re-pin/re-hint it yet
      if (senders.size === 0) chord.markSolo() // went solo -> re-bootstrap on reconnect
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
  // The single heartbeat: pointers double as liveness (lastSeen refresh) and the slim
  // Phase-4 pointer exchange, so there's no separate presence message to keep in step.
  const tHeartbeat = setInterval(() => {
    broadcastToNeighbours(myPointers())
  }, HEARTBEAT_MS)
  const tRing = setInterval(() => {
    // re-pin ring edges from current discovery even if no 'update' fired
    maintainNeighbours()
    emit() // also re-evaluate TTL pruning
    // Pull replicated gallery writes for every gallery I hold. For most peers that's just the
    // current wave's; for a peer that initiated waves it also includes the galleries it retains
    // (so each keeps syncing and stays a live source for latecomers).
    for (const b of galleries.values()) b.update().catch(() => {})
    if (base) emitGallery()
  }, RINGUPDATE_MS)
  // Chord repair via distributed findSuccessor — correct a successor pointer my local
  // (possibly partial) view missed. Slow cadence; a no-op when local knowledge suffices.
  const tRepair = setInterval(() => {
    chord.repairSuccessor().catch(() => {})
  }, RINGUPDATE_MS * 4)

  return {
    me,
    startWave,
    join,
    setCountry,
    stageSelfie,
    // Wire the payment layer once the wallet is up: my address (for gallery tips /
    // attestations) and the on-chain burn verifier (enables the paid-wave anti-spam gate).
    setWallet: (address, verifier) => {
      walletAddress = address || null
      if (verifier) {
        verifyBurnOnChain = verifier
        enforcePaid = true
      }
    },
    announcePaid, // initiator: attach the confirmed kick-off proof + announce the wave
    recordBurn, // sign a fee-burn attestation (the kick-off proof for the paid-wave gate)
    // Distributed Chord lookup: the true successor of a peer id's ring position (or a
    // raw BigInt keyspace target). Resolves to a peer id, or null. (§4.5)
    findSuccessor: chord.findSuccessor,
    async close() {
      clearInterval(tHeartbeat)
      clearInterval(tRing)
      clearInterval(tRepair)
      clearTimeout(lobbyTimer)
      clearTimeout(waveTimer)
      clearTimeout(healTimer)
      chord.close()
      await swarm.destroy()
      for (const b of galleries.values()) await b.close().catch(() => {})
      await store.close()
    }
  }
}

module.exports = { createWave, parseBootstrap }
