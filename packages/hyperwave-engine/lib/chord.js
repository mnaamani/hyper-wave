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

/**
 * A hex peer id paired with its numeric ring position (nodeId).
 * @typedef {{id: string, nid: bigint}} RingNode
 */

/**
 * The result of one distributed findSuccessor hop (see {@link findSuccessorStep}).
 * `done` true means `successor` is the answer; otherwise forward the lookup to `next`.
 * @typedef {{done: boolean, successor?: (string|null), next?: string}} FindSuccessorStepResult
 */

/**
 * Size of the identifier ring: 2^64. All nodeId math is mod this value.
 * @type {bigint}
 */
const RING = 1n << 64n; // 2^64

/**
 * nodeId = top 8 bytes of the key as an unsigned 64-bit integer (big-endian).
 * @param {Buffer} key - the raw peer key buffer.
 * @returns {bigint} the node's keyspace position (mod 2^64).
 */
function nodeId(key) {
  let nid = 0n;
  for (let i = 0; i < 8; i++) {
    nid = (nid << 8n) | BigInt(key[i]);
  }
  return nid;
}

/**
 * nodeId of a hex-encoded peer key.
 * @param {string} hex - the peer id as a hex string.
 * @returns {bigint} the node's keyspace position (mod 2^64).
 */
function nodeIdOfHex(hex) {
  return nodeId(b4a.from(hex, 'hex'));
}

/**
 * Ascending BigInt comparator (BigInts can't use plain subtraction into a Number sort key).
 * @param {RingNode} a - first ring node.
 * @param {RingNode} b - second ring node.
 * @returns {number} -1, 0, or 1 ordering `a` before/equal/after `b` by nodeId.
 */
function byNid(a, b) {
  if (a.nid < b.nid) {
    return -1;
  }
  if (a.nid > b.nid) {
    return 1;
  }
  return 0;
}

/**
 * Order a set of hex ids clockwise by nodeId (ascending, mod 2^64). Dedupes.
 * @param {string[]} ids - hex peer ids (may contain duplicates).
 * @returns {RingNode[]} the deduped ids sorted ascending by nodeId.
 */
function ringOrder(ids) {
  return [...new Set(ids)]
    .map((id) => ({ id, nid: nodeIdOfHex(id) }))
    .sort(byNid);
}

/**
 * The next up-to-k ids clockwise from me (the successor-list, §4.3). Wraps around
 * the ring; never includes me, and caps at the number of other nodes so a small
 * ring doesn't wrap back onto myself.
 * @param {string[]} ids - the other known hex peer ids.
 * @param {string} myId - my hex peer id.
 * @param {number} [k=3] - the maximum number of successors to return.
 * @returns {string[]} up to k successor ids clockwise from me.
 */
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

/**
 * The single id immediately counter-clockwise from me (the predecessor, §4.3),
 * wrapping to the highest nodeId. null if I'm the only node.
 * @param {string[]} ids - the other known hex peer ids.
 * @param {string} myId - my hex peer id.
 * @returns {(string|null)} the predecessor's hex id, or null if I'm alone.
 */
function predecessor(ids, myId) {
  const ring = ringOrder([myId, ...ids]);
  const ringSize = ring.length;
  if (ringSize <= 1) {
    return null;
  }
  const myIndex = ring.findIndex((node) => node.id === myId);
  return ring[(myIndex - 1 + ringSize) % ringSize].id;
}

/**
 * The set of ids whose ring edges we want physically connected (Phase 2):
 * my successor-list plus my predecessor. This is what wave.js joinPeer()s.
 * @param {string[]} ids - the other known hex peer ids.
 * @param {string} myId - my hex peer id.
 * @param {number} [k=3] - the successor-list size.
 * @returns {Set<string>} the ids to physically connect to.
 */
function connectionTargets(ids, myId, k = 3) {
  const set = new Set(successors(ids, myId, k));
  const pred = predecessor(ids, myId);
  if (pred) {
    set.add(pred);
  }
  return set;
}

/**
 * Chord's findSuccessor over a pre-ordered ring (§4.5): the first node at-or-
 * clockwise-after keyspace position `target` (mod 2^64), wrapping to the
 * lowest nodeId. `ring` is the output of ringOrder (ascending by nid).
 * @param {RingNode[]} ring - nodes ordered ascending by nodeId (from ringOrder).
 * @param {bigint} target - the keyspace position to locate the successor of.
 * @returns {(RingNode|null)} the successor node, or null if the ring is empty.
 */
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

/**
 * Public findSuccessor: the id of the first node clockwise from keyspace position
 * `target`. Used to build the finger table; also the lookup primitive for placing
 * where a token starts / where a joining node inserts (§4.5).
 * @param {string[]} ids - the known hex peer ids to search.
 * @param {bigint} target - the keyspace position to locate the successor of.
 * @returns {(string|null)} the successor's hex id, or null if no ids.
 */
function findSuccessor(ids, target) {
  const node = successorOf(ringOrder(ids), target);
  return node ? node.id : null;
}

/**
 * Chord finger table (§4.3): finger[i] = successor of (myNid + 2^i) mod 2^64, for
 * i in 0..63. Returns the DISTINCT finger node ids (excluding me). For a ring of N
 * nodes the distinct fingers collapse to O(log N) — the whole point: deliberate
 * connections stay logarithmic instead of a full mesh, while still spanning the ring.
 * @param {string[]} ids - the other known hex peer ids.
 * @param {string} myId - my hex peer id.
 * @returns {Set<string>} the distinct finger node ids (excluding me).
 */
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

/**
 * Is nodeId `x` strictly inside the open ring interval (a, b), moving clockwise
 * (mod 2^64)? When a >= b the interval wraps past the top of the ring.
 * @param {bigint} x - the nodeId to test.
 * @param {bigint} a - the exclusive lower bound of the interval.
 * @param {bigint} b - the exclusive upper bound of the interval.
 * @returns {boolean} true if x ∈ (a, b) clockwise.
 */
function inOpenInterval(x, a, b) {
  if (a < b) {
    return x > a && x < b;
  }
  return x > a || x < b;
}

/**
 * Clockwise ring distance from a to b (mod 2^64).
 * @param {bigint} a - the starting nodeId.
 * @param {bigint} b - the target nodeId.
 * @returns {bigint} the clockwise distance (b - a) mod 2^64.
 */
function ringForward(a, b) {
  return (b - a + RING) % RING;
}

/**
 * One Chord stabilize step (§4.4): my successor's predecessor `succPredId` becomes my
 * successor if it sits strictly between me and my current successor — that means a
 * node joined (or was discovered) between us.
 * @param {string} myId - my hex peer id.
 * @param {(string|null)} currentSuccId - my current successor's hex id, or null if none.
 * @param {(string|null)} succPredId - my successor's reported predecessor hex id, or null.
 * @returns {(string|null)} the id to use as successor (`succPredId` if closer, else the unchanged current).
 */
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

// How many far fingers to pin. The sweep's control plane only needs a CONNECTED flood
// graph with small diameter, not Chord-precise routing — and the near fingers mostly
// duplicate the successor-list anyway. A few long edges (~half-ring, ~quarter-ring,
// ~eighth-ring) give near-logarithmic flood diameter at a constant pin budget
// (small-world), instead of the full O(log N) finger table.
const FAR_FINGERS = 3;

/**
 * The farthest `cap` distinct fingers — the long-range edges. Fingers are ordered by
 * clockwise ring distance from me (descending) and the top `cap` kept.
 * @param {string[]} ids - the other known hex peer ids.
 * @param {string} myId - my hex peer id.
 * @param {number} [cap=FAR_FINGERS] - how many far fingers to keep.
 * @returns {Set<string>} the capped far-finger ids.
 */
function farFingers(ids, myId, cap = FAR_FINGERS) {
  const myNid = nodeIdOfHex(myId);
  const byDistanceDesc = [...fingers(ids, myId)].sort((a, b) => {
    const distA = ringForward(myNid, nodeIdOfHex(a));
    const distB = ringForward(myNid, nodeIdOfHex(b));
    if (distA === distB) {
      return a < b ? -1 : 1;
    }
    return distA > distB ? -1 : 1;
  });
  return new Set(byDistanceDesc.slice(0, cap));
}

/**
 * The full set of peers to keep physically connected: successor-list + predecessor
 * (local ring integrity / fault tolerance) unioned with the capped FAR fingers (the
 * long-range edges that keep the flood diameter small). This is what wave.js
 * joinPeer()s — a constant pin budget (~k + 1 + FAR_FINGERS).
 * @param {string[]} ids - the other known hex peer ids.
 * @param {string} myId - my hex peer id.
 * @param {number} [k=3] - the successor-list size.
 * @returns {Set<string>} the full set of hex ids to physically connect to.
 */
function pinTargets(ids, myId, k = 3) {
  const set = connectionTargets(ids, myId, k);
  for (const finger of farFingers(ids, myId)) {
    set.add(finger);
  }
  return set;
}

module.exports = {
  RING,
  FAR_FINGERS,
  nodeId,
  nodeIdOfHex,
  ringOrder,
  successors,
  predecessor,
  connectionTargets,
  findSuccessor,
  fingers,
  farFingers,
  pinTargets,
  inOpenInterval,
  stabilizeStep,
  ringForward
};
