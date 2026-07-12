// Chord pointer math: nodeId, successor-list, predecessor, connection targets.
// Pure — no swarm. Runs under Bare:  bare workers/lib/chord.test.js  (or `npm test`)
const test = require('brittle');
const b4a = require('b4a');
const {
  nodeId,
  nodeIdOfHex,
  ringOrder,
  successors,
  predecessor,
  connectionTargets,
  fingers,
  farFingers,
  pinTargets
} = require('./chord');

// A 32-byte peer id (64 hex chars) whose top-8-byte nodeId is exactly `nid`.
function makeId(nid) {
  const hex = BigInt(nid).toString(16);
  return hex.padStart(16, '0') + '0'.repeat(48);
}

test('nodeId reads the top 8 bytes as a big-endian u64', (t) => {
  t.is(nodeId(b4a.alloc(32)), 0n);
  t.is(nodeId(b4a.alloc(32).fill(0xff)), (1n << 64n) - 1n, 'all-0xff = 2^64-1');
  t.is(nodeIdOfHex(makeId(42)), 42n);
});

test('ringOrder sorts ids clockwise by nodeId and dedupes', (t) => {
  const ring = ringOrder([makeId(30), makeId(10), makeId(30), makeId(20)]);
  t.alike(
    ring.map((node) => node.nid),
    [10n, 20n, 30n],
    'ascending, deduped'
  );
});

test('successors returns the next k ids clockwise', (t) => {
  const ids = [makeId(10), makeId(20), makeId(30), makeId(40)];
  t.alike(successors(ids, makeId(20), 2), [makeId(30), makeId(40)]);
});

test('successors wraps around the top of the ring', (t) => {
  const ids = [makeId(10), makeId(20), makeId(30), makeId(40)];
  t.alike(successors(ids, makeId(40), 2), [makeId(10), makeId(20)]);
});

test('successors never wraps back onto me on a small ring', (t) => {
  // me + 2 others, k=3 -> only the 2 others (no self-inclusion)
  t.alike(successors([makeId(20), makeId(30)], makeId(10), 3), [
    makeId(20),
    makeId(30)
  ]);
});

test('successors is empty when I am the only node', (t) => {
  t.alike(successors([], makeId(10), 3), []);
});

test('predecessor is the id immediately counter-clockwise, wrapping', (t) => {
  const ids = [makeId(10), makeId(20), makeId(30), makeId(40)];
  t.is(predecessor(ids, makeId(20)), makeId(10));
  t.is(predecessor(ids, makeId(10)), makeId(40), 'lowest wraps to highest');
});

test('predecessor is null when I am the only node', (t) => {
  t.is(predecessor([], makeId(10)), null);
});

test('connectionTargets is the successor-list unioned with the predecessor', (t) => {
  const ids = [makeId(10), makeId(20), makeId(30), makeId(40), makeId(50)];
  const targets = connectionTargets(ids, makeId(30), 2);
  t.alike(
    [...targets].sort(),
    [makeId(20), makeId(40), makeId(50)].sort(),
    'succ {40,50} + pred {20}'
  );
});

test('fingers resolves finger[i] = successor(myNid + 2^i)', (t) => {
  // me at 0, nodes sitting exactly on the low powers of two
  const fingerSet = fingers([makeId(1), makeId(2), makeId(4)], makeId(0));
  t.alike(
    [...fingerSet].sort(),
    [makeId(1), makeId(2), makeId(4)].sort(),
    'finger[0..2] land on 1,2,4; higher wrap to me (excluded)'
  );
});

test('fingers dedupes to O(log N) distinct nodes', (t) => {
  // one far node: every 2^i <= 100 resolves to it; larger targets wrap back to me
  const fingerSet = fingers([makeId(100)], makeId(0));
  t.alike(
    [...fingerSet],
    [makeId(100)],
    '64 finger targets collapse to a single distinct node'
  );
});

test('farFingers keeps only the farthest distinct fingers (long edges)', (t) => {
  // me at 0, nodes on the powers of two: distinct fingers {1,2,4,8,16,32};
  // the 3 FARTHEST (by clockwise distance) are 32, 16, 8.
  const ids = [1, 2, 4, 8, 16, 32].map(makeId);
  t.alike(
    [...farFingers(ids, makeId(0), 3)].sort(),
    [makeId(8), makeId(16), makeId(32)].sort(),
    'near fingers (duplicating the successor-list) are dropped'
  );
  t.alike(
    [...farFingers(ids, makeId(0), 99)].sort(),
    ids.sort(),
    'a generous cap keeps every distinct finger'
  );
});

test('pinTargets = successor-list ∪ predecessor ∪ capped far fingers', (t) => {
  // me at 0, nodes on the powers of two up to 32; k=2.
  const ids = [1, 2, 4, 8, 16, 32].map(makeId);
  const targets = pinTargets(ids, makeId(0), 2);
  // successors {1,2}; predecessor {32} (highest wraps around);
  // far fingers (cap 3, farthest first) {32,16,8} — near fingers 1,2,4 dropped.
  t.alike(
    [...targets].sort(),
    [makeId(1), makeId(2), makeId(8), makeId(16), makeId(32)].sort(),
    'constant pin budget: k + predecessor + far fingers'
  );
});
