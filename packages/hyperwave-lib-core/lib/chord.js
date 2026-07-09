// Pure Chord pointer math (scalable-topology.md §4). No state, no I/O — unit-tested
// in chord.test.js. wave.js uses this to decide which peers to deliberately connect
// to (swarm.joinPeer) so the logical ring's edges become physical, instead of
// relying on Hyperswarm's incidental full mesh.
//
// Identifier space (§4.1): nodeId = top 8 bytes of the key as an unsigned 64-bit
// integer, ring is mod 2^64. This is the same big-endian key prefix ring.js maps to
// an angle, so the two orderings agree; the extra bytes just break near-ties
// deterministically. BigInt keeps the 64-bit math exact without overflow surprises.
const b4a = require('b4a');

const RING = 1n << 64n; // 2^64

function nodeId(key) {
  let nid = 0n;
  for (let i = 0; i < 8; i++) {
    nid = (nid << 8n) | BigInt(key[i]);
  }
  return nid;
}

function nodeIdOfHex(hex) {
  return nodeId(b4a.from(hex, 'hex'));
}

// Ascending BigInt comparator (BigInts can't use plain subtraction into a Number sort key).
function byNid(a, b) {
  if (a.nid < b.nid) {
    return -1;
  }
  if (a.nid > b.nid) {
    return 1;
  }
  return 0;
}

// Order a set of hex ids clockwise by nodeId (ascending, mod 2^64). Dedupes.
function ringOrder(ids) {
  return [...new Set(ids)].map((id) => ({ id, nid: nodeIdOfHex(id) })).sort(byNid);
}

// The next up-to-k ids clockwise from me (the successor-list, §4.3). Wraps around
// the ring; never includes me, and caps at the number of other nodes so a small
// ring doesn't wrap back onto myself.
function successors(ids, myId, k = 3) {
  const ring = ringOrder([myId, ...ids]);
  const ringSize = ring.length;
  if (ringSize <= 1) {
    return [];
  }
  const myIndex = ring.findIndex((node) => node.id === myId);
  const out = [];
  for (let j = 1; j <= k && j < ringSize; j++) {
    out.push(ring[(myIndex + j) % ringSize].id);
  }
  return out;
}

// The single id immediately counter-clockwise from me (the predecessor, §4.3),
// wrapping to the highest nodeId. null if I'm the only node.
function predecessor(ids, myId) {
  const ring = ringOrder([myId, ...ids]);
  const ringSize = ring.length;
  if (ringSize <= 1) {
    return null;
  }
  const myIndex = ring.findIndex((node) => node.id === myId);
  return ring[(myIndex - 1 + ringSize) % ringSize].id;
}

// The set of ids whose ring edges we want physically connected (Phase 2):
// my successor-list plus my predecessor. This is what wave.js joinPeer()s.
function connectionTargets(ids, myId, k = 3) {
  const set = new Set(successors(ids, myId, k));
  const pred = predecessor(ids, myId);
  if (pred) {
    set.add(pred);
  }
  return set;
}

// Chord's findSuccessor over a pre-ordered ring (§4.5): the first node at-or-
// clockwise-after keyspace position `target` (BigInt, mod 2^64), wrapping to the
// lowest nodeId. `ring` is the output of ringOrder (ascending by nid). null if empty.
function successorOf(ring, target) {
  if (ring.length === 0) {
    return null;
  }
  for (const node of ring) {
    if (node.nid >= target) {
      return node;
    }
  }
  return ring[0]; // wrapped past the top of the ring
}

// Public findSuccessor: the id of the first node clockwise from keyspace position
// `target`. Used to build the finger table; also the lookup primitive for placing
// where a token starts / where a joining node inserts (§4.5).
function findSuccessor(ids, target) {
  const node = successorOf(ringOrder(ids), target);
  return node ? node.id : null;
}

// Chord finger table (§4.3): finger[i] = successor of (myNid + 2^i) mod 2^64, for
// i in 0..63. Returns the DISTINCT finger node ids (excluding me). For a ring of N
// nodes the distinct fingers collapse to O(log N) — the whole point: deliberate
// connections stay logarithmic instead of a full mesh, while still spanning the ring.
function fingers(ids, myId) {
  const myNid = nodeIdOfHex(myId);
  const ring = ringOrder([myId, ...ids]);
  const out = new Set();
  for (let i = 0; i < 64; i++) {
    const node = successorOf(ring, (myNid + (1n << BigInt(i))) % RING);
    if (node && node.id !== myId) {
      out.add(node.id);
    }
  }
  return out;
}

// Is nodeId `x` strictly inside the open ring interval (a, b), moving clockwise
// (mod 2^64)? When a >= b the interval wraps past the top of the ring. All BigInt.
function inOpenInterval(x, a, b) {
  if (a < b) {
    return x > a && x < b;
  }
  return x > a || x < b;
}

// x ∈ (a, b] on the mod-2^64 ring (half-open, includes the upper end). a === b is the
// whole ring (single-node case). Used for Chord's "target ∈ (me, successor]" test.
function inHalfOpenInterval(x, a, b) {
  if (a === b) {
    return true;
  }
  if (a < b) {
    return x > a && x <= b;
  }
  return x > a || x <= b;
}

// Clockwise ring distance from a to b (mod 2^64).
function ringForward(a, b) {
  return (b - a + RING) % RING;
}

// Chord's closest_preceding_node: among the ids I know (fingers + successors), the one
// whose nodeId lies in the open interval (me, target) and is *closest* to target — the
// finger to forward a lookup for `target` to, so each hop jumps as far as possible
// without overshooting. `target` is a BigInt keyspace position. null if none precedes it.
function closestPrecedingNode(known, myId, target) {
  const myNid = nodeIdOfHex(myId);
  let best = null;
  let bestFwd = -1n;
  for (const id of known) {
    if (id === myId) {
      continue;
    }
    const nid = nodeIdOfHex(id);
    if (!inOpenInterval(nid, myNid, target)) {
      continue;
    }
    const fwd = ringForward(myNid, nid);
    if (fwd > bestFwd) {
      best = id;
      bestFwd = fwd;
    }
  }
  return best;
}

// One hop of Chord's DISTRIBUTED findSuccessor (§4.5), evaluated over MY local knowledge
// only — this is what lets a lookup resolve correctly when no single node knows the whole
// ring. `me`/`successor` = my id and my successor's id; `known` = my finger + successor
// ids; `target` = the keyspace position (BigInt) whose successor we're locating.
//   - target ∈ (me, successor]  → the answer is my successor: { done: true, successor }
//   - otherwise                 → forward to my closest preceding finger: { done: false, next }
//   - no finger precedes target → my successor is the best answer: { done: true, successor }
// Applied hop-to-hop (each node using its own `known`), this converges to the true
// successor in O(log N) hops with a full finger table, or degrades to a correct linear
// walk along successors if a node only knows its successor.
function findSuccessorStep(me, successor, known, target) {
  const myNid = nodeIdOfHex(me);
  const succNid = successor !== null ? nodeIdOfHex(successor) : myNid;
  if (inHalfOpenInterval(target, myNid, succNid)) {
    return { done: true, successor };
  }
  const next = closestPrecedingNode(known, me, target);
  if (next === null) {
    return { done: true, successor };
  }
  return { done: false, next };
}

// One Chord stabilize step (§4.4): my successor's predecessor `succPred` becomes my
// successor if it sits strictly between me and my current successor — that means a
// node joined (or was discovered) between us. Returns the id to use as successor
// (`succPred` if it's closer, else the unchanged current). Ids are hex; null-safe.
function stabilizeStep(myId, currentSuccId, succPredId) {
  if (!succPredId || succPredId === myId || succPredId === currentSuccId) {
    return currentSuccId;
  }
  if (!currentSuccId) {
    return succPredId;
  }
  const me = nodeIdOfHex(myId);
  const succNid = nodeIdOfHex(currentSuccId);
  const candidateNid = nodeIdOfHex(succPredId);
  return inOpenInterval(candidateNid, me, succNid) ? succPredId : currentSuccId;
}

// The full set of peers to keep physically connected (Phase 3): successor-list +
// predecessor (for the token walk / fault tolerance) unioned with the finger table
// (for O(log N) ring-spanning reachability). This is what wave.js joinPeer()s.
function pinTargets(ids, myId, k = 3) {
  const set = connectionTargets(ids, myId, k);
  for (const finger of fingers(ids, myId)) {
    set.add(finger);
  }
  return set;
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
  pinTargets,
  inOpenInterval,
  stabilizeStep,
  inHalfOpenInterval,
  ringForward,
  closestPrecedingNode,
  findSuccessorStep
};
