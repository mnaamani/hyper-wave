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

// Regression guard for the zero-dwell race (HOP_DELAY_MS = 0): the token races at network
// speed, so selfies can be appended in a burst whose arrival order — and here whose timestamps
// too — is the reverse of ring/hop order. Gallery order must still be strictly by hopCount, so
// the renderer replay features participants in ring order regardless of how they arrived.
test('hop order wins even when insertion and timestamp order are both inverted', (t) => {
  // fed last-hop-first, and later hops carry LARGER timestamps (arrived sooner in the burst)
  const g = buildGallery([
    e('w', 'd', 3, 400),
    e('w', 'c', 2, 300),
    e('w', 'b', 1, 200),
    e('w', 'a', 0, 100)
  ])
  t.alike(
    g.map((x) => x.peerId),
    ['a', 'b', 'c', 'd'],
    'ordered by hopCount, not by arrival/timestamp'
  )
})

test('empty input -> empty gallery', (t) => {
  t.alike(buildGallery([]), [])
})

test('preserves the wallet address (for gallery tipping)', (t) => {
  const entry = { ...e('w', 'a', 0, 10), address: 'TXYZ...ownerWallet' }
  t.is(buildGallery([entry])[0].address, 'TXYZ...ownerWallet', 'address rides through to the view')
})
