// Local end-to-end tests: real bare `wave.run.js` peers on a local DHT, NO wallets / no
// on-chain (so they're deterministic, secret-free, and CI-safe). Each scenario spins up a
// PEER_COUNT equal peers, drives a full wave, and asserts on the outcome via the harness's
// poll-until-event helpers (no sleeps). Run: `npm run test:e2e:local` (or set E2E_PEERS=<n>).
//
// A companion on-chain suite (funded wallets + Nile) covers the paid-wave gate, burns, and
// tips — that one needs secrets + costs testnet TRX, so it runs gated/nightly.
const test = require('brittle');
const { Cluster, sleep, waitForAnyGallery } = require('./harness');

// 8 is a good default: enough hops that the token really races a ring and gossip really floods
// a small mesh, but light enough for a 2-core CI runner. Turn it down on a constrained box.
const PEER_COUNT = Number(process.env.E2E_PEERS || 8);

// Launch PEER_COUNT equal peers, all auto-joining and auto-selfie-ing (no roles). p1 initiates: it kicks
// off once it sees everyone (the PEER_COUNT-1 other peers), and — as the initiator — it archives its
// wave's gallery. `initEnv` passes extra env only to p1. Launches are staggered — the other half
// of reliable DHT discovery (see harness.start's warm-up). Returns { peers } (peers[0] is the
// initiator p1).
async function launchWave(cluster, initEnv = {}) {
  const peers = [];
  for (let i = 1; i <= PEER_COUNT; i++) {
    peers.push(
      cluster.launch('p' + i, {
        AUTOJOIN: '1',
        AUTOSELFIE: '1',
        ...(i === 1 ? { START: String(PEER_COUNT - 1), ...initEnv } : {})
      })
    );
    await sleep(400);
  }
  return { peers };
}

test(
  `a ${PEER_COUNT}-peer wave converges the gallery on every node`,
  { timeout: 150000 },
  async (t) => {
    const cluster = await new Cluster({ lobbyMs: 8000 }).start();
    t.teardown(() => cluster.destroy());

    const { peers } = await launchWave(cluster);

    // Every participant — including the initiator p1, which retains the gallery — reaches the FULL
    // roster: churn-free, every peer posts and every node converges on all PEER_COUNT selfies.
    // (This was briefly relaxed to PEER_COUNT - 1 during the July 2026 regression hunt; the actual
    // culprit was hyperdht 6.33.0 breaking the local-testnet networking — see TODO.md "Dependency
    // watch" — and on the pinned hyperdht the strict assertion passes. Keep it strict: it's the
    // sharpest detector for this class of regression.)
    for (const peer of peers) {
      t.ok(await peer.waitForGallery(PEER_COUNT, 90000), `${peer.name} converged to ${PEER_COUNT}`);
    }

    // and the token actually completed the lap back to the originator (didn't stall)
    t.ok(await peers[0].waitForEvent('completed', 10000), 'the wave completed at the originator');
  }
);

test(
  `the wave heals when peers die mid-race (${PEER_COUNT} peers, kill 2)`,
  { timeout: 150000 },
  async (t) => {
    const cluster = await new Cluster({ lobbyMs: 8000 }).start();
    t.teardown(() => cluster.destroy());

    const { peers } = await launchWave(cluster);

    // once the ball is moving, kill two mid-ring peers (not the initiator p1, its archivist)
    await peers[0].waitForEvent('started', 90000);
    const survivors = peers.filter((_, i) => i !== 2 && i !== 4); // all live peers incl. p1
    peers[2].kill(); // p3
    peers[4].kill(); // p5

    // the wave must still finish — the ring routes around the dead peers (self-healing). This is
    // the core of the test: the token completes its lap despite two mid-race deaths.
    t.ok(
      await peers[1].waitForEvent('completed', 90000),
      'wave completed despite 2 peers dying mid-race'
    );
    // The survivors' selfies then converge into the shared gallery. We check the survivor SET (not
    // only the non-hub initiator) reaching PEER_COUNT-3 rather than the full PEER_COUNT-2, because two SIMULTANEOUS
    // mid-race kills occasionally cost the token to one *extra* live neighbour: a healer skips a
    // peer whose wave-pos ACK doesn't arrive within HEAL_TIMEOUT_MS during the connection churn,
    // so that peer never holds the token and never selfies (verified: it joins + sees the ball but
    // logs no receipt). Waiting can't recover it — it's a heal-precision limit under aggressive
    // churn, not a convergence lag — so we tolerate one dropped selfie. Full coverage (every peer
    // posts + converges) is asserted churn-free by the first test.
    t.ok(
      await waitForAnyGallery(survivors, PEER_COUNT - 3, 90000),
      `the healed wave still populated the gallery (≥ ${PEER_COUNT - 3} survivor selfies converged)`
    );
  }
);
