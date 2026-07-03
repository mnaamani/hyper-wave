// Chord pointer math: nodeId, successor-list, predecessor, connection targets.
// Pure — no swarm. Runs under Bare:  bare workers/lib/chord.test.js  (or `npm test`)
const test = require('brittle')
const b4a = require('b4a')
const {
  nodeId,
  nodeIdOfHex,
  ringOrder,
  successors,
  predecessor,
  connectionTargets,
  findSuccessor,
  fingers,
  pinTargets
} = require('./chord')

// A 32-byte peer id (64 hex chars) whose top-8-byte nodeId is exactly `n`.
function mk(n) {
  return BigInt(n).toString(16).padStart(16, '0') + '0'.repeat(48)
}

test('nodeId reads the top 8 bytes as a big-endian u64', (t) => {
  t.is(nodeId(b4a.alloc(32)), 0n)
  t.is(nodeId(b4a.alloc(32).fill(0xff)), (1n << 64n) - 1n, 'all-0xff = 2^64-1')
  t.is(nodeIdOfHex(mk(42)), 42n)
})

test('ringOrder sorts ids clockwise by nodeId and dedupes', (t) => {
  const ring = ringOrder([mk(30), mk(10), mk(30), mk(20)])
  t.alike(
    ring.map((x) => x.nid),
    [10n, 20n, 30n],
    'ascending, deduped'
  )
})

test('successors returns the next k ids clockwise', (t) => {
  const ids = [mk(10), mk(20), mk(30), mk(40)]
  t.alike(successors(ids, mk(20), 2), [mk(30), mk(40)])
})

test('successors wraps around the top of the ring', (t) => {
  const ids = [mk(10), mk(20), mk(30), mk(40)]
  t.alike(successors(ids, mk(40), 2), [mk(10), mk(20)])
})

test('successors never wraps back onto me on a small ring', (t) => {
  // me + 2 others, k=3 -> only the 2 others (no self-inclusion)
  t.alike(successors([mk(20), mk(30)], mk(10), 3), [mk(20), mk(30)])
})

test('successors is empty when I am the only node', (t) => {
  t.alike(successors([], mk(10), 3), [])
})

test('predecessor is the id immediately counter-clockwise, wrapping', (t) => {
  const ids = [mk(10), mk(20), mk(30), mk(40)]
  t.is(predecessor(ids, mk(20)), mk(10))
  t.is(predecessor(ids, mk(10)), mk(40), 'lowest wraps to highest')
})

test('predecessor is null when I am the only node', (t) => {
  t.is(predecessor([], mk(10)), null)
})

test('connectionTargets is the successor-list unioned with the predecessor', (t) => {
  const ids = [mk(10), mk(20), mk(30), mk(40), mk(50)]
  const targets = connectionTargets(ids, mk(30), 2)
  t.alike([...targets].sort(), [mk(20), mk(40), mk(50)].sort(), 'succ {40,50} + pred {20}')
})

test('findSuccessor returns the first node at or clockwise-after a target', (t) => {
  const ids = [mk(10), mk(20), mk(30), mk(40)]
  t.is(findSuccessor(ids, 15n), mk(20), 'strictly after')
  t.is(findSuccessor(ids, 20n), mk(20), 'exact match counts')
  t.is(findSuccessor(ids, 5n), mk(10), 'before all -> lowest')
  t.is(findSuccessor(ids, 45n), mk(10), 'past the top wraps to lowest')
  t.is(findSuccessor([], 1n), null, 'empty set -> null')
})

test('fingers resolves finger[i] = successor(myNid + 2^i)', (t) => {
  // me at 0, nodes sitting exactly on the low powers of two
  const f = fingers([mk(1), mk(2), mk(4)], mk(0))
  t.alike(
    [...f].sort(),
    [mk(1), mk(2), mk(4)].sort(),
    'finger[0..2] land on 1,2,4; higher wrap to me (excluded)'
  )
})

test('fingers dedupes to O(log N) distinct nodes', (t) => {
  // one far node: every 2^i <= 100 resolves to it; larger targets wrap back to me
  const f = fingers([mk(100)], mk(0))
  t.alike([...f], [mk(100)], '64 finger targets collapse to a single distinct node')
})

test('pinTargets unions successor-list, predecessor, and fingers', (t) => {
  const ids = [mk(1), mk(2), mk(4), mk(8)]
  const targets = pinTargets(ids, mk(0), 2)
  // successors {1,2}, predecessor {8} (highest wraps to me's predecessor), fingers {1,2,4,8}
  t.alike([...targets].sort(), [mk(1), mk(2), mk(4), mk(8)].sort())
})
