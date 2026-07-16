// Verifies the vendored @hyperswarm/secret-stream security patch (scripts/patch-secret-stream.js,
// applied at postinstall) is present AND behaves: the transport rejects an oversized message AT the
// 3-byte length prefix, before it allocUnsafe's the (attacker-declared) body — closing the ~16 MB
// allocation vector (protocol.md §11.3). Doubles as a CI guard: if a secret-stream upgrade drops the
// patch, these fail loudly rather than the protection silently vanishing. Runs under Bare:
//   bare lib/secret-stream-patch.test.js   (or `npm test`)
const test = require('brittle');
const b4a = require('b4a');
const SecretStream = require('@hyperswarm/secret-stream');

// A secret-stream with no live raw stream (autoStart:false) — enough to drive the framing state
// machine directly. `_onrawdata` is the post-handshake data path; a fresh stream starts in the
// length-reading state, so feeding it a crafted length prefix exercises exactly the patched guard.
function makeStream(maxMessageSize) {
  const stream = new SecretStream(true, null, {
    autoStart: false,
    maxMessageSize
  });
  stream.on('error', () => {}); // the guard destroys with an Error; swallow it
  return stream;
}

// 3-byte little-endian length prefix encoding `len`, then one body byte.
function framedLength(len) {
  return b4a.from([len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, 0x00]);
}

test('the maxMessageSize option exists and defaults to off (0)', (t) => {
  const stream = makeStream(undefined);
  t.is(
    stream.maxMessageSize,
    0,
    'unset → 0 (off), so unpatched behaviour is preserved'
  );
  stream.destroy();
});

test('an over-cap message is rejected at the length prefix (before allocUnsafe)', (t) => {
  const stream = makeStream(100);
  stream._onrawdata(framedLength(200)); // declares a 200-byte body > the 100 cap
  t.ok(
    stream.destroying,
    'the stream is destroyed before reading/allocating the body'
  );
});

test('an under-cap message is not rejected', (t) => {
  const stream = makeStream(1000);
  stream._onrawdata(framedLength(200)); // 200 < 1000 → allowed
  t.absent(stream.destroying, 'a legitimate-size message passes the guard');
  stream.destroy();
});

test('the guard is off when maxMessageSize is 0 (no cap)', (t) => {
  const stream = makeStream(0);
  stream._onrawdata(framedLength(200));
  t.absent(
    stream.destroying,
    'with the cap off, the length prefix is never rejected'
  );
  stream.destroy();
});
