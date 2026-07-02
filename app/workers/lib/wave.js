// HyperWave orchestrator. Wires the transport (Hyperswarm + Protomux gossip) to the
// three pure domains — ring geometry (ring.js), the token race (token.js), and the
// selfie gallery (gallery.js). Runtime-agnostic (Node + Bare): no path/fs, no IPC.
// The Bare worker (hyperwave.js) bridges this to the renderer; wave.run.js drives it
// headlessly. The payment layer will attach here as its own module.

const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const Autobase = require('autobase')
const Protomux = require('protomux')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')

const { angleOf, angleOfId, liveRing, nextClockwise } = require('./ring')
const { ZERO_HASH, signReceipt, verifyToken, advanceChain } = require('./token')
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

function shortId (hex) {
  return hex.slice(0, 8)
}

function createWave ({ storageDir, onState, onToken = () => {}, onGallery = () => {}, log = () => {}, bootstrap = null, matchId = MATCH, hopDelayMs = HOP_DELAY_MS }) {
  const store = new Corestore(storageDir + '/hyperwave')
  // bootstrap: pass a local DHT for instant same-machine discovery (tests / single
  // -laptop demo). Omit for the public DHT (cross-machine, ~20-35s cold discovery).
  const swarm = new Hyperswarm(bootstrap ? { bootstrap } : {})

  const meKey = swarm.keyPair.publicKey
  const me = { id: b4a.toString(meKey, 'hex'), angle: angleOf(meKey) }
  const peers = new Map() // id -> { id, angle, lastSeen }
  const senders = new Map() // peerId -> gossip message send fn (for direct forwarding)
  const seen = new Set() // waveId|hopCount already processed (drop dupes/loops)

  let base = null // the CURRENT wave's gallery Autobase (created by originator, opened by others)
  let autobaseKey = null // hex bootstrap key of `base`, shared via gossip + token
  let currentWaveId = null // which wave `base` belongs to (galleries are per-wave)

  // --- ring / peer table -----------------------------------------------------
  function emit () {
    const ring = liveRing([...peers.values()], Date.now(), TTL_MS)
    onState({ me, peers: ring, successor: nextClockwise(me.angle, ring) })
  }

  // Angle is always derived from the peer id, never trusted from the wire.
  function upsert (id, lastSeen) {
    if (id === me.id) return
    const cur = peers.get(id)
    if (!cur || lastSeen > cur.lastSeen) peers.set(id, { id, angle: angleOfId(id), lastSeen })
  }

  function snapshot () {
    const now = Date.now()
    // include self (age 0) so neighbours learn about us transitively
    const out = [{ id: me.id, ageMs: 0 }]
    for (const p of peers.values()) out.push({ id: p.id, ageMs: now - p.lastSeen })
    return out
  }

  function handleGossip (m) {
    if (m.kind === 'token') return processToken(m)
    if (m.kind === 'wave-pos') {
      // the ball is at `holder` — every peer animates it there (angle derived locally)
      onToken({ event: 'position', waveId: m.waveId, holder: m.holder, angle: angleOfId(m.holder), hopCount: m.hopCount })
      return
    }
    if (m.kind === 'autobase') {
      if (m.key && m.waveId) openGallery(m.waveId, b4a.from(m.key, 'hex'))
      return
    }
    if (m.kind === 'add-writer') {
      // Only an existing writer's append takes effect; the host bootstraps admission.
      if (base && base.writable && m.key) base.append({ type: 'add-writer', key: m.key })
      return
    }
    const now = Date.now()
    if (m.kind === 'presence') {
      upsert(m.id, now)
    } else if (m.kind === 'peers') {
      for (const p of m.peers) upsert(p.id, now - (p.ageMs || 0))
    }
    emit()
  }

  function broadcast (obj) {
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
  function openGallery (waveId, bootstrapKey) {
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

  async function emitGallery () {
    if (!base) return
    onGallery(await readGallery(base))
  }

  // Post my selfie to the gallery. Requests writer admission first (anti-spam gate:
  // the host admits the poster), then appends the entry once writable.
  async function postSelfie ({ waveId, hopCount, receiptSig, chainHash, caption, image }) {
    if (!base) {
      onToken({ event: 'gallery-error', reason: 'no-gallery-yet' })
      return
    }
    await base.ready()
    if (!base.writable) {
      broadcast({ kind: 'add-writer', key: b4a.toString(base.local.key, 'hex') })
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
      angle: me.angle,
      hopCount,
      receiptSig,
      chainHash,
      caption: caption || '',
      image: image || '',
      timestamp: Date.now()
    })
    log('posted selfie hop', hopCount)
    emitGallery()
  }

  function waitFor (pred, timeoutMs) {
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

  // --- token race ------------------------------------------------------------

  // Tell every peer the ball is at me now, so all windows animate it here.
  function announcePosition (waveId, hopCount) {
    broadcast({ kind: 'wave-pos', waveId, holder: me.id, hopCount })
  }

  // Forward a token (already stamped with my receipt) to my successor.
  function forwardToken (token) {
    const ring = liveRing([...peers.values()], Date.now(), TTL_MS)
    const succ = nextClockwise(me.angle, ring)
    if (!succ) {
      onToken({ event: 'stalled', waveId: token.waveId, reason: 'no successor' })
      return
    }
    const send = senders.get(succ.id)
    if (!send) {
      // Successor known via gossip but not directly connected. Healing is a later
      // step; for the fully-connected MVP this should not happen.
      onToken({ event: 'stalled', waveId: token.waveId, reason: 'successor-unreachable', successor: succ.id })
      return
    }
    send(JSON.stringify(token))
    onToken({ event: 'forwarded', waveId: token.waveId, hopCount: token.hopCount, to: succ.id })
  }

  // Build the next token this peer forwards, stamping hop `hopCount` with my receipt.
  function stampToken (waveId, originator, lap, hopCount, prevChainHash, autobaseKeyHex) {
    const timestamp = Date.now()
    const senderReceiptSig = signReceipt(swarm.keyPair, waveId, hopCount, prevChainHash, timestamp)
    return {
      kind: 'token',
      waveId,
      originator,
      lap,
      hopCount,
      prevChainHash,
      senderPeerId: me.id,
      senderReceiptSig,
      timestamp,
      autobaseKey: autobaseKeyHex
    }
  }

  function processToken (token) {
    if (!verifyToken(token)) {
      log('token: bad receipt from', shortId(token.senderPeerId || ''))
      return
    }
    // Completion: the token has returned to its originator.
    if (token.originator === me.id && token.hopCount > 0) {
      onToken({ event: 'completed', waveId: token.waveId, hops: token.hopCount, chainHash: token.prevChainHash, angle: me.angle })
      return
    }
    const key = token.waveId + '|' + token.hopCount
    if (seen.has(key) || token.hopCount > MAX_HOPS) return
    seen.add(key)

    // learn (and switch to) this wave's gallery from the token
    if (token.autobaseKey && token.waveId) openGallery(token.waveId, b4a.from(token.autobaseKey, 'hex'))

    const newChainHash = advanceChain(token.prevChainHash, token.senderReceiptSig)
    const hopCount = token.hopCount + 1
    const next = stampToken(token.waveId, token.originator, token.lap, hopCount, newChainHash, token.autobaseKey)

    // The proof window opens here: the renderer captures a selfie and calls
    // postSelfie() with this receipt (its ticket into the gallery).
    onToken({ event: 'holding', waveId: token.waveId, hopCount, holder: me.id, angle: me.angle, receiptSig: next.senderReceiptSig, chainHash: newChainHash })
    announcePosition(token.waveId, hopCount)

    // Dwell so the wave ripples visibly around the ring and proof windows open in
    // sequence rather than all at once.
    setTimeout(() => forwardToken(next), hopDelayMs)
  }

  // Originate a new wave from this peer (any peer can start; a Sponsor Validator
  // becomes the sole originator once the payment layer lands).
  async function startWave () {
    const waveId = b4a.toString(crypto.randomBytes(16), 'hex')
    openGallery(waveId, null) // create this wave's gallery, then wait for its key
    await base.ready()

    const token = stampToken(waveId, me.id, 1, 0, ZERO_HASH, autobaseKey)
    log('originating wave', shortId(waveId), 'gallery', shortId(autobaseKey))
    broadcast({ kind: 'autobase', waveId, key: autobaseKey })
    onToken({ event: 'started', waveId, by: me.id })
    // the originator is hop 0 — open their proof window too
    onToken({ event: 'holding', waveId, hopCount: 0, holder: me.id, angle: me.angle, receiptSig: token.senderReceiptSig, chainHash: ZERO_HASH })
    announcePosition(waveId, 0)
    setTimeout(() => forwardToken(token), hopDelayMs)
    return waveId
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
      onmessage (str) {
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
    send(JSON.stringify({ kind: 'presence', id: me.id }))
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
    broadcast({ kind: 'presence', id: me.id })
  }, PRESENCE_MS)
  const tRing = setInterval(() => {
    broadcast({ kind: 'peers', peers: snapshot() })
    emit() // also re-evaluate TTL pruning
    if (base) base.update().then(emitGallery).catch(() => {}) // pull replicated gallery writes
  }, RINGUPDATE_MS)

  return {
    me,
    startWave,
    postSelfie,
    async close () {
      clearInterval(tPresence)
      clearInterval(tRing)
      await swarm.destroy()
      if (base) await base.close()
      await store.close()
    }
  }
}

module.exports = { createWave, MATCH }
