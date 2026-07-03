// Ring geometry: successor, liveness, and healing selection. Runs under Bare:
//   bare workers/lib/wave.logic.test.js   (or `npm test`)
const test = require('brittle')
const b4a = require('b4a')
const { angleOf, liveRing, nextClockwise, hopsUntilMe, pickReachable } = require('./ring')

test('angleOf maps a key into [0,360)', (t) => {
  t.is(angleOf(b4a.alloc(8)), 0)
  const high = angleOf(b4a.alloc(8).fill(0xff))
  t.ok(high >= 0 && high < 360, 'in range')
  t.ok(high > 359, 'all-0xff near 360')
})

test('liveRing drops stale peers and sorts clockwise', (t) => {
  const now = 100000
  const entries = [
    { id: 'a', angle: 300, lastSeen: now - 1000 },
    { id: 'b', angle: 10, lastSeen: now - 1000 },
    { id: 'c', angle: 150, lastSeen: now - 99999 } // stale
  ]
  const ring = liveRing(entries, now, 12000)
  t.alike(
    ring.map((p) => p.id),
    ['b', 'a'],
    'c pruned, sorted by angle'
  )
})

test('nextClockwise picks smallest angle greater than mine', (t) => {
  const ring = [
    { id: 'b', angle: 10 },
    { id: 'a', angle: 300 }
  ]
  t.is(nextClockwise(150, ring).id, 'a')
  t.is(nextClockwise(5, ring).id, 'b')
})

test('nextClockwise wraps around past the top of the ring', (t) => {
  const ring = [
    { id: 'b', angle: 10 },
    { id: 'a', angle: 300 }
  ]
  t.is(nextClockwise(350, ring).id, 'b')
})

test('nextClockwise returns null on an empty ring', (t) => {
  t.is(nextClockwise(42, []), null)
})

test('hopsUntilMe counts seats clockwise from the holder to me', (t) => {
  // others b@10, c@150, a@300 with me@200 -> ring: b, c, me, a
  const others = [
    { id: 'b', angle: 10 },
    { id: 'c', angle: 150 },
    { id: 'a', angle: 300 }
  ]
  t.is(hopsUntilMe(others, 'me', 200, 'c'), 1, 'c is my immediate predecessor')
  t.is(hopsUntilMe(others, 'me', 200, 'b'), 2, 'b is two hops back')
  t.is(hopsUntilMe(others, 'me', 200, 'a'), 3, 'a wraps: a -> b -> c -> me')
})

test('hopsUntilMe returns 0 for myself or an unknown seat', (t) => {
  const others = [{ id: 'b', angle: 10 }]
  t.is(hopsUntilMe(others, 'me', 200, 'me'), 0)
  t.is(hopsUntilMe(others, 'me', 200, 'ghost'), 0)
})

test('single-peer ring: successor is always that peer (even if behind me)', (t) => {
  t.is(nextClockwise(200, [{ id: 'only', angle: 5 }]).id, 'only')
})

// healing: pickReachable = next clockwise that is reachable and not skipped
const R = [
  { id: 'b', angle: 10 },
  { id: 'c', angle: 150 },
  { id: 'a', angle: 300 }
]
const all = new Set(['a', 'b', 'c'])

test('pickReachable picks the next clockwise when all reachable', (t) => {
  t.is(pickReachable(R, 100, all, new Set()).id, 'c') // 100 -> c@150
  t.is(pickReachable(R, 200, all, new Set()).id, 'a') // 200 -> a@300
})

test('pickReachable wraps around', (t) => {
  t.is(pickReachable(R, 320, all, new Set()).id, 'b') // past a -> wrap to b
})

test('pickReachable skips a skipped (dead) successor to the next live one', (t) => {
  t.is(pickReachable(R, 100, all, new Set(['c'])).id, 'a')
})

test('pickReachable skips peers we have no connection to (not reachable)', (t) => {
  t.is(pickReachable(R, 100, new Set(['a', 'b']), new Set()).id, 'a') // c unreachable
})

test('pickReachable returns null when nobody qualifies', (t) => {
  t.is(pickReachable(R, 0, new Set(), new Set()), null) // none reachable
  t.is(pickReachable(R, 0, all, new Set(['a', 'b', 'c'])), null) // all skipped
})
