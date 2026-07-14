// ring.js — pure ring geometry: a key maps to a seat angle; the ring is the live
// peers sorted clockwise. No I/O. Run:  bare examples/ring.js
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const {
  angleOf,
  angleOfId,
  liveRing,
  nextClockwise
} = require('hyperwave-engine/lib/ring');

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

// The next seat clockwise from me (wraps to the first). The seat/angle drives the sweep
// order + the gallery order; the sweep visits every roster member by angle, no routing.
const successor = nextClockwise(myAngle, live);
console.log('next clockwise seat:', successor ? successor.angle : null);
