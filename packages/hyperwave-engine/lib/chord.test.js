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
  findSuccessor,
  fingers,
  pinTargets,
  inOpenInterval,
  stabilizeStep,
  inHalfOpenInterval,
  closestPrecedingNode,
  findSuccessorStep,
  RING
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

test('findSuccessor returns the first node at or clockwise-after a target', (t) => {
  const ids = [makeId(10), makeId(20), makeId(30), makeId(40)];
  t.is(findSuccessor(ids, 15n), makeId(20), 'strictly after');
  t.is(findSuccessor(ids, 20n), makeId(20), 'exact match counts');
  t.is(findSuccessor(ids, 5n), makeId(10), 'before all -> lowest');
  t.is(findSuccessor(ids, 45n), makeId(10), 'past the top wraps to lowest');
  t.is(findSuccessor([], 1n), null, 'empty set -> null');
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

test('pinTargets unions successor-list, predecessor, and fingers', (t) => {
  const ids = [makeId(1), makeId(2), makeId(4), makeId(8)];
  const targets = pinTargets(ids, makeId(0), 2);
  // successors {1,2}, predecessor {8} (highest wraps to me's predecessor), fingers {1,2,4,8}
  t.alike(
    [...targets].sort(),
    [makeId(1), makeId(2), makeId(4), makeId(8)].sort()
  );
});

test('inOpenInterval handles the normal and wrapping cases', (t) => {
  t.ok(inOpenInterval(20n, 10n, 40n), 'inside');
  t.absent(inOpenInterval(50n, 10n, 40n), 'outside');
  t.absent(inOpenInterval(10n, 10n, 40n), 'open at the low end');
  t.absent(inOpenInterval(40n, 10n, 40n), 'open at the high end');
  t.ok(inOpenInterval(50n, 40n, 10n), 'wraps: 50 in (40,10)');
  t.ok(inOpenInterval(5n, 40n, 10n), 'wraps: 5 in (40,10)');
  t.absent(inOpenInterval(20n, 40n, 10n), 'wraps: 20 not in (40,10)');
});

test('stabilizeStep adopts a successor discovered between me and my successor', (t) => {
  t.is(
    stabilizeStep(makeId(10), makeId(40), makeId(20)),
    makeId(20),
    'succ.pred 20 is closer -> adopt'
  );
  t.is(
    stabilizeStep(makeId(10), makeId(40), makeId(50)),
    makeId(40),
    'succ.pred 50 is outside -> keep'
  );
  t.is(
    stabilizeStep(makeId(10), makeId(40), null),
    makeId(40),
    'no succ.pred -> keep'
  );
  t.is(
    stabilizeStep(makeId(10), makeId(40), makeId(10)),
    makeId(40),
    "succ.pred is me -> keep (I'm its pred)"
  );
  t.is(
    stabilizeStep(makeId(10), null, makeId(20)),
    makeId(20),
    'no current successor -> take it'
  );
});

// --- distributed findSuccessor routing (§4.5) -------------------------------

test('inHalfOpenInterval includes the upper end and wraps', (t) => {
  t.ok(inHalfOpenInterval(40n, 10n, 40n), 'includes b');
  t.absent(inHalfOpenInterval(10n, 10n, 40n), 'excludes a');
  t.ok(inHalfOpenInterval(20n, 10n, 40n), 'inside');
  t.ok(inHalfOpenInterval(5n, 40n, 10n), 'wraps: 5 in (40,10]');
  t.ok(inHalfOpenInterval(99n, 7n, 7n), 'a===b is the whole ring');
});

test('closestPrecedingNode picks the highest known id below the target', (t) => {
  t.is(
    closestPrecedingNode([makeId(10), makeId(20), makeId(30)], makeId(0), 35n),
    makeId(30)
  );
  t.is(
    closestPrecedingNode([makeId(10), makeId(20), makeId(30)], makeId(0), 25n),
    makeId(20)
  );
  t.is(
    closestPrecedingNode([makeId(10)], makeId(0), 5n),
    null,
    'nothing precedes the target'
  );
});

test('findSuccessorStep resolves locally in (me, successor], else forwards', (t) => {
  const at = {
    me: makeId(10),
    successor: makeId(20),
    known: [makeId(20), makeId(40), makeId(80)]
  };
  t.alike(findSuccessorStep({ ...at, target: 15n }), {
    done: true,
    successor: makeId(20)
  });
  t.alike(
    findSuccessorStep({ ...at, target: 20n }),
    { done: true, successor: makeId(20) },
    'inclusive'
  );
  t.alike(
    findSuccessorStep({ ...at, target: 50n }),
    { done: false, next: makeId(40) },
    'jump to 40'
  );
});

// Simulated Chord network: N nodes, each knowing ONLY its finger table + successor (not
// the whole ring). Walk a lookup hop-to-hop using each node's local knowledge and assert
// it still resolves to the globally-correct successor — this is the convergence-under-
// partial-knowledge property that a local findSuccessor can't guarantee.
function makeIdFromNid(nid) {
  return nid.toString(16).padStart(16, '0') + '0'.repeat(48);
}
function chordIds(count) {
  const ids = [];
  let nid = 0n;
  for (let i = 0; i < count; i++) {
    nid = (nid + 0x9e3779b97f4a7c15n) % RING; // Fibonacci hashing spreads ids across the ring
    ids.push(makeIdFromNid(nid));
  }
  return ids;
}
function buildNet(ids, withFingers = true) {
  const net = new Map();
  for (const id of ids) {
    const succ = successors(ids, id, 1)[0];
    const known = withFingers ? [...fingers(ids, id)] : [];
    if (succ && !known.includes(succ)) {
      known.push(succ);
    }
    net.set(id, { successor: succ, known });
  }
  return net;
}
function route(net, origin, target) {
  let at = origin;
  let hops = 0;
  while (hops <= 1000) {
    const node = net.get(at);
    const step = findSuccessorStep({
      me: at,
      successor: node.successor,
      known: node.known,
      target
    });
    if (step.done) {
      return { successor: step.successor, hops };
    }
    at = step.next;
    hops++;
  }
  throw new Error('routing did not converge');
}
function spreadTargets(count) {
  const out = [];
  let nid = 12345n;
  for (let i = 0; i < count; i++) {
    nid = (nid + 0x9e3779b97f4a7c15n) % RING;
    out.push(nid);
  }
  return out;
}

test('distributed findSuccessor resolves correctly in O(log N) hops (partial knowledge)', (t) => {
  const ids = chordIds(64);
  const net = buildNet(ids, true);
  const targets = spreadTargets(40);
  let maxHops = 0;
  for (let originIdx = 0; originIdx < ids.length; originIdx += 5) {
    for (const target of targets) {
      const got = route(net, ids[originIdx], target);
      t.is(
        got.successor,
        findSuccessor(ids, target),
        'matches the global truth'
      );
      if (got.hops > maxHops) {
        maxHops = got.hops;
      }
    }
  }
  t.ok(maxHops >= 2, `actually multi-hops (max ${maxHops})`);
  t.ok(maxHops <= 12, `converges in <= 2·log2(64) = 12 hops (max ${maxHops})`);
});

test('routing stays correct with successor pointers only (degrades, never wrong)', (t) => {
  const ids = chordIds(30);
  const net = buildNet(ids, false); // no fingers — successor only => linear walk
  for (let originIdx = 0; originIdx < ids.length; originIdx += 4) {
    for (const target of spreadTargets(6)) {
      t.is(
        route(net, ids[originIdx], target).successor,
        findSuccessor(ids, target)
      );
    }
  }
});
