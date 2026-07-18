// The USDT (TRC-20) Tron wallet (tron-usdt-wallet.js): offline coverage of the interface + the
// inheritance from TronWallet + address derivation (shared seed). The on-chain TRC-20 ops
// (balances/send/burn/verifyBurnTx) need Nile + a funded/gassed wallet + the real USDT contract,
// so they're de-risked by the on-chain tier, not here. Runs under Bare:
//   bare lib/tron-usdt-wallet.test.js   (or `npm test`)
const test = require('brittle');
const fs = require('bare-fs');
const { Wallet } = require('hyperwave-wallet');
const { TronWallet } = require('./tron-wallet');
const {
  TronUsdtWallet,
  createTronUsdtWallet,
  FEE_USDT
} = require('./tron-usdt-wallet');

const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/; // base58check, 34 chars
const USDT_CONTRACT = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj'; // a dummy for the offline test

test('createTronUsdtWallet builds a USDT wallet that extends TronWallet (offline)', async (t) => {
  const dir = '/tmp/hyperwave-usdt-test-' + Date.now();
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  const usdt = await createTronUsdtWallet({
    storageDir: dir,
    usdtContract: USDT_CONTRACT
  });
  t.ok(usdt instanceof TronUsdtWallet, 'a TronUsdtWallet');
  t.ok(
    usdt instanceof TronWallet,
    'extends TronWallet (reuses the Tron machinery)'
  );
  t.ok(usdt instanceof Wallet, 'implements the Wallet interface');
  t.is(
    usdt.type,
    'tron-usdt-nile',
    'a DISTINCT payment-mechanism type from native TRX (tron-nile)'
  );
  t.is(usdt.fee, FEE_USDT, 'declares its USDT participation fee');
  t.ok(
    TRON_ADDRESS.test(usdt.address),
    'derives a valid Tron address (holds TRX gas + USDT)'
  );
  usdt.dispose();

  // same storage dir -> same seed -> same address as any Tron wallet (self-custodial, one seed)
  const usdt2 = await createTronUsdtWallet({
    storageDir: dir,
    usdtContract: USDT_CONTRACT
  });
  t.is(usdt2.address, usdt.address, 'persists across restarts');
  usdt2.dispose();
});

test('the network carries into the USDT wire type (offline)', async (t) => {
  const dir = '/tmp/hyperwave-usdt-net-' + Date.now();
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  const usdt = await createTronUsdtWallet({
    storageDir: dir,
    usdtContract: USDT_CONTRACT,
    network: 'mainnet'
  });
  t.is(
    usdt.type,
    'tron-usdt-mainnet',
    'mainnet USDT advertises tron-usdt-mainnet (distinct from native + from testnet)'
  );
  usdt.dispose();
});

test('the USDT fee is configurable and defaults to FEE_USDT', async (t) => {
  const dir = '/tmp/hyperwave-usdt-fee-' + Date.now();
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  const custom = await createTronUsdtWallet({
    storageDir: dir,
    usdtContract: USDT_CONTRACT,
    fee: 2
  });
  t.is(custom.fee, 2, 'a per-deployment USDT fee overrides the default');
  custom.dispose();

  const def = await createTronUsdtWallet({
    storageDir: dir,
    usdtContract: USDT_CONTRACT
  });
  t.is(def.fee, FEE_USDT, 'defaults to FEE_USDT (via the inherited get fee())');
  def.dispose();
});

test('createTronUsdtWallet requires the USDT contract address', async (t) => {
  await t.exception(
    () => createTronUsdtWallet({ storageDir: '/tmp/x' }),
    /usdtContract/,
    'no safe default — the app must supply the token contract'
  );
});
