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
const { ZERO_HASH, signReceipt, verifyReceipt, verifyToken, advanceChain } = require('./token')
const { galleryConfig, readGallery } = require('./gallery')

const MATCH = 'hyperwave:demo-match:v1'
const PRESENCE_MS = 2000 // heartbeat cadence
const RINGUPDATE_MS = 4000 // full-snapshot cadence (transitive discovery)
const TTL_MS = 12000 // drop peers not refreshed within this window
const MAX_HOPS = 5000 // safety cap against runaway tokens
// Dwell per hop. The receipt chain could race in ~50-100ms, but a human-paced dwell
// is what makes the wave *visibly* ripple around the ring and staggers proof windows
// so selfies are taken in sequence (the stadium-wave feel). Configurable per wave.
const HOP_DELAY_MS = 1200
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
  lobbyMs = LOBBY_MS
}) {
  // Prune old galleries: the whole hyperwave store is per-run (galleries are keyed
  // by random waveId, nothing here persists across runs), so wipe it on startup to
  // reclaim disk instead of accumulating stale wave-gallery:<waveId> namespaces.
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
  const peers = new Map() // id -> { id, angle, lastSeen }
  const senders = new Map() // peerId -> gossip message send fn (for direct forwarding)
  const seen = new Set() // waveId|hopCount already processed (drop dupes/loops); cleared per wave
  const endedWaves = new Set() // waves that finished — never re-adopt (prevents revival)

  let base = null // the CURRENT wave's gallery Autobase (created by originator, opened by others)
  let autobaseKey = null // hex bootstrap key of `base`, shared via gossip + token
  let currentWaveId = null // which wave `base` belongs to (galleries are per-wave)

  // Wave lifecycle: idle -> lobby -> racing -> idle. One wave engaged at a time;
  // concurrent starts resolve deterministically (lower waveId wins). During the
  // lobby, peers opt in; only opted-in peers (the roster) get a selfie prompt — the
  // ball still visits everyone (relays), keeping the full-ring visual.
  //   wave = { id, phase: 'lobby'|'racing', by, roster: Set<id>, joined: bool } | null
  let wave = null
  let lobbyTimer = null // fires the race (initiator) or a fallback to idle (others)
  let waveTimer = null // racing timeout
  let healTimer = null // watches my forward; fires if the wave doesn't advance
  let healPending = null // { waveId, hop } I'm currently watching

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

  // The nation this peer supports; rides presence gossip + selfie entries (cosmetic).
  function setCountry(code) {
    me.country = code || null
    emit()
  }

  function snapshot() {
    const now = Date.now()
    // include self (age 0) so neighbours learn about us transitively
    const out = [{ id: me.id, ageMs: 0, country: me.country }]
    for (const p of peers.values()) {
      out.push({ id: p.id, ageMs: now - p.lastSeen, country: p.country })
    }
    return out
  }

  function handleGossip(m) {
    if (m.kind === 'token') return processToken(m)
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
        if (m.stalled) onToken({ event: 'stalled', waveId: m.waveId, reason: 'no successor' })
        else {
          onToken({
            event: 'completed',
            waveId: m.waveId,
            hops: m.hops,
            chainHash: m.chainHash,
            angle: angleOfId(m.by)
          })
        }
        goIdle(m.stalled ? 'stalled' : 'ended')
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
    const now = Date.now()
    if (m.kind === 'presence') {
      upsert(m.id, now, m.country)
    } else if (m.kind === 'peers') {
      for (const p of m.peers) upsert(p.id, now - (p.ageMs || 0), p.country)
    }
    emit()
  }

  function broadcast(obj) {
    const str = JSON.stringify(obj)
    for (const send of senders.values()) {
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
    if (base && currentWaveId === waveId) return base
    if (base) base.close().catch(() => {}) // moved on to a new wave
    currentWaveId = waveId
    autobaseKey = null
    const b = new Autobase(store.namespace('wave-gallery:' + waveId), bootstrapKey, galleryConfig())
    base = b
    b.on('update', emitGallery)
    b.ready().then(() => {
      if (base !== b) return // superseded by a newer wave
      autobaseKey = b4a.toString(b.key, 'hex')
      log('gallery ready', shortId(waveId), 'key', shortId(autobaseKey), 'writable', b.writable)
      emitGallery()
    })
    return b
  }

  async function emitGallery() {
    if (!base) return
    onGallery(await readGallery(base))
  }

  // Post my selfie to the gallery. Requests writer admission first (anti-spam gate:
  // the host admits the poster), then appends the entry once writable.
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
    await base.ready()
    if (!base.writable) {
      // ask to be admitted, presenting my receipt for this wave (the anti-spam gate)
      broadcast({
        kind: 'add-writer',
        key: b4a.toString(base.local.key, 'hex'),
        peerId: me.id,
        waveId,
        hopCount,
        chainHash,
        receiptTs,
        receiptSig
      })
      const ok = await waitFor(() => base.writable, 8000)
      if (!ok) {
        onToken({ event: 'gallery-error', reason: 'not-admitted' })
        return
      }
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
      timestamp: Date.now()
    })
    log('posted selfie hop', hopCount)
    emitGallery()
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
  function enterLobby(waveId, by, mine, dur = lobbyMs) {
    if (wave && wave.id === waveId) return
    if (wave) {
      // superseded by a lower-id wave — abandon the old one
      endedWaves.add(wave.id)
      teardown()
    }
    wave = { id: waveId, phase: 'lobby', by, roster: new Set([by]), joined: !!mine }
    if (mine) wave.roster.add(me.id)
    // fallback: if the race never starts (initiator vanished), drop back to idle
    clearTimeout(lobbyTimer)
    lobbyTimer = setTimeout(() => goIdle('lobby-timeout'), lobbyMs + 10000)
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

  // Opt in to the current lobby (renderer command / harness).
  function join() {
    if (!wave || wave.phase !== 'lobby' || wave.joined) return
    wave.joined = true
    wave.roster.add(me.id)
    broadcast({ kind: 'wave-join', waveId: wave.id, peerId: me.id })
    onToken({ event: 'joined', waveId: wave.id, count: wave.roster.size })
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
    seen.clear() // only needed within the active wave; bound its growth
    teardown()
    onToken({ event: 'wave-idle', waveId, reason })
  }

  // Emit a holding event; canSelfie tells the renderer whether to open the proof
  // window (only opted-in roster members selfie; everyone else just relays).
  function emitHolding(waveId, hopCount, receiptSig, chainHash, receiptTs) {
    const canSelfie = !!(wave && wave.roster.has(me.id))
    onToken({
      event: 'holding',
      waveId,
      hopCount,
      holder: me.id,
      angle: me.angle,
      receiptSig,
      chainHash,
      receiptTs,
      canSelfie
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
      broadcast({ kind: 'wave-end', waveId: token.waveId, by: token.originator, stalled: true })
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

  function processToken(token) {
    if (!verifyToken(token)) {
      log('token: bad receipt from', shortId(token.senderPeerId || ''))
      return
    }
    // Ignore tokens from a competing/losing wave (single active wave at a time).
    if (!shouldAdopt(token.waveId)) return

    // Completion: the token has returned to its originator. Tell everyone.
    if (token.originator === me.id && token.hopCount > 0) {
      broadcast({
        kind: 'wave-end',
        waveId: token.waveId,
        hops: token.hopCount,
        chainHash: token.prevChainHash,
        by: me.id
      })
      onToken({
        event: 'completed',
        waveId: token.waveId,
        hops: token.hopCount,
        chainHash: token.prevChainHash,
        angle: me.angle
      })
      goIdle('completed')
      return
    }
    const key = token.waveId + '|' + token.hopCount
    if (seen.has(key) || token.hopCount > MAX_HOPS) return
    seen.add(key)

    // adopt into the race (may switch from a higher-id wave, or catch up if we
    // missed the announce/start) and learn this wave's gallery
    if (!wave || wave.id !== token.waveId) enterLobby(token.waveId, token.originator, false)
    if (wave.phase !== 'racing') beginRace()
    if (token.autobaseKey && token.waveId) {
      openGallery(token.waveId, b4a.from(token.autobaseKey, 'hex'))
    }

    const newChainHash = advanceChain(token.prevChainHash, token.senderReceiptSig)
    const hopCount = token.hopCount + 1
    const next = stampToken(
      token.waveId,
      token.originator,
      hopCount,
      newChainHash,
      token.autobaseKey
    )

    // Ball reaches me: everyone relays; only opted-in peers open the proof window.
    emitHolding(token.waveId, hopCount, next.senderReceiptSig, newChainHash, next.timestamp)
    announcePosition(token.waveId, hopCount)

    // Dwell so the wave ripples visibly around the ring and proof windows open in
    // sequence rather than all at once.
    setTimeout(() => forwardToken(next), hopDelayMs)
  }

  // Announce a new wave and open the lobby (any peer can start when idle). After the
  // lobby window the initiator finalizes the roster and the token starts racing.
  function startWave() {
    if (wave) {
      onToken({ event: 'busy', waveId: wave.id })
      return null
    }
    const waveId = b4a.toString(crypto.randomBytes(16), 'hex')
    log('announcing wave', shortId(waveId))
    enterLobby(waveId, me.id, true) // initiator auto-joins
    broadcast({ kind: 'wave-announce', waveId, by: me.id, lobbyMs })
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
    broadcast({ kind: 'wave-start', waveId, by: me.id, roster: [...wave.roster], key: autobaseKey })
    beginRace()
    onToken({ event: 'started', waveId, by: me.id })

    const token = stampToken(waveId, me.id, 0, ZERO_HASH, autobaseKey)
    // the originator is hop 0 — open their proof window too (if they joined)
    emitHolding(waveId, 0, token.senderReceiptSig, ZERO_HASH, token.timestamp)
    announcePosition(waveId, 0)
    setTimeout(() => forwardToken(token), hopDelayMs)
  }

  // --- connections -----------------------------------------------------------
  swarm.on('connection', (conn) => {
    store.replicate(conn) // carries gossip mux + Autobase gallery replication

    const id = b4a.toString(conn.remotePublicKey, 'hex')
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
        handleGossip(m)
      }
    })
    channel.open()

    const send = (str) => message.send(str)
    senders.set(id, send)

    // greet: presence + full snapshot so the new peer converges immediately
    send(JSON.stringify({ kind: 'presence', id: me.id, country: me.country }))
    send(JSON.stringify({ kind: 'peers', peers: snapshot() }))
    emit()

    conn.on('close', () => {
      senders.delete(id)
      peers.delete(id) // direct disconnect is authoritative for that peer
      log('peer disconnected', shortId(id))
      emit()
    })
    conn.on('error', () => {})
  })

  const topic = crypto.hash(b4a.from(matchId))
  const discovery = swarm.join(topic, { server: true, client: true })
  discovery.flushed().then(() => {
    log('joined match', matchId, 'topic', shortId(b4a.toString(topic, 'hex')), 'as', shortId(me.id))
    emit()
  })

  // --- timers ----------------------------------------------------------------
  const tPresence = setInterval(() => {
    broadcast({ kind: 'presence', id: me.id, country: me.country })
  }, PRESENCE_MS)
  const tRing = setInterval(() => {
    broadcast({ kind: 'peers', peers: snapshot() })
    emit() // also re-evaluate TTL pruning
    if (base) {
      base
        .update()
        .then(emitGallery)
        .catch(() => {})
    } // pull replicated gallery writes
  }, RINGUPDATE_MS)

  return {
    me,
    startWave,
    join,
    setCountry,
    postSelfie,
    async close() {
      clearInterval(tPresence)
      clearInterval(tRing)
      clearTimeout(lobbyTimer)
      clearTimeout(waveTimer)
      clearTimeout(healTimer)
      await swarm.destroy()
      if (base) await base.close()
      await store.close()
    }
  }
}

module.exports = { createWave, MATCH }
