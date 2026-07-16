// On-chain end-to-end test for the USDT (TRC-20) payment mechanism — the same enforced-wave flow
// as wave.onchain.e2e.js, but fees are burned in USDT via `TronUsdtWallet` instead of native TRX.
// This is the lane that actually exercises the USDT wallet's on-chain paths (burn/verifyBurnTx/
// balances), which offline unit tests can't reach. Real external-testnet integration: it needs
// FUNDED wallets (USDT for fees + TRX for gas — TRC-20 transfers cost energy) and the Nile USDT
// contract, so it's SKIPPED unless explicitly enabled, and runs gated/nightly in CI.
//
// No roles: the initiator (P1) is an ordinary participant that pays the kick-off burn (in USDT).
//
// Enable with:  E2E_ONCHAIN_USDT=1, the Nile USDT contract, and two funded BIP39 mnemonics whose
// addresses hold BOTH USDT (fees) and a little TRX (gas):
//   HYPERWAVE_E2E_USDT_CONTRACT — the Nile USDT TRC-20 contract address (base58)
//   HYPERWAVE_E2E_SEED_1        — initiator P1 (kick-off burn; keep it well-funded)
//   HYPERWAVE_E2E_SEED_2        — joiner P2 (join burn)
// Fund TRX via the Nile faucet (https://nileex.io/join/getJoinPage); fund USDT from a Nile faucet /
// a prior transfer. See DEMO.md.
const test = require('brittle');
const { Cluster, sleep } = require('./harness');

const USDT_CONTRACT = process.env.HYPERWAVE_E2E_USDT_CONTRACT;
const P1_SEED = process.env.HYPERWAVE_E2E_SEED_1;
const P2_SEED = process.env.HYPERWAVE_E2E_SEED_2;
const enabled =
  process.env.E2E_ONCHAIN_USDT === '1' &&
  !!(USDT_CONTRACT && P1_SEED && P2_SEED);

const opts = { timeout: 300000, skip: !enabled };

// USDT peers select the TRC-20 wallet (WALLET_TYPE=usdt + USDT_CONTRACT); the address is the same
// as the native wallet's (one seed), so it holds TRX for gas + USDT for the fee.
const usdtEnv = (extra) => ({
  WALLET: '1',
  WALLET_TYPE: 'usdt',
  USDT_CONTRACT,
  ...extra
});

test(
  'enforced USDT wave on Nile: paid gate → paid join → feed convergence',
  opts,
  async (t) => {
    // 20s lobby: room for P2 to verify P1's USDT kick-off burn on-chain and burn its own join fee.
    const cluster = await new Cluster({ lobbyMs: 20000 }).start();
    t.teardown(() => cluster.destroy());

    const p2 = cluster.launch(
      'p2',
      usdtEnv({ AUTOJOIN: '1', AUTOENTRY: '1' }),
      P2_SEED
    );
    await sleep(600);
    const p1 = cluster.launch(
      'p1',
      usdtEnv({ START: '1', AUTOJOIN: '1', AUTOENTRY: '1' }),
      P1_SEED
    );

    // both USDT wallets load from the funded seeds (WDK init + a TRC-20 balanceOf)
    await Promise.all([
      p1.waitForLine(/WALLET T\w+ trx=.*type=tron-usdt-nile/, 60000),
      p2.waitForLine(/WALLET T\w+ trx=.*type=tron-usdt-nile/, 60000)
    ]);
    t.pass('both funded USDT wallets loaded');

    // paid-wave gate: P1 burns the kick-off fee in USDT (a TRC-20 transfer to the black hole with
    // the wave memo) and confirms it on-chain BEFORE announcing
    t.ok(
      await p1.waitForLine(/START-BURNED/, 120000),
      'P1 burned the kick-off fee in USDT'
    );
    // P2 independently verifies that USDT burn on-chain (TronUsdtWallet.verifyBurnTx: a
    // TriggerSmartContract transfer to the black hole for ≥ fee, memo commits the waveId)
    t.ok(
      await p2.waitForEvent('wave-verified', 120000),
      'P2 verified the USDT kick-off burn on-chain'
    );
    t.ok(
      await p2.waitForLine(/JOIN-BURNED/, 120000),
      'P2 burned its join fee in USDT'
    );
    // per-peer paid gate: P1 ingests P2's join once it carries the (USDT) burn attestation
    t.ok(
      await p1.waitForLine(/feed: learned writer/, 120000),
      'P1 ingested P2 (burn-attested join)'
    );
    // both entrys converge (tip addresses bound to the burn wallets)
    t.ok(await p1.waitForFeed(2, 150000), 'the feed converged to 2');
  }
);
