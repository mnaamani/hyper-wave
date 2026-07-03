// Pure Chord pointer math (scalable-topology.md §4). No state, no I/O — unit-tested
// in chord.test.js. wave.js uses this to decide which peers to deliberately connect
// to (swarm.joinPeer) so the logical ring's edges become physical, instead of
// relying on Hyperswarm's incidental full mesh.
//
// Identifier space (§4.1): nodeId = top 8 bytes of the key as an unsigned 64-bit
// integer, ring is mod 2^64. This is the same big-endian key prefix ring.js maps to
// an angle, so the two orderings agree; the extra bytes just break near-ties
// deterministically. BigInt keeps the 64-bit math exact without overflow surprises.
const b4a = require('b4a')

const RING = 1n << 64n // 2^64

function nodeId(key) {
  let n = 0n
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(key[i])
  return n
}

function nodeIdOfHex(hex) {
  return nodeId(b4a.from(hex, 'hex'))
}

// Order a set of hex ids clockwise by nodeId (ascending, mod 2^64). Dedupes.
function ringOrder(ids) {
  return [...new Set(ids)]
    .map((id) => ({ id, nid: nodeIdOfHex(id) }))
    .sort((a, b) => (a.nid < b.nid ? -1 : a.nid > b.nid ? 1 : 0))
}

// The next up-to-k ids clockwise from me (the successor-list, §4.3). Wraps around
// the ring; never includes me, and caps at the number of other nodes so a small
// ring doesn't wrap back onto myself.
function successors(ids, myId, k = 3) {
  const ring = ringOrder([myId, ...ids])
  const n = ring.length
  if (n <= 1) return []
  const i = ring.findIndex((x) => x.id === myId)
  const out = []
  for (let j = 1; j <= k && j < n; j++) out.push(ring[(i + j) % n].id)
  return out
}

// The single id immediately counter-clockwise from me (the predecessor, §4.3),
// wrapping to the highest nodeId. null if I'm the only node.
function predecessor(ids, myId) {
  const ring = ringOrder([myId, ...ids])
  const n = ring.length
  if (n <= 1) return null
  const i = ring.findIndex((x) => x.id === myId)
  return ring[(i - 1 + n) % n].id
}

// The set of ids whose ring edges we want physically connected (Phase 2):
// my successor-list plus my predecessor. This is what wave.js joinPeer()s.
function connectionTargets(ids, myId, k = 3) {
  const set = new Set(successors(ids, myId, k))
  const pred = predecessor(ids, myId)
  if (pred) set.add(pred)
  return set
}

// Chord's findSuccessor over a pre-ordered ring (§4.5): the first node at-or-
// clockwise-after keyspace position `target` (BigInt, mod 2^64), wrapping to the
// lowest nodeId. `ring` is the output of ringOrder (ascending by nid). null if empty.
function successorOf(ring, target) {
  if (ring.length === 0) return null
  for (const node of ring) if (node.nid >= target) return node
  return ring[0] // wrapped past the top of the ring
}

// Public findSuccessor: the id of the first node clockwise from keyspace position
// `target`. Used to build the finger table; also the lookup primitive for placing
// where a token starts / where a joining node inserts (§4.5).
function findSuccessor(ids, target) {
  const node = successorOf(ringOrder(ids), target)
  return node ? node.id : null
}

// Chord finger table (§4.3): finger[i] = successor of (myNid + 2^i) mod 2^64, for
// i in 0..63. Returns the DISTINCT finger node ids (excluding me). For a ring of N
// nodes the distinct fingers collapse to O(log N) — the whole point: deliberate
// connections stay logarithmic instead of a full mesh, while still spanning the ring.
function fingers(ids, myId) {
  const myNid = nodeIdOfHex(myId)
  const ring = ringOrder([myId, ...ids])
  const out = new Set()
  for (let i = 0; i < 64; i++) {
    const node = successorOf(ring, (myNid + (1n << BigInt(i))) % RING)
    if (node && node.id !== myId) out.add(node.id)
  }
  return out
}

// The full set of peers to keep physically connected (Phase 3): successor-list +
// predecessor (for the token walk / fault tolerance) unioned with the finger table
// (for O(log N) ring-spanning reachability). This is what wave.js joinPeer()s.
function pinTargets(ids, myId, k = 3) {
  const set = connectionTargets(ids, myId, k)
  for (const f of fingers(ids, myId)) set.add(f)
  return set
}

module.exports = {
  RING,
  nodeId,
  nodeIdOfHex,
  ringOrder,
  successors,
  predecessor,
  connectionTargets,
  findSuccessor,
  fingers,
  pinTargets
}
