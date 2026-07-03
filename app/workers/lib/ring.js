// Pure ring geometry. The DHT keyspace is the stadium; a peer's key is its seat
// (final-idea.md §2.1). No state, no I/O — unit-tested in wave.logic.test.js.
const b4a = require('b4a')

// Ring position: top 6 bytes of the key mapped onto [0, 360).
function angleOf(key) {
  let n = 0
  for (let i = 0; i < 6; i++) n = n * 256 + key[i]
  return (n / 2 ** 48) * 360
}

// Same, from a hex peer id. Angle is always DERIVED from identity, never trusted
// from the wire — your key is your seat.
function angleOfId(hex) {
  return angleOf(b4a.from(hex, 'hex'))
}

// live peers, sorted clockwise by angle
function liveRing(entries, now, ttl) {
  return entries.filter((p) => now - p.lastSeen < ttl).sort((a, b) => a.angle - b.angle)
}

// next peer clockwise from myAngle (smallest angle > mine), wrapping to the first
function nextClockwise(myAngle, sortedRing) {
  if (sortedRing.length === 0) return null
  for (const p of sortedRing) if (p.angle > myAngle) return p
  return sortedRing[0]
}

// How many seats clockwise the ball travels from `fromId` to reach me. The ring is all
// OTHER seats (`others`, sorted by angle) plus me at `myAngle`; 1 = `fromId` is my
// immediate predecessor, 2 = one before that, etc. Returns 0 if `fromId` isn't a seat.
// Used to pre-arm my proof window a few hops before the ball reaches me.
function hopsUntilMe(others, myId, myAngle, fromId) {
  const full = [...others, { id: myId, angle: myAngle }].sort((a, b) => a.angle - b.angle)
  const n = full.length
  const meIdx = full.findIndex((p) => p.id === myId)
  const fromIdx = full.findIndex((p) => p.id === fromId)
  if (fromIdx < 0 || fromIdx === meIdx) return 0
  return (meIdx - fromIdx + n) % n
}

// Healing: the next peer clockwise that is directly reachable and not already
// skipped. Walks the ring from just after me, wrapping around. `reachable` and
// `skipped` are Sets of peer ids. Returns null if none qualifies.
function pickReachable(sortedRing, myAngle, reachable, skipped) {
  const after = sortedRing.filter((p) => p.angle > myAngle)
  const before = sortedRing.filter((p) => p.angle <= myAngle)
  for (const p of [...after, ...before]) {
    if (!skipped.has(p.id) && reachable.has(p.id)) return p
  }
  return null
}

module.exports = { angleOf, angleOfId, liveRing, nextClockwise, hopsUntilMe, pickReachable }
