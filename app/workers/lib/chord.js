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

module.exports = {
  RING,
  nodeId,
  nodeIdOfHex,
  ringOrder,
  successors,
  predecessor,
  connectionTargets
}
