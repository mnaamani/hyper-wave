// On-chain end-to-end test: a full ENFORCED wave against the real Tron Nile testnet — the
// paid-wave gate, real fee burns, optimistic gallery admission, and the raffle PAYOUT (the
// initiator verifies the winner's burn on-chain and pays the prize). This is a real
// external-testnet integration test: it needs FUNDED wallets, hits Nile RPC, and spends testnet
// TRX — so it's SKIPPED unless explicitly enabled, and runs gated/nightly in CI (never on every PR).
//
// No roles: the wave's initiator (P1) is also its gallery archivist and raffle sponsor, so it
// must be the well-funded wallet (it pays the kick-off burn AND the prize). It never pays itself,
// so the prize goes to the joiner P2.
//
// Enable with:  E2E_ONCHAIN=1  and two funded BIP39 mnemonics:
//   HYPERWAVE_E2E_SEED_1  — initiator P1 (kick-off burn + raffle prize; keep it well-funded)
//   HYPERWAVE_E2E_SEED_2  — joiner P2 (join burn, exercises optimistic admission, wins the prize)
// Fund via the Nile faucet (https://nileex.io/join/getJoinPage). See DEMO.md.
const test = require('brittle')
const { Cluster, sleep } = require('./harness')

const P1_SEED = process.env.HYPERWAVE_E2E_SEED_1
const P2_SEED = process.env.HYPERWAVE_E2E_SEED_2
const enabled = process.env.E2E_ONCHAIN === '1' && !!(P1_SEED && P2_SEED)

const opts = { timeout: 300000, skip: !enabled }

test('enforced wave on Nile: paid gate → optimistic admission → raffle payout', opts, async (t) => {
  // 20s lobby: room for P2 to verify the kick-off burn on-chain and burn its own join fee.
  const c = await new Cluster({ lobbyMs: 20000 }).start()
  t.teardown(() => c.destroy())

  // stagger the launches (with the DHT warm-up in start(), this is what makes discovery
  // reliable — otherwise a peer can join a half-formed DHT and stay isolated). P2 first, then
  // the initiator P1 (which kicks off once it sees P2) — P1 also sponsors the raffle.
  const p2 = c.launch('p2', { AUTOJOIN: '1', AUTOSELFIE: '1', WALLET: '1' }, P2_SEED)
  await sleep(600)
  const p1 = c.launch(
    'p1',
    { START: '1', AUTOJOIN: '1', AUTOSELFIE: '1', WALLET: '1', HYPERWAVE_RAFFLE_TRX: '3' },
    P1_SEED
  )

  // wallets load from the funded seeds (WDK init) — p1 only auto-kicks-off once its wallet is up
  await Promise.all([
    p1.waitForLine(/WALLET T\w+ trx=/, 60000),
    p2.waitForLine(/WALLET T\w+ trx=/, 60000)
  ])
  t.pass('both funded wallets loaded')

  // paid-wave gate: P1 burns the kick-off fee and confirms it on-chain BEFORE announcing
  t.ok(await p1.waitForLine(/KICKOFF-BURNED/, 120000), 'P1 burned the kick-off fee')
  // P2 independently verifies that kick-off burn on-chain, then opts in and burns its own fee
  t.ok(await p2.waitForEvent('wave-verified', 120000), 'P2 verified the kick-off burn on-chain')
  t.ok(await p2.waitForLine(/JOIN-BURNED/, 120000), 'P2 burned its join fee')
  // OPTIMISTIC admission: P1 admits P2 with no on-chain check on the write path
  t.ok(await p1.waitForLine(/admitted gallery writer/, 120000), 'P1 admitted P2 (optimistic)')
  // both selfies converge into the gallery P1 retains (tip addresses bound to the burn wallets)
  t.ok(await p1.waitForGallery(2, 150000), 'the gallery converged to 2')
  // raffle PAYOUT: P1 verifies the winner's burn on-chain (the deferred check) and pays it (P1
  // skips itself, so the winner is P2)
  const win = await p1.waitForEvent('raffle-win', 150000)
  t.is(win.amount, 3, 'the winner was paid the 3 TRX prize')
  t.is((win.hash || '').length, 64, 'the prize payment landed as a real on-chain tx')
})
