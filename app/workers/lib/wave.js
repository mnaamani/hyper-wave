// HyperWave core P2P engine. Runtime-agnostic (Node + Bare): no path/fs, no IPC.
// The worker wires this to Electron IPC; a headless harness can drive it directly.
//
// Step 1: join the match topic, discover peers, ring position from pubkey.
// Step 2: presence + ring-update gossip over a Protomux channel multiplexed onto
//   each connection. Builds a live, sorted ring (with liveness TTL) so every peer
//   knows the full ring and its successor.
// Step 3: the token race. An originator mints a wave-token and forwards it to its
//   successor. Each peer verifies the sender's receipt, advances a constant-size
//   blake2b chain accumulator (final-idea.md §1.1 — NOT a growing hops[] array),
//   signs its own receipt, and forwards on. The token returns to the originator to
//   complete the lap. Ed25519 signing reuses the Hyperswarm keypair (= ring identity).

const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const Autobase = require('autobase')
const Protomux = require('protomux')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')

const MATCH = 'hyperwave:demo-match:v1'
const PRESENCE_MS = 2000 // heartbeat cadence
const RINGUPDATE_MS = 4000 // full-snapshot cadence (transitive discovery)
const TTL_MS = 12000 // drop peers not refreshed within this window
const ZERO_HASH = b4a.toString(b4a.alloc(32), 'hex') // genesis accumulator
const MAX_HOPS = 5000 // safety cap against runaway tokens
// Dwell per hop. The receipt chain could race in ~50-100ms, but a human-paced dwell
// is what makes the wave *visibly* ripple around the ring and staggers proof windows
// so selfies are taken in sequence (the stadium-wave feel). Configurable per wave.
const HOP_DELAY_MS = 1200

// Ring position: top 6 bytes of the key mapped onto [0, 360). The DHT keyspace
// is the stadium; your key is your seat (final-idea.md §2.1).
function angleOf (key) {
  let n = 0
  for (let i = 0; i < 6; i++) n = n * 256 + key[i]
  return (n / 2 ** 48) * 360
}

function shortId (hex) {
  return hex.slice(0, 8)
}

// --- pure ring logic (unit-tested in wave.logic.test.mjs) --------------------

// live peers, sorted clockwise by angle
function liveRing (entries, now, ttl) {
  return entries.filter((p) => now - p.lastSeen < ttl).sort((a, b) => a.angle - b.angle)
}

// next peer clockwise from myAngle (smallest angle > mine), wrapping to the first
function nextClockwise (myAngle, sortedRing) {
  if (sortedRing.length === 0) return null
  for (const p of sortedRing) if (p.angle > myAngle) return p
  return sortedRing[0]
}

// --- pure token logic (unit-tested in wave.token.test.mjs) -------------------

// A receipt binds a peer to a specific hop: sign(H(waveId|hop|prevChainHash|ts)).
function receiptHash (waveId, hopCount, prevChainHash, timestamp) {
  return crypto.hash(b4a.from(`${waveId}|${hopCount}|${prevChainHash}|${timestamp}`))
}

function signReceipt (keyPair, waveId, hopCount, prevChainHash, timestamp) {
  return b4a.toString(
    crypto.sign(receiptHash(waveId, hopCount, prevChainHash, timestamp), keyPair.secretKey),
    'hex'
  )
}

// Verify the receipt the *sender* stamped on the token they forwarded.
function verifyToken (token) {
  try {
    const h = receiptHash(token.waveId, token.hopCount, token.prevChainHash, token.timestamp)
    return crypto.verify(h, b4a.from(token.senderReceiptSig, 'hex'), b4a.from(token.senderPeerId, 'hex'))
  } catch {
    return false
  }
}

// Constant-size rolling accumulator: newHash = blake2b(prevHash || receiptSig).
function advanceChain (prevChainHash, receiptSigHex) {
  return b4a.toString(
    crypto.hash(b4a.concat([b4a.from(prevChainHash, 'hex'), b4a.from(receiptSigHex, 'hex')])),
    'hex'
  )
}

// Autobase config for the wave gallery. Shared by the engine and tests so the
// apply/view logic is exercised identically. apply() admits writers (the anti-spam
// gate) and appends wave-selfie ops into a single ordered view.
function galleryConfig () {
  return {
    valueEncoding: 'json',
    open: (s) => s.get('gallery', { valueEncoding: 'json' }),
    async apply (nodes, view, host) {
      for (const node of nodes) {
        const op = node.value
        if (op?.type === 'add-writer') {
          try {
            await host.addWriter(b4a.from(op.key, 'hex'), { indexer: true })
          } catch {}
          continue
        }
        if (op?.type === 'wave-selfie') await view.append(op)
      }
    }
  }
}

// Read all wave-selfie entries out of an Autobase view into an ordered gallery.
async function readGallery (base) {
  const view = base.view
  const items = []
  for (let i = 0; i < view.length; i++) {
    const e = await view.get(i)
    if (e?.type === 'wave-selfie') items.push(e)
  }
  return buildGallery(items)
}

// --- pure gallery ordering (unit-tested in wave.gallery.test.mjs) ------------

// Deterministic gallery: one entry per peer per wave (newest wins), ordered by hop.
function buildGallery (entries) {
  const byKey = new Map()
  for (const e of entries) {
    const k = e.waveId + '|' + e.peerId
    const prev = byKey.get(k)
    if (!prev || e.timestamp > prev.timestamp) byKey.set(k, e)
  }
  return [...byKey.values()].sort((a, b) => a.hopCount - b.hopCount || a.timestamp - b.timestamp)
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

  let base = null // the wave gallery Autobase (created by originator, opened by others)
  let autobaseKey = null // hex bootstrap key of `base`, shared via gossip + token

  // --- ring math -------------------------------------------------------------
  function emit () {
    const ring = liveRing([...peers.values()], Date.now(), TTL_MS)
    onState({ me, peers: ring, successor: nextClockwise(me.angle, ring) })
  }

  // --- peer table ------------------------------------------------------------
  function upsert (id, angle, lastSeen) {
    if (id === me.id) return
    const cur = peers.get(id)
    if (!cur || lastSeen > cur.lastSeen) peers.set(id, { id, angle, lastSeen })
  }

  function snapshot () {
    const now = Date.now()
    // include self (age 0) so neighbours learn about us transitively
    const out = [{ id: me.id, angle: me.angle, ageMs: 0 }]
    for (const p of peers.values()) out.push({ id: p.id, angle: p.angle, ageMs: now - p.lastSeen })
    return out
  }

  function handleGossip (m) {
    if (m.kind === 'token') {
      processToken(m)
      return
    }
    if (m.kind === 'autobase') {
      if (!base && m.key) openAutobase(b4a.from(m.key, 'hex'))
      return
    }
    if (m.kind === 'add-writer') {
      // Only an existing writer's append takes effect; the host bootstraps admission.
      if (base && base.writable && m.key) base.append({ type: 'add-writer', key: m.key })
      return
    }
    const now = Date.now()
    if (m.kind === 'presence') {
      upsert(m.id, m.angle, now)
    } else if (m.kind === 'peers') {
      for (const p of m.peers) upsert(p.id, p.angle, now - (p.ageMs || 0))
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

  // Open (or, with bootstrapKey=null, create) the wave gallery Autobase. All peers
  // share the originator's base; writes come from many admitted writers, merged into
  // one ordered view. Replication rides the existing store.replicate(conn).
  function openAutobase (bootstrapKey) {
    if (base) return base
    base = new Autobase(store.namespace('wave-gallery'), bootstrapKey, galleryConfig())
    base.on('update', emitGallery)
    base.ready().then(() => {
      autobaseKey = b4a.toString(base.key, 'hex')
      log('gallery ready', shortId(autobaseKey), 'writable', base.writable)
      emitGallery()
    })
    return base
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

  // Stamp my receipt onto a token and forward it to my successor.
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

  function processToken (token) {
    if (!verifyToken(token)) {
      log('token: bad receipt from', shortId(token.senderPeerId || ''))
      return
    }
    // Completion: the token has returned to its originator.
    if (token.originator === me.id && token.hopCount > 0) {
      onToken({
        event: 'completed',
        waveId: token.waveId,
        hops: token.hopCount,
        chainHash: token.prevChainHash
      })
      return
    }
    const key = token.waveId + '|' + token.hopCount
    if (seen.has(key) || token.hopCount > MAX_HOPS) return
    seen.add(key)

    // learn the gallery for this wave from the token
    if (!base && token.autobaseKey) openAutobase(b4a.from(token.autobaseKey, 'hex'))

    // Advance the constant-size accumulator and stamp my own receipt.
    const newChainHash = advanceChain(token.prevChainHash, token.senderReceiptSig)
    const hopCount = token.hopCount + 1
    const timestamp = Date.now()
    const senderReceiptSig = signReceipt(swarm.keyPair, token.waveId, hopCount, newChainHash, timestamp)

    // The proof window opens here: the renderer captures a selfie and calls
    // postSelfie() with this receipt (its ticket into the gallery).
    onToken({
      event: 'holding',
      waveId: token.waveId,
      hopCount,
      holder: me.id,
      receiptSig: senderReceiptSig,
      chainHash: newChainHash
    })

    // Dwell so the wave ripples visibly around the ring and proof windows open in
    // sequence rather than all at once.
    setTimeout(() => {
      forwardToken({
        kind: 'token',
        waveId: token.waveId,
        originator: token.originator,
        lap: token.lap,
        hopCount,
        prevChainHash: newChainHash,
        senderPeerId: me.id,
        senderReceiptSig,
        timestamp,
        autobaseKey: token.autobaseKey
      })
    }, hopDelayMs)
  }

  // Originate a new wave from this peer (Step 3: any peer can start; a Sponsor
  // Validator becomes the sole originator in a later step).
  async function startWave () {
    // create the gallery for this wave and wait until its key is known
    openAutobase(null)
    await base.ready()

    const waveId = b4a.toString(crypto.randomBytes(16), 'hex')
    const hopCount = 0
    const prevChainHash = ZERO_HASH
    const timestamp = Date.now()
    const senderReceiptSig = signReceipt(swarm.keyPair, waveId, hopCount, prevChainHash, timestamp)
    log('originating wave', shortId(waveId), 'gallery', shortId(autobaseKey))
    broadcast({ kind: 'autobase', key: autobaseKey })
    onToken({ event: 'started', waveId, by: me.id })
    // the originator is hop 0 — open their proof window too
    onToken({ event: 'holding', waveId, hopCount, holder: me.id, receiptSig: senderReceiptSig, chainHash: prevChainHash })
    setTimeout(() => {
      forwardToken({
        kind: 'token',
        waveId,
        originator: me.id,
        lap: 1,
        hopCount,
        prevChainHash,
        senderPeerId: me.id,
        senderReceiptSig,
        timestamp,
        autobaseKey
      })
    }, hopDelayMs)
    return waveId
  }

  // --- connections -----------------------------------------------------------
  swarm.on('connection', (conn) => {
    store.replicate(conn) // wired for the Autobase gallery in a later step

    const id = b4a.toString(conn.remotePublicKey, 'hex')
    upsert(id, angleOf(conn.remotePublicKey), Date.now())
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
    send(JSON.stringify({ kind: 'presence', id: me.id, angle: me.angle }))
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
    broadcast({ kind: 'presence', id: me.id, angle: me.angle })
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

module.exports = {
  createWave,
  angleOf,
  liveRing,
  nextClockwise,
  receiptHash,
  signReceipt,
  verifyToken,
  advanceChain,
  buildGallery,
  galleryConfig,
  readGallery,
  MATCH
}
