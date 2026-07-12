// Ring geometry: successor, liveness, and healing selection. Runs under Bare:
//   bare workers/lib/wave.logic.test.js   (or `npm test`)
const test = require('brittle');
const b4a = require('b4a');
const { angleOf, liveRing, nextClockwise } = require('./ring');

test('angleOf maps a key into [0,360)', (t) => {
  t.is(angleOf(b4a.alloc(8)), 0);
  const high = angleOf(b4a.alloc(8).fill(0xff));
  t.ok(high >= 0 && high < 360, 'in range');
  t.ok(high > 359, 'all-0xff near 360');
});

test('liveRing drops stale peers and sorts clockwise', (t) => {
  const now = 100000;
  const entries = [
    { id: 'a', angle: 300, lastSeen: now - 1000 },
    { id: 'b', angle: 10, lastSeen: now - 1000 },
    { id: 'c', angle: 150, lastSeen: now - 99999 } // stale
  ];
  const ring = liveRing(entries, now, 12000);
  t.alike(
    ring.map((peer) => peer.id),
    ['b', 'a'],
    'c pruned, sorted by angle'
  );
});

test('nextClockwise picks smallest angle greater than mine', (t) => {
  const ring = [
    { id: 'b', angle: 10 },
    { id: 'a', angle: 300 }
  ];
  t.is(nextClockwise(150, ring).id, 'a');
  t.is(nextClockwise(5, ring).id, 'b');
});

test('nextClockwise wraps around past the top of the ring', (t) => {
  const ring = [
    { id: 'b', angle: 10 },
    { id: 'a', angle: 300 }
  ];
  t.is(nextClockwise(350, ring).id, 'b');
});

test('nextClockwise returns null on an empty ring', (t) => {
  t.is(nextClockwise(42, []), null);
});

test('single-peer ring: successor is always that peer (even if behind me)', (t) => {
  t.is(nextClockwise(200, [{ id: 'only', angle: 5 }]).id, 'only');
});
