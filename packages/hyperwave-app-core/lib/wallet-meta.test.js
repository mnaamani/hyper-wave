// The pure wallet-metadata helpers (wallet-meta.js): unit pluralization and the same-network
// filter, which is deliberately PERMISSIVE — it must only exclude a known test-vs-main mismatch.
//   bare lib/wallet-meta.test.js   (or `npm test`)
import test from 'brittle';
import { unitLabelFor, networksMatch, mergeWalletMeta } from './wallet-meta.js';

test('unitLabelFor pluralizes sats but leaves other units alone', (t) => {
  t.is(
    unitLabelFor('sat'),
    'sats',
    'no amount → the generic plural, as a label'
  );
  t.is(unitLabelFor('sat', 1), 'sat', 'one sat');
  t.is(unitLabelFor('sat', 5), 'sats', 'many sats');
  t.is(unitLabelFor('sat', 0), 'sats', 'zero sats');
  t.is(unitLabelFor('TRX'), 'TRX', 'a non-sat unit is never inflected');
  t.is(unitLabelFor('TRX', 5), 'TRX', 'a non-sat unit does not inflect');
});

test('networksMatch excludes only a KNOWN cross-network mismatch', (t) => {
  t.is(networksMatch('testnet', 'mainnet'), false, 'test vs main');
  t.is(networksMatch('mainnet', 'testnet'), false, 'main vs test');
  t.ok(networksMatch('testnet', 'testnet'), 'same network');
  t.ok(networksMatch('', 'mainnet'), 'my network unknown → permissive');
  t.ok(networksMatch('unknown', 'mainnet'), 'my network unknown → permissive');
  t.ok(networksMatch('testnet', ''), 'the wave network unknown → permissive');
  t.ok(networksMatch('testnet', 'unknown'), 'the wave unknown → permissive');
});

test('mergeWalletMeta only overwrites the fields a message carries', (t) => {
  const initial = mergeWalletMeta(
    {},
    { unit: 'sat', mint: 'https://a', network: 'testnet', amount: 10 }
  );
  const refreshed = mergeWalletMeta(initial, { amount: 42 });
  t.alike(
    refreshed,
    { unit: 'sat', mint: 'https://a', network: 'testnet', amount: 42 },
    'a balance-only refresh keeps the mint + network'
  );
  t.not(refreshed, initial, 'and returns a new object (no shared mutation)');
});
