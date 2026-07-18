// The default Tron wallet (tron-wallet.js): wallet derivation is offline + deterministic
// (network-dependent balance/transfer are proven by spike/wdk against Tron Nile testnet, not
// here). Runs under Bare:  bare lib/tron-wallet.test.js   (or `npm test`)
const test = require('brittle');
const fs = require('bare-fs');
const { Wallet } = require('hyperwave-wallet');
const { TronWallet, createPayments, toSun, fromSun } = require('./tron-wallet');

const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/; // base58check, 34 chars

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

test('the network selects the wire type (offline; mainnet is opt-in)', async (t) => {
  const dir = '/tmp/hyperwave-wallet-net-' + Date.now();
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Same implementation, different network -> different on-the-wire type (a Nile burn is worthless
  // on mainnet, so the types must differ). Address derivation stays offline (no RPC call).
  const main = await createPayments({ storageDir: dir, network: 'mainnet' });
  t.is(main.type, 'tron-mainnet', 'mainnet advertises tron-mainnet');
  t.ok(TRON_ADDRESS.test(main.address), 'still derives a valid address');
  main.dispose();

  // Default is the testnet, so nothing spends real funds by accident.
  const def = await createPayments({ storageDir: dir });
  t.is(def.type, 'tron-nile', 'defaults to the Nile testnet');
  def.dispose();
});

test('an unknown network without a provider fails fast', async (t) => {
  await t.exception(
    createPayments({ storageDir: '/tmp/hyperwave-wallet-bad', network: 'x' }),
    /unknown Tron network/,
    'throws before any network call (must name a known network or a provider)'
  );
});

test('the fee is configurable, defaults to 1, and must be positive', async (t) => {
  const dir = '/tmp/hyperwave-wallet-fee-' + Date.now();
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  const custom = await createPayments({ storageDir: dir, fee: 0.5 });
  t.is(custom.fee, 0.5, 'a per-deployment fee overrides the default');
  custom.dispose();

  const def = await createPayments({ storageDir: dir });
  t.is(def.fee, 1, 'defaults to 1 TRX when unset');
  def.dispose();

  // A burn is a real transfer (Tron rejects zero-amount) — reject a non-positive fee up front.
  await t.exception(
    createPayments({ storageDir: dir, fee: 0 }),
    /fee` must be a positive number/,
    'a zero fee fails fast'
  );
});

test('multiple BIP-44 accounts derive distinct addresses from one seed (offline)', async (t) => {
  const dir = '/tmp/hyperwave-wallet-acct-' + Date.now();
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  // account 0 (default) and account 1 share the seed but derive different addresses.
  const a0 = await createPayments({ storageDir: dir });
  const a1 = await createPayments({ storageDir: dir, accountIndex: 1 });
  t.is(a0.accountIndex, 0, 'default account index is 0');
  t.is(a1.accountIndex, 1, 'accountIndex is reported');
  t.ok(TRON_ADDRESS.test(a1.address), 'account 1 derives a valid address');
  t.not(
    a0.address,
    a1.address,
    'account 1 has a DISTINCT address from account 0'
  );

  // deterministic: the same index re-derives the same address (self-custodial across restarts).
  const a1again = await createPayments({ storageDir: dir, accountIndex: 1 });
  t.is(
    a1again.address,
    a1.address,
    'the same index re-derives the same address'
  );

  // accounts(count) lists the first N accounts, matching the individually-derived addresses.
  const list = await a0.accounts(3);
  t.is(list.length, 3, 'accounts(3) returns three accounts');
  t.alike(
    list.map((account) => account.index),
    [0, 1, 2],
    'indexed 0..2'
  );
  t.is(list[0].address, a0.address, 'account 0 matches');
  t.is(list[1].address, a1.address, 'account 1 matches');
  t.is(new Set(list.map((account) => account.address)).size, 3, 'all distinct');
  a0.dispose();
  a1.dispose();
  a1again.dispose();
});

test('TRX <-> sun conversion is 6-decimal exact', (t) => {
  t.is(toSun(1.5), 1500000n);
  t.is(toSun(0.000001), 1n, 'smallest unit (1 sun)');
  t.is(fromSun(1500000n), 1.5);
});
