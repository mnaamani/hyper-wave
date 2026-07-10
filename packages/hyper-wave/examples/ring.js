// ring.js — pure ring geometry: a key maps to a seat angle; the ring is the live
// peers sorted clockwise. No I/O. Run:  bare examples/ring.js
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const {
  angleOf,
  angleOfId,
  liveRing,
  nextClockwise,
  pickReachable
} = require('hyper-wave/lib/ring');

// A seat angle is DERIVED from the public key — never trusted from the wire.
const me = crypto.keyPair();
const myId = b4a.toString(me.publicKey, 'hex');
const myAngle = angleOf(me.publicKey); // 0..360
console.log('my seat:', myId.slice(0, 8), '@', myAngle.toFixed(2));
console.log('angleOfId matches angleOf:', angleOfId(myId) === myAngle);

// Build a live, clockwise-sorted ring from heartbeat entries { id, angle, lastSeen }.
const now = Date.now();
const STALE_MS = 30_000;
const entries = [
  { id: 'aa'.repeat(32), angle: 12.3, lastSeen: now },
  { id: 'cc'.repeat(32), angle: 200.0, lastSeen: now },
  { id: 'bb'.repeat(32), angle: 300.1, lastSeen: now - 60_000 } // stale → dropped
];
const live = liveRing(entries, now, STALE_MS);
console.log(
  'live ring angles:',
  live.map((peer) => peer.angle)
);

// The next seat clockwise from me (wraps to the first).
const successor = nextClockwise(myAngle, live);
console.log('my successor:', successor ? successor.angle : null);

// Healing: the next reachable seat clockwise that we haven't already skipped.
const reachable = new Set(live.map((peer) => peer.id));
const skipped = new Set([successor && successor.id]); // pretend the successor went silent
const alternate = pickReachable(live, myAngle, reachable, skipped);
console.log('healed successor (skipping the first):', alternate ? alternate.angle : null);
