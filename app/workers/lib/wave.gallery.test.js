// buildGallery ordering/dedup. Runs under Bare:
//   bare workers/lib/wave.gallery.test.js   (or `npm test`)
const test = require('brittle')
const { buildGallery } = require('./gallery')

const e = (waveId, peerId, hopCount, timestamp) => ({
  type: 'wave-selfie',
  waveId,
  peerId,
  hopCount,
  timestamp
})

test('orders selfies by hop count', (t) => {
  const g = buildGallery([e('w', 'c', 2, 10), e('w', 'a', 0, 10), e('w', 'b', 1, 10)])
  t.alike(
    g.map((x) => x.peerId),
    ['a', 'b', 'c']
  )
})

test('newest entry wins per (wave, peer)', (t) => {
  const g = buildGallery([e('w', 'a', 1, 10), e('w', 'a', 1, 50)])
  t.is(g.length, 1)
  t.is(g[0].timestamp, 50)
})

test('keeps entries from different waves separate', (t) => {
  t.is(buildGallery([e('w1', 'a', 0, 10), e('w2', 'a', 0, 10)]).length, 2)
})

test('ties on hop broken by timestamp', (t) => {
  const g = buildGallery([e('w', 'b', 1, 99), e('w', 'a', 1, 5)])
  t.alike(
    g.map((x) => x.peerId),
    ['a', 'b']
  )
})

test('empty input -> empty gallery', (t) => {
  t.alike(buildGallery([]), [])
})
