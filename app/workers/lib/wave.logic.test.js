// Deterministic unit tests for the pure ring logic. Runs under Bare (the worker's
// real runtime):  bare workers/lib/wave.logic.test.js
const assert = require('bare-assert')
const deepEq = (a, b, msg) => assert.ok(JSON.stringify(a) === JSON.stringify(b), msg || JSON.stringify(a) + ' !== ' + JSON.stringify(b))
const b4a = require('b4a')
const { angleOf, liveRing, nextClockwise } = require('./wave.js')

let n = 0
const test = (name, fn) => {
  fn()
  console.log('ok -', name)
  n++
}

test('angleOf maps a key into [0,360)', () => {
  const zero = angleOf(b4a.alloc(8))
  assert.strictEqual(zero, 0)
  const high = angleOf(b4a.alloc(8).fill(0xff))
  assert.ok(high >= 0 && high < 360, 'in range')
  assert.ok(high > 359, 'all-0xff near 360')
})

test('liveRing drops stale peers and sorts clockwise', () => {
  const now = 100000
  const entries = [
    { id: 'a', angle: 300, lastSeen: now - 1000 },
    { id: 'b', angle: 10, lastSeen: now - 1000 },
    { id: 'c', angle: 150, lastSeen: now - 99999 } // stale
  ]
  const ring = liveRing(entries, now, 12000)
  deepEq(ring.map((p) => p.id), ['b', 'a'], 'c pruned, sorted by angle')
})

test('nextClockwise picks smallest angle greater than mine', () => {
  const ring = [
    { id: 'b', angle: 10 },
    { id: 'a', angle: 300 }
  ]
  assert.strictEqual(nextClockwise(150, ring).id, 'a')
  assert.strictEqual(nextClockwise(5, ring).id, 'b')
})

test('nextClockwise wraps around past the top of the ring', () => {
  const ring = [
    { id: 'b', angle: 10 },
    { id: 'a', angle: 300 }
  ]
  assert.strictEqual(nextClockwise(350, ring).id, 'b')
})

test('nextClockwise returns null on an empty ring', () => {
  assert.strictEqual(nextClockwise(42, []), null)
})

test('single-peer ring: successor is always that peer (even if behind me)', () => {
  const ring = [{ id: 'only', angle: 5 }]
  assert.strictEqual(nextClockwise(200, ring).id, 'only')
})

console.log(`\n${n} passed`)
