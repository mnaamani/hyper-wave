// Ring geometry: seat angles + liveness. Runs under Bare:
//   bare lib/wave.logic.test.js   (or `npm test`)
const test = require('brittle');
const b4a = require('b4a');
const { angleOf, angleOfId, liveRing } = require('./ring');

test('angleOf maps a key into [0,360)', (t) => {
  t.is(angleOf(b4a.alloc(8)), 0);
  const high = angleOf(b4a.alloc(8).fill(0xff));
  t.ok(high >= 0 && high < 360, 'in range');
  t.ok(high > 359, 'all-0xff near 360');
});

test('angleOfId matches angleOf over the hex form of the same key', (t) => {
  const key = b4a.from('a1b2c3d4e5f60708', 'hex');
  t.is(angleOfId(b4a.toString(key, 'hex')), angleOf(key));
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
