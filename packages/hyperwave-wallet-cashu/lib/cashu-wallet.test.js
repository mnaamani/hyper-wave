// The Cashu wallet (cashu-wallet.js): offline construction — deterministic
// identity derivation, the Wallet interface shape, the empty-store balance, and
// seed persistence. Network ops (mint/send/burn/verify against a live mint) are
// proven by spike/cashu/, not here. Runs under Bare:
//   bare lib/cashu-wallet.test.js   (or `npm test`)
const test = require('brittle');
const fs = require('bare-fs');
const { Wallet } = require('hyperwave-wallet');
const {
  CashuWallet,
  createCashuWallet,
  CASHU_WALLET_TYPE
} = require('./cashu-wallet');

const SEED = 'test seed phrase for the cashu identity key derivation';
const PUBKEY_HEX = /^0[23][0-9a-f]{64}$/; // 33-byte compressed secp256k1

function tempDir() {
  return '/tmp/hyperwave-cashu-' + Date.now() + '-' + Math.random();
}

test('createCashuWallet builds an offline, spec-conforming Wallet', async (t) => {
  const dir = tempDir();
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  const wallet = await createCashuWallet({ storageDir: dir, seed: SEED });
  t.ok(wallet instanceof CashuWallet, 'a CashuWallet');
  t.ok(wallet instanceof Wallet, 'implements the Wallet interface');
  t.is(wallet.type, CASHU_WALLET_TYPE, "type is the generic 'cashu'");
  t.is(wallet.type, 'cashu', 'not per-mint (any Cashu peer interoperates)');
  t.is(wallet.unit, 'sat', 'unit is sat');
  t.is(wallet.fee, 2, 'default participation fee (sats)');
  t.ok(PUBKEY_HEX.test(wallet.address), 'address is a P2PK identity pubkey');

  const bal = await wallet.balances();
  t.alike(
    bal,
    { address: wallet.address, amount: 0, unit: 'sat' },
    'empty store → zero balance in the currency-agnostic shape'
  );
  t.alike(
    await wallet.accounts(),
    [{ index: 0, address: wallet.address }],
    'a single account (no BIP-44 ladder)'
  );
  t.alike(await wallet.transactions(), [], 'no history yet');
  wallet.dispose();
});

test('network classification: own mint (get network) + a burn proof (networkOf)', async (t) => {
  const dir = tempDir();
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Default mint is testnut → testnet.
  const testWallet = await createCashuWallet({ storageDir: dir, seed: SEED });
  t.is(testWallet.network, 'testnet', 'default (testnut) wallet is on testnet');
  testWallet.dispose();

  // A known mainnet mint → mainnet.
  const mainWallet = await createCashuWallet({
    storageDir: dir + '-m',
    seed: SEED,
    mint: 'https://mint.coinos.io'
  });
  t.is(mainWallet.network, 'mainnet', 'a known real mint → mainnet');

  // An app-added mint is honoured via knownMints.
  const appWallet = await createCashuWallet({
    storageDir: dir + '-a',
    seed: SEED,
    mint: 'https://my.app.mint',
    knownMints: [{ url: 'https://my.app.mint', network: 'mainnet' }]
  });
  t.is(
    appWallet.network,
    'mainnet',
    'an app-added mint classifies its network'
  );
  appWallet.dispose();

  // networkOf on an undecodable burnRef → 'unknown' (permissive, never throws).
  t.is(
    mainWallet.networkOf('not-a-real-cashu-token'),
    'unknown',
    'networkOf on garbage → unknown (never throws)'
  );
  mainWallet.dispose();
});

test('the identity key is deterministic from the seed', async (t) => {
  const dir = tempDir();
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  const first = await createCashuWallet({ storageDir: dir, seed: SEED });
  const again = await createCashuWallet({ storageDir: dir, seed: SEED });
  t.is(again.address, first.address, 'same injected seed → same address');

  const otherDir = tempDir();
  t.teardown(() => fs.rmSync(otherDir, { recursive: true, force: true }));
  const other = await createCashuWallet({
    storageDir: otherDir,
    seed: 'a completely different seed'
  });
  t.not(other.address, first.address, 'distinct seed → distinct address');
});

test('a generated seed persists to disk and survives a restart', async (t) => {
  const dir = tempDir();
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  // No injected seed → the wallet generates + persists one to cashu.seed.
  const born = await createCashuWallet({ storageDir: dir });
  t.ok(fs.existsSync(dir + '/cashu.seed'), 'generated seed persisted to disk');

  const restarted = await createCashuWallet({ storageDir: dir });
  t.is(
    restarted.address,
    born.address,
    'address survives a restart (seed file)'
  );
});

test('verifyBurnTx flags an uncompletable check as transient, not a rejection', async (t) => {
  const dir = tempDir();
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  const wallet = await createCashuWallet({ storageDir: dir, seed: SEED });
  // A burnRef we can't decode/reach fails the check WITHOUT proving the burn invalid, so it must
  // be flagged transient — the engine retries these (a foreign per-peer mint being momentarily
  // unreachable shouldn't permanently reject an honest cross-mint wave) rather than rejecting.
  const res = await wallet.verifyBurnTx('not-a-real-cashu-token', {
    waveId: 'w1',
    minAmount: 1
  });
  t.is(res.ok, false, 'does not verify');
  t.is(
    res.transient,
    true,
    'transient → engine retries instead of rejecting the wave'
  );
  wallet.dispose();
});
