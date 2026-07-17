// End-to-end test: a full ENFORCED paid wave using the Cashu (ecash) wallet, over a local DHT.
// Exercises the paid-wave gate, real fee burns, and the per-peer paid join gate — the same engine
// paid-flow as the Tron on-chain test, but the burns are ecash on a mint (testnut). Unlike the
// on-chain tier it needs NO funded seeds: testnut auto-pays mint quotes, so each peer mints its own
// sats up front (WALLET_FUND). It DOES hit the mint over the network, so it's SKIPPED unless
// explicitly enabled.
//
// No roles: the initiator (P1) is an ordinary participant that pays the kick-off burn.
//
// Enable with:  E2E_CASHU=1   (optionally CASHU_MINT=<url>, default the wallet's test mint)
const test = require('brittle');
const { Cluster, sleep } = require('./harness');

const enabled = process.env.E2E_CASHU === '1';
const opts = { timeout: 240000, skip: !enabled };

test(
  'enforced Cashu wave: fund → paid gate → paid join → feed convergence',
  opts,
  async (t) => {
    // 20s lobby: room for P2 to verify the kick-off burn at the mint and burn its own join fee.
    const cluster = await new Cluster({ lobbyMs: 20000 }).start();
    t.teardown(() => cluster.destroy());

    const walletEnv = {
      WALLET: '1',
      WALLET_TYPE: 'cashu',
      WALLET_FUND: '200', // mint 200 sat up front so the paid gate has balance
      ...(process.env.CASHU_MINT ? { CASHU_MINT: process.env.CASHU_MINT } : {})
    };

    // Stagger the launches (reliable discovery): P2 first, then the initiator P1.
    const p2 = cluster.launch('p2', {
      AUTOJOIN: '1',
      AUTOENTRY: '1',
      ...walletEnv
    });
    await sleep(600);
    const p1 = cluster.launch('p1', {
      START: '1',
      AUTOJOIN: '1',
      AUTOENTRY: '1',
      ...walletEnv
    });

    // Both wallets come up funded (unit=sat) — P1 only auto-kicks-off once its wallet is up + funded.
    await Promise.all([
      p1.waitForLine(/WALLET \w+ amount=\d+ unit=sat/, 90000),
      p2.waitForLine(/WALLET \w+ amount=\d+ unit=sat/, 90000)
    ]);
    t.pass('both Cashu wallets funded at the mint');

    // paid-wave gate: P1 burns the kick-off fee and confirms it at the mint BEFORE announcing.
    t.ok(
      await p1.waitForLine(/START-BURNED/, 120000),
      'P1 burned the kick-off fee'
    );
    // P2 independently verifies that kick-off burn at the mint, then opts in and burns its own fee.
    t.ok(
      await p2.waitForEvent('wave-verified', 120000),
      'P2 verified the kick-off burn at the mint'
    );
    t.ok(await p2.waitForLine(/JOIN-BURNED/, 120000), 'P2 burned its join fee');
    // per-peer paid gate: P1 ingests P2's burn-attested join and opens its feed core.
    t.ok(
      await p1.waitForLine(/feed: learned writer/, 120000),
      'P1 ingested P2 (burn-attested join)'
    );
    // both entries converge (tip addresses bound to the burn identities).
    t.ok(await p1.waitForFeed(2, 150000), 'the feed converged to 2');
  }
);
