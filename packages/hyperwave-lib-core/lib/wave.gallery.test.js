// buildGallery ordering/dedup. Runs under Bare:
//   bare workers/lib/wave.gallery.test.js   (or `npm test`)
const test = require('brittle');
const { buildGallery } = require('./gallery');

const makeEntry = (waveId, peerId, hopCount, timestamp) => ({
  type: 'wave-selfie',
  waveId,
  peerId,
  hopCount,
  timestamp
});

test('orders selfies by hop count', (t) => {
  const gallery = buildGallery([
    makeEntry('w', 'c', 2, 10),
    makeEntry('w', 'a', 0, 10),
    makeEntry('w', 'b', 1, 10)
  ]);
  t.alike(
    gallery.map((item) => item.peerId),
    ['a', 'b', 'c']
  );
});

test('newest entry wins per (wave, peer)', (t) => {
  const gallery = buildGallery([makeEntry('w', 'a', 1, 10), makeEntry('w', 'a', 1, 50)]);
  t.is(gallery.length, 1);
  t.is(gallery[0].timestamp, 50);
});

test('keeps entries from different waves separate', (t) => {
  t.is(buildGallery([makeEntry('w1', 'a', 0, 10), makeEntry('w2', 'a', 0, 10)]).length, 2);
});

test('ties on hop broken by timestamp', (t) => {
  const gallery = buildGallery([makeEntry('w', 'b', 1, 99), makeEntry('w', 'a', 1, 5)]);
  t.alike(
    gallery.map((item) => item.peerId),
    ['a', 'b']
  );
});

// Regression guard for the zero-dwell race: the token races at network
// speed, so selfies can be appended in a burst whose arrival order — and here whose timestamps
// too — is the reverse of ring/hop order. Gallery order must still be strictly by hopCount, so
// the renderer replay features participants in ring order regardless of how they arrived.
test('hop order wins even when insertion and timestamp order are both inverted', (t) => {
  // fed last-hop-first, and later hops carry LARGER timestamps (arrived sooner in the burst)
  const gallery = buildGallery([
    makeEntry('w', 'd', 3, 400),
    makeEntry('w', 'c', 2, 300),
    makeEntry('w', 'b', 1, 200),
    makeEntry('w', 'a', 0, 100)
  ]);
  t.alike(
    gallery.map((item) => item.peerId),
    ['a', 'b', 'c', 'd'],
    'ordered by hopCount, not by arrival/timestamp'
  );
});

test('empty input -> empty gallery', (t) => {
  t.alike(buildGallery([]), []);
});

test('preserves the wallet address (for gallery tipping)', (t) => {
  const entry = { ...makeEntry('w', 'a', 0, 10), address: 'TXYZ...ownerWallet' };
  t.is(buildGallery([entry])[0].address, 'TXYZ...ownerWallet', 'address rides through to the view');
});
