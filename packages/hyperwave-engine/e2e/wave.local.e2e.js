// Local end-to-end tests: real bare `wave.run.js` peers on a local DHT, NO wallets / no
// on-chain (so they're deterministic, secret-free, and CI-safe). Each scenario spins up a
// PEER_COUNT equal peers, drives a full wave, and asserts on the outcome via the harness's
// poll-until-event helpers (no sleeps). Run: `npm run test:e2e:local` (or set E2E_PEERS=<n>).
//
// A companion on-chain suite (funded wallets + Nile) covers the paid-wave gate, burns, and
// tips — that one needs secrets + costs testnet TRX, so it runs gated/nightly.
const test = require('brittle');
const { Cluster, sleep, waitForAnyGallery } = require('./harness');

// 8 is a good default: enough peers that the sweep really covers a ring and gossip really floods
// a small mesh, but light enough for a 2-core CI runner. Turn it down on a constrained box, or up
// for a scale run (the manual e2e-public workflow dispatches this suite with a chosen count).
const PEER_COUNT = Number(process.env.E2E_PEERS || 8);

// Time windows scale with the peer count so a large-N dispatch isn't strangled by budgets sized
// for 8: launch alone staggers 400ms per peer, and convergence replicates N selfies to N nodes.
// (The sweep itself is a chosen constant — lapMs is clamped in the engine — so the wave's own
// duration no longer scales with N.) At the default 8 these come out a whisker above the
// historical fixed values (90s wait / 150s test), so small runs behave as before.
const WAIT_MS = 90000 + PEER_COUNT * 4000;
const TEST_TIMEOUT_MS = 150000 + PEER_COUNT * 9000;

// The initiator's start trigger, capped for scale. At small N the initiator waits to SEE the whole
// roster in its live ring — the strictest start. But past Phase 4 the live ring is deliberately a
// PARTIAL view at scale (gossip is neighbour-scoped pointers, not O(N) snapshots — no peer can
// count the swarm; an 85-peer run plateaued at peers=80 and the old peers >= N-1 trigger starved
// forever). The protocol never needed the count: the LOBBY gathers the roster — wave-announce
// floods the partial mesh, joins flood back, and latecomers are caught up by wave-sync on connect.
// So at scale the initiator just waits for a healthy chunk of the ring and announces; the lobby
// (scaled below) does the rest.
const START_TARGET = Math.min(PEER_COUNT - 1, 32);
// Lobby length: joins have to flood back across the mesh from every peer, so give large rosters
// more time to opt in. At the default 8 this is the historical 8s.
const LOBBY_MS = 8000 + Math.max(0, PEER_COUNT - 8) * 100;
// Writer-admission wait (engine admitTimeoutMs): admission is batched at lobby close, so this
// is just how long a poster waits for the originator's core (carrying its add-writer op) to
// replicate back. One small-core sync — but give a loaded large-N box headroom.
const ADMIT_TIMEOUT_MS = 25000 + PEER_COUNT * 500;

// Whether the initiator's start trigger waits for the FULL roster (see START_TARGET): true at
// small N, where the lobby reliably gathers everyone and the strict full-N assertions hold. At
// scale the lobby is best-effort BY DESIGN (opt-in within a time window — a peer that misses the
// lobby is a spectator, not a failure; a 128-peer run gathered 99), so the assertions target the
// roster the lobby actually gathered instead.
const STRICT_FULL_ROSTER = START_TARGET === PEER_COUNT - 1;

/**
 * The roster the lobby actually gathered, read from the initiator's own event stream (the
 * `roster`/`wave-active` events carry the count; it's final once the race starts).
 * @param {import('./harness').Proc} initiator - p1.
 * @returns {number} The largest roster count the initiator reported.
 */
function gatheredRoster(initiator) {
  let maxCount = 0;
  for (const evt of initiator.events) {
    if (
      (evt.event === 'roster' || evt.event === 'wave-active') &&
      typeof evt.count === 'number'
    ) {
      maxCount = Math.max(maxCount, evt.count);
    }
  }
  return maxCount;
}

// Launch PEER_COUNT equal peers, all auto-joining and auto-selfie-ing (no roles). p1 initiates: it
// kicks off once its ring reaches START_TARGET, and — as the initiator — it archives its wave's
// gallery. `initEnv` passes extra env only to p1. Launches are staggered — the other half of
// reliable DHT discovery (see harness.start's warm-up). Returns { peers } (peers[0] is p1).
async function launchWave(cluster, initEnv = {}) {
  const peers = [];
  for (let i = 1; i <= PEER_COUNT; i++) {
    peers.push(
      cluster.launch('p' + i, {
        AUTOJOIN: '1',
        AUTOSELFIE: '1',
        // A/B knob: E2E_PIN_BUDGET=0 runs the whole cluster with pinning off
        ...(process.env.E2E_PIN_BUDGET
          ? { HYPERWAVE_PIN_BUDGET: process.env.E2E_PIN_BUDGET }
          : {}),
        // force a partial mesh below the peer count (E2E_MAX_PEERS=16 at N=64)
        ...(process.env.E2E_MAX_PEERS
          ? { HYPERWAVE_MAX_PEERS: process.env.E2E_MAX_PEERS }
          : {}),
        ...(i === 1 ? { START: String(START_TARGET), ...initEnv } : {})
      })
    );
    await sleep(400);
  }
  return { peers };
}

test(
  `a ${PEER_COUNT}-peer wave converges the gallery on every node`,
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const cluster = await new Cluster({
      lobbyMs: LOBBY_MS,
      admitTimeoutMs: ADMIT_TIMEOUT_MS
    }).start();
    t.teardown(() => cluster.destroy());

    const { peers } = await launchWave(cluster);

    // The convergence target. At small N (STRICT_FULL_ROSTER): the FULL peer count — churn-free,
    // every peer joins the lobby, posts, and every node converges on all PEER_COUNT selfies. (This
    // was briefly relaxed during the July 2026 regression hunt; the culprit was hyperdht 6.33.0 —
    // see TODO.md "Dependency watch" — and on the pinned hyperdht strict passes. Keep it strict:
    // it's the sharpest detector for that class of regression.) At scale: the roster the lobby
    // actually GATHERED — lobby joining is opt-in-within-a-window by design, so N-convergence is
    // not the protocol's promise; roster-convergence is. A majority check keeps teeth: a broken
    // lobby (tiny roster) still fails.
    await peers[0].waitForEvent('started', WAIT_MS);
    const target = STRICT_FULL_ROSTER ? PEER_COUNT : gatheredRoster(peers[0]);
    if (!STRICT_FULL_ROSTER) {
      t.ok(
        target > PEER_COUNT / 2,
        `the lobby gathered a majority (${target}/${PEER_COUNT} joined)`
      );
    }
    for (const peer of peers) {
      t.ok(
        await peer.waitForGallery(target, WAIT_MS),
        `${peer.name} converged to ${target}`
      );
    }

    // and the sweep ran to its deterministic end (every peer self-completes at
    // t0 + lapMs + grace — no completion message to lose)
    t.ok(
      await peers[0].waitForEvent('completed', 90000),
      'the wave completed at the originator'
    );
  }
);

test(
  `the sweep survives peers dying mid-wave (${PEER_COUNT} peers, kill 2)`,
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const cluster = await new Cluster({
      lobbyMs: LOBBY_MS,
      admitTimeoutMs: ADMIT_TIMEOUT_MS
    }).start();
    t.teardown(() => cluster.destroy());

    const { peers } = await launchWave(cluster);

    // once the sweep is scheduled, kill two mid-ring peers (not the initiator p1 — it
    // archives the gallery)
    await peers[0].waitForEvent('started', WAIT_MS);
    // like test 1: full count at small N, the lobby-gathered roster at scale
    const target = STRICT_FULL_ROSTER ? PEER_COUNT : gatheredRoster(peers[0]);
    const survivors = peers.filter((_, i) => i !== 2 && i !== 4); // all live peers incl. p1
    peers[2].kill(); // p3
    peers[4].kill(); // p5

    // the wave must still finish — nobody waits on a dead peer: every survivor
    // self-completes at its own deterministic end timer (there is no token to lose,
    // no healing, no stall)
    t.ok(
      await peers[1].waitForEvent('completed', WAIT_MS),
      'wave completed despite 2 peers dying mid-wave'
    );
    // The survivors' selfies converge into the shared gallery. The ONLY loss is the two
    // killed peers' own slots (they died before posting) — the token-era heal-precision
    // loss mode (a live peer skipped by an imprecise heal) no longer exists, so the
    // bound is exact: everyone else posts and converges.
    t.ok(
      await waitForAnyGallery(survivors, target - 2, WAIT_MS),
      `the sweep still populated the gallery (≥ ${target - 2} survivor selfies converged)`
    );
  }
);
