// Deterministic tests for buildGallery (pure ordering/dedup). Runs under Bare:
//   bare workers/lib/wave.gallery.test.js
const assert = require('bare-assert')
const deepEq = (a, b, msg) => assert.ok(JSON.stringify(a) === JSON.stringify(b), msg || JSON.stringify(a) + ' !== ' + JSON.stringify(b))
const { buildGallery } = require('./gallery')

let n = 0
const test = (name, fn) => {
  fn()
  console.log('ok -', name)
  n++
}

const e = (waveId, peerId, hopCount, timestamp) => ({ type: 'wave-selfie', waveId, peerId, hopCount, timestamp })

test('orders selfies by hop count', () => {
  const g = buildGallery([e('w', 'c', 2, 10), e('w', 'a', 0, 10), e('w', 'b', 1, 10)])
  deepEq(g.map((x) => x.peerId), ['a', 'b', 'c'])
})

test('newest entry wins per (wave, peer)', () => {
  const g = buildGallery([e('w', 'a', 1, 10), e('w', 'a', 1, 50)])
  assert.strictEqual(g.length, 1)
  assert.strictEqual(g[0].timestamp, 50)
})

test('keeps entries from different waves separate', () => {
  const g = buildGallery([e('w1', 'a', 0, 10), e('w2', 'a', 0, 10)])
  assert.strictEqual(g.length, 2)
})

test('ties on hop broken by timestamp', () => {
  const g = buildGallery([e('w', 'b', 1, 99), e('w', 'a', 1, 5)])
  deepEq(g.map((x) => x.peerId), ['a', 'b'])
})

test('empty input -> empty gallery', () => {
  deepEq(buildGallery([]), [])
})

console.log(`\n${n} passed`)
