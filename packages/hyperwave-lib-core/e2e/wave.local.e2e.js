// Local end-to-end tests: real bare `wave.run.js` peers on a local DHT, NO wallets / no
// on-chain (so they're deterministic, secret-free, and CI-safe). Each scenario spins up a
// N equal peers, drives a full wave, and asserts on the outcome via the harness's
// poll-until-event helpers (no sleeps). Run: `npm run test:e2e:local` (or set E2E_PEERS=N).
//
// A companion on-chain suite (funded wallets + Nile) covers the paid-wave gate, burns, raffle
// payout, and tips — that one needs secrets + costs testnet TRX, so it runs gated/nightly.
const test = require('brittle')
const { Cluster, sleep } = require('./harness')

// 8 is a good default: enough hops that the token really races a ring and gossip really floods
// a small mesh, but light enough for a 2-core CI runner. Turn it down on a constrained box.
const N = Number(process.env.E2E_PEERS || 8)

// Launch N equal peers, all auto-joining and auto-selfie-ing (no roles). p1 initiates: it kicks
// off once it sees everyone (the N-1 other peers), and — as the initiator — it archives its
// wave's gallery + runs its raffle. `initEnv` passes extra env only to p1 (e.g. the raffle
// prize). Launches are staggered — the other half of reliable DHT discovery (see harness.start's
// warm-up). Returns { peers } (peers[0] is the initiator p1).
async function launchWave(c, initEnv = {}) {
  const peers = []
  for (let i = 1; i <= N; i++) {
    peers.push(
      c.launch('p' + i, {
        AUTOJOIN: '1',
        AUTOSELFIE: '1',
        ...(i === 1 ? { START: String(N - 1), ...initEnv } : {})
      })
    )
    await sleep(400)
  }
  return { peers }
}

test(`a ${N}-peer wave converges the gallery on every node`, { timeout: 150000 }, async (t) => {
  const c = await new Cluster({ lobbyMs: 8000 }).start()
  t.teardown(() => c.destroy())

  const { peers } = await launchWave(c)

  // every participant — including the initiator p1, which retains the gallery — reaches all N
  for (const p of peers) t.ok(await p.waitForGallery(N, 90000), `${p.name} converged to ${N}`)

  // and the token actually completed the lap back to the originator (didn't stall)
  t.ok(await peers[0].waitForEvent('completed', 10000), 'the wave completed at the originator')
})

test(
  `the wave heals when peers die mid-race (${N} peers, kill 2)`,
  { timeout: 150000 },
  async (t) => {
    const c = await new Cluster({ lobbyMs: 8000 }).start()
    t.teardown(() => c.destroy())

    const { peers } = await launchWave(c)

    // once the ball is moving, kill two mid-ring peers (not the initiator p1, its archivist)
    await peers[0].waitForEvent('started', 90000)
    peers[2].kill() // p3
    peers[4].kill() // p5

    // the wave must still finish — the ring routes around the dead peers (self-healing)
    t.ok(
      await peers[1].waitForEvent('completed', 90000),
      'wave completed despite 2 peers dying mid-race'
    )
    // every surviving participant still posts, and the initiator's retained gallery collects
    // them all, so it reaches at least N-2
    t.ok(
      await peers[0].waitForGallery(N - 2, 90000),
      `the initiator's gallery reached ≥ ${N - 2} (survivors all posted)`
    )
  }
)

test(
  `the raffle draws over all ${N} participants (commit-reveal, no wallet)`,
  { timeout: 150000 },
  async (t) => {
    const c = await new Cluster({ lobbyMs: 8000 }).start()
    t.teardown(() => c.destroy())

    // the initiator (p1) sponsors the raffle for its own wave
    const { peers } = await launchWave(c, { HYPERWAVE_RAFFLE_TRX: '3' })

    // after the wave the initiator folds every reveal into a deterministic draw over all N tickets
    const draw = await peers[0].waitForEvent('raffle-draw', 90000)
    t.is(draw.tickets, N, `all ${N} participants are eligible (commit ⟷ reveal matched)`)
    t.ok(draw.top, 'the draw names a top candidate (deterministic ranking)')
    t.is((draw.seed || '').length, 64, 'the draw seed is published for public recompute/audit')
  }
)
