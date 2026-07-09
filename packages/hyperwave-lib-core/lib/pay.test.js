// Payment module: wallet derivation is offline + deterministic (network-dependent balance
// /transfer are proven by spike/wdk against Tron Nile testnet, not here). Runs under Bare:
//   bare workers/lib/pay.test.js   (or `npm test`)
const test = require('brittle');
const fs = require('bare-fs');
const { createPayments, toSun, fromSun } = require('./pay');

const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/; // base58check, 34 chars

test('createPayments derives a persistent self-custodial Tron wallet (offline)', async (t) => {
  const dir = '/tmp/hyperwave-pay-test-' + Date.now();
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  const pay1 = await createPayments({ storageDir: dir });
  t.ok(TRON_ADDRESS.test(pay1.address), 'valid base58 Tron address');
  t.ok(fs.existsSync(dir + '/wallet.seed'), 'seed persisted to disk');
  pay1.dispose();

  // same storage dir -> same seed -> same address (survives restarts, self-custodial)
  const pay2 = await createPayments({ storageDir: dir });
  t.is(pay2.address, pay1.address, 'wallet persists across restarts');
  pay2.dispose();
});

test('TRX <-> sun conversion is 6-decimal exact', (t) => {
  t.is(toSun(1.5), 1500000n);
  t.is(toSun(0.000001), 1n, 'smallest unit (1 sun)');
  t.is(fromSun(1500000n), 1.5);
});
