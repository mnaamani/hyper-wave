// The NUMS burn pubkey (nums.js): deterministic, on-curve, no known private key.
// Runs under Bare:  bare lib/nums.test.js   (or `npm test`)
const test = require('brittle');
const { installBareWebShims } = require('./bare-web-shims');
const { numsBurnPubkey, NUMS_DOMAIN } = require('./nums');

installBareWebShims(); // @noble needs TextEncoder/crypto at import time

test('numsBurnPubkey is deterministic and a valid compressed secp256k1 point', async (t) => {
  const first = await numsBurnPubkey();
  const second = await numsBurnPubkey();
  t.is(first.pubkey, second.pubkey, 'same key every call (memoized + fixed)');
  t.is(first.domain, NUMS_DOMAIN, 'commits the frozen burn domain');
  t.is(first.pubkey.length, 66, '33-byte compressed pubkey (hex)');
  t.ok(
    first.pubkey.startsWith('02') || first.pubkey.startsWith('03'),
    'compressed-point prefix'
  );

  // It lifts to a real curve point (fromBytes throws for an off-curve x).
  const { secp256k1 } = await import('@noble/curves/secp256k1.js');
  const bytes = Buffer.from(first.pubkey, 'hex');
  t.execution(
    () => secp256k1.Point.fromBytes(new Uint8Array(bytes)),
    'the NUMS pubkey is on the curve'
  );
});
