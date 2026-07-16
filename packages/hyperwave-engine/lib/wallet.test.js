// Wallet module: wallet derivation is offline + deterministic (network-dependent balance
// /transfer are proven by spike/wdk against Tron Nile testnet, not here). Runs under Bare:
//   bare lib/wallet.test.js   (or `npm test`)
const test = require('brittle');
const fs = require('bare-fs');
const {
  Wallet,
  TronWallet,
  createPayments,
  toSun,
  fromSun
} = require('./wallet');

const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/; // base58check, 34 chars

test('Wallet is an abstract interface — unimplemented members throw', (t) => {
  const bare = new Wallet();
  t.exception(() => bare.type, 'type must be implemented');
  t.exception(() => bare.fee, 'fee must be implemented');
  t.exception(() => bare.address, 'address must be implemented');
  t.execution(() => bare.dispose(), 'dispose is a no-op by default');
});

test('a custom Wallet subclass is accepted by duck-type (implements the interface)', (t) => {
  class MyWallet extends Wallet {
    get type() {
      return 'my-chain';
    }
    get fee() {
      return 5;
    }
    get address() {
      return 'my-addr';
    }
  }
  const custom = new MyWallet();
  t.ok(custom instanceof Wallet, 'extends the base class');
  t.is(custom.type, 'my-chain');
  t.is(custom.fee, 5);
  t.is(custom.address, 'my-addr');
});

test('createPayments derives a persistent self-custodial Tron wallet (offline)', async (t) => {
  const dir = '/tmp/hyperwave-wallet-test-' + Date.now();
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  const pay1 = await createPayments({ storageDir: dir });
  t.ok(pay1 instanceof TronWallet, 'a TronWallet (Wallet subclass)');
  t.ok(pay1 instanceof Wallet, 'implements the Wallet interface');
  t.is(
    pay1.type,
    'tron-nile',
    'declares its payment-mechanism type (rides the wire)'
  );
  t.is(pay1.fee, 1, 'declares its participation fee');
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
