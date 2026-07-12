// Pure ring geometry. The DHT keyspace is the stadium; a peer's key is its seat
// (docs/protocol.md §2.1). No state, no I/O — unit-tested in wave.logic.test.js.
const b4a = require('b4a');

/**
 * A live peer occupying a seat on the ring.
 * @typedef {{id: string, angle: number, lastSeen: number}} RingPeer
 */

/**
 * Ring position: top 6 bytes of the key mapped onto [0, 360).
 * @param {Buffer} key - The peer's Noise public key (raw bytes).
 * @returns {number} The seat angle in degrees, in [0, 360).
 */
function angleOf(key) {
  let topBytes = 0;
  for (let i = 0; i < 6; i++) {
    topBytes = topBytes * 256 + key[i];
  }
  return (topBytes / 2 ** 48) * 360;
}

/**
 * Same as angleOf, from a hex peer id. Angle is always DERIVED from identity,
 * never trusted from the wire — your key is your seat.
 * @param {string} hex - The peer id as a hex string.
 * @returns {number} The seat angle in degrees, in [0, 360).
 */
function angleOfId(hex) {
  return angleOf(b4a.from(hex, 'hex'));
}

/**
 * Live peers, sorted clockwise by angle (a peer is live if its last heartbeat is
 * newer than staleMs).
 * @param {RingPeer[]} entries - All known ring entries.
 * @param {number} now - Current timestamp (ms).
 * @param {number} staleMs - Liveness window in ms; peers not seen within it are dropped.
 * @returns {RingPeer[]} The live peers sorted clockwise by angle.
 */
function liveRing(entries, now, staleMs) {
  return entries
    .filter((peer) => now - peer.lastSeen < staleMs)
    .sort((a, b) => a.angle - b.angle);
}

/**
 * Next peer clockwise from myAngle (smallest angle > mine), wrapping to the first.
 * @param {number} myAngle - My own seat angle in degrees.
 * @param {RingPeer[]} sortedRing - Live peers already sorted clockwise by angle.
 * @returns {RingPeer | null} The successor peer, or null if the ring is empty.
 */
function nextClockwise(myAngle, sortedRing) {
  if (sortedRing.length === 0) {
    return null;
  }
  for (const peer of sortedRing) {
    if (peer.angle > myAngle) {
      return peer;
    }
  }
  return sortedRing[0];
}

module.exports = { angleOf, angleOfId, liveRing, nextClockwise };
