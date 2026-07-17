// Local end-to-end tests: real bare `wave.run.js` peers on a local DHT, NO wallets / no
// on-chain (so they're deterministic, secret-free, and CI-safe). Each scenario spins up a
// PEER_COUNT equal peers, drives a full wave, and asserts on the outcome via the harness's
// poll-until-event helpers (no sleeps). Run: `npm run test:e2e:local` (or set E2E_PEERS=<n>).
//
// A companion on-chain suite (funded wallets + Nile) covers the paid-wave gate, burns, and
// tips — that one needs secrets + costs testnet TRX, so it runs gated/nightly.
const test = require('brittle');
const { Cluster, sleep, waitForAnyFeed } = require('./harness');

// 8 is a good default: enough peers that the sweep really covers a ring and gossip really floods
// a small mesh, but light enough for a 2-core CI runner. Turn it down on a constrained box, or up
// for a scale run (the manual e2e-public workflow dispatches this suite with a chosen count).
const PEER_COUNT = Number(process.env.E2E_PEERS || 8);

// Time windows scale with the peer count so a large-N dispatch isn't strangled by budgets sized
// for 8: launch alone staggers 400ms per peer, and convergence replicates N entrys to N nodes.
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

// Launch PEER_COUNT equal peers, all auto-joining and auto-entry-ing (no roles). p1 initiates: it
// kicks off once its ring reaches START_TARGET, and — as the initiator — it archives its wave's
// feed. Launches are staggered — the other half of
// reliable DHT discovery (see harness.start's warm-up). Returns { peers } (peers[0] is p1).
async function launchWave(cluster) {
  const peers = [];
  for (let i = 1; i <= PEER_COUNT; i++) {
    peers.push(
      cluster.launch('p' + i, {
        AUTOJOIN: '1',
        AUTOENTRY: '1',
        // force a partial mesh below the peer count (E2E_MAX_PEERS=16 at N=64)
        ...(process.env.E2E_MAX_PEERS
          ? { HYPERWAVE_MAX_PEERS: process.env.E2E_MAX_PEERS }
          : {}),
        ...(i === 1 ? { START: String(START_TARGET) } : {})
      })
    );
    await sleep(400);
  }
  return { peers };
}

test(
  `a ${PEER_COUNT}-peer wave converges the feed on every node`,
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const cluster = await new Cluster({
      lobbyMs: LOBBY_MS
    }).start();
    t.teardown(() => cluster.destroy());

    const { peers } = await launchWave(cluster);

    // The convergence target. At small N (STRICT_FULL_ROSTER): the FULL peer count — churn-free,
    // every peer joins the lobby, posts, and every node converges on all PEER_COUNT entrys. (This
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
        await peer.waitForFeed(target, WAIT_MS),
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
      lobbyMs: LOBBY_MS
    }).start();
    t.teardown(() => cluster.destroy());

    const { peers } = await launchWave(cluster);

    // once the sweep is scheduled, kill two mid-ring peers (not the initiator p1 — it
    // archives the feed)
    await peers[0].waitForEvent('started', WAIT_MS);
    // like test 1: full count at small N, the lobby-gathered roster at scale
    const target = STRICT_FULL_ROSTER ? PEER_COUNT : gatheredRoster(peers[0]);
    const survivors = peers.filter((_, i) => i !== 2 && i !== 4); // all live peers incl. p1
    peers[2].kill(); // p3
    peers[4].kill(); // p5

    // the wave must still finish — nobody waits on a dead peer: every survivor
    // self-completes at its own deterministic end timer
    t.ok(
      await peers[1].waitForEvent('completed', WAIT_MS),
      'wave completed despite 2 peers dying mid-wave'
    );
    // The survivors' entrys converge into the shared feed. The ONLY loss is the two
    // killed peers' own slots (they died before posting): everyone else posts and
    // converges, so the bound is exact.
    t.ok(
      await waitForAnyFeed(survivors, target - 2, WAIT_MS),
      `the sweep still populated the feed (≥ ${target - 2} survivor entrys converged)`
    );
  }
);

// The waveIds a peer saw reach a given lifecycle event (started / completed), read from its
// own event stream. Concurrent waves each carry a distinct waveId, so a set of size ≥ 2 is the
// proof that the singleton is gone.
function waveIdsForEvent(peer, name) {
  const ids = new Set();
  for (const evt of peer.events) {
    if (evt.event === name && evt.waveId) {
      ids.add(evt.waveId);
    }
  }
  return ids;
}

// Concurrent waves (scaling.md Phase 1): with the singleton + lower-waveId tie-break gone, TWO
// initiators announcing at once no longer collapse to one wave — both run to completion, and a
// third peer adopts + sweeps + completes BOTH. (Under the old rule one initiator's wave would be
// superseded and only one waveId would ever complete cluster-wide.)
test(
  `two concurrent initiators run two independent waves (${PEER_COUNT} peers)`,
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const cluster = await new Cluster({ lobbyMs: LOBBY_MS }).start();
    t.teardown(() => cluster.destroy());

    // p1 AND p2 both initiate (both carry START); everyone else just auto-joins/enters. Each
    // peer adopts every announced wave regardless of which one it opts into.
    const peers = [];
    for (let i = 1; i <= PEER_COUNT; i++) {
      peers.push(
        cluster.launch('p' + i, {
          AUTOJOIN: '1',
          AUTOENTRY: '1',
          ...(process.env.E2E_MAX_PEERS
            ? { HYPERWAVE_MAX_PEERS: process.env.E2E_MAX_PEERS }
            : {}),
          ...(i === 1 || i === 2 ? { START: String(START_TARGET) } : {})
        })
      );
      await sleep(400);
    }

    // both initiators start their own wave
    t.ok(
      await peers[0].waitForEvent('started', WAIT_MS),
      'p1 started its wave'
    );
    t.ok(
      await peers[1].waitForEvent('started', WAIT_MS),
      'p2 started its wave'
    );
    const waveA = [...waveIdsForEvent(peers[0], 'started')][0];
    const waveB = [...waveIdsForEvent(peers[1], 'started')][0];
    t.ok(waveA && waveB && waveA !== waveB, 'two distinct waves are running');

    // a non-initiator adopts and completes BOTH concurrent waves (proving no singleton/tie-break)
    const spectator = peers[2];
    const bothCompleted = await spectator.waitForEvent(
      'completed',
      WAIT_MS,
      () => waveIdsForEvent(spectator, 'completed').size >= 2
    );
    t.ok(bothCompleted, 'a third peer completed two concurrent waves');
    const completedIds = waveIdsForEvent(spectator, 'completed');
    t.ok(
      completedIds.has(waveA) && completedIds.has(waveB),
      'both wave A and wave B completed on the same peer'
    );
  }
);

// Subscription layer (scaling.md Phase 2/3): with HYPERWAVE_AUTO_SUBSCRIBE=0, a peer stays merely
// AWARE of an announced wave until it explicitly joins or subscribes. A SPECTATE peer subscribes
// (holds the feed, watches the sweep) WITHOUT joining/posting — proving subscribe-without-join
// gives you the full feed, and that the browse-then-pick path engages the feed on demand.
test(
  `browse-then-pick: a spectator subscribes to the feed without joining (${PEER_COUNT} peers)`,
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const cluster = await new Cluster({ lobbyMs: LOBBY_MS }).start();
    t.teardown(() => cluster.destroy());

    // Everyone runs autoSubscribe=false (browse-then-pick). p1 initiates + joins; p2..p(N-1) join;
    // pN only SPECTATEs (subscribe, no join, no entry). Joiners = N-1; the spectator adds nothing.
    const peers = [];
    for (let i = 1; i <= PEER_COUNT; i++) {
      const isSpectator = i === PEER_COUNT;
      peers.push(
        cluster.launch('p' + i, {
          HYPERWAVE_AUTO_SUBSCRIBE: '0',
          ...(isSpectator
            ? { SPECTATE: '1' }
            : { AUTOJOIN: '1', AUTOENTRY: '1' }),
          ...(i === 1 ? { START: String(START_TARGET) } : {})
        })
      );
      await sleep(400);
    }

    await peers[0].waitForEvent('started', WAIT_MS);
    // the roster the lobby gathered = the joiners (the spectator never joins, so it's not counted)
    const joiners = STRICT_FULL_ROSTER
      ? PEER_COUNT - 1
      : gatheredRoster(peers[0]);
    t.ok(joiners >= 2, `at least two peers joined (${joiners})`);

    // every joiner converges to the joiner count
    for (let i = 0; i < PEER_COUNT - 1; i++) {
      t.ok(
        await peers[i].waitForFeed(joiners, WAIT_MS),
        `joiner ${peers[i].name} converged to ${joiners}`
      );
    }

    // the spectator explicitly subscribed on demand...
    const spectator = peers[PEER_COUNT - 1];
    t.ok(
      await spectator.waitForEvent('subscribed', WAIT_MS),
      'the spectator subscribed on demand (browse-then-pick)'
    );
    // ...and converged to the SAME feed as the joiners despite never joining or posting (its own
    // entry is absent — it can only ever reach the joiner count, never one more).
    t.ok(
      await spectator.waitForFeed(joiners, WAIT_MS),
      `the spectator sees the full feed (${joiners}) without joining`
    );
  }
);

// wave-note (a roster-member broadcast — the tip-notification primitive): the engine relays and
// processes a note ONLY if its author is a roster member of the wave, and lets you originate one
// only if you are. This scenario proves both: a fixed 3-peer set — two roster members + one
// spectator (subscribed, never joined) — each broadcasts a note on `wave-idle` (post-wave, so it
// exercises the feed-lifetime roster after the FSM's WaveState is gone). The roster members' notes
// reach the others; the spectator's is refused at origination and never appears anywhere.
test(
  'wave-note reaches roster members and a non-member cannot broadcast',
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const cluster = await new Cluster({ lobbyMs: LOBBY_MS }).start();
    t.teardown(() => cluster.destroy());

    // p1 (initiator) + p2 join and broadcast (roster members); p3 only SPECTATEs (subscribed via
    // the default autoSubscribe, never joins → not a roster member) and attempts to broadcast.
    const p1 = cluster.launch('p1', {
      START: '2',
      AUTOJOIN: '1',
      AUTOENTRY: '1',
      NOTE: '1'
    });
    await sleep(400);
    const p2 = cluster.launch('p2', {
      AUTOJOIN: '1',
      AUTOENTRY: '1',
      NOTE: '1'
    });
    await sleep(400);
    const p3 = cluster.launch('p3', { SPECTATE: '1', NOTE: '1' });

    // the wave runs and every peer returns to idle (where the notes are broadcast)
    t.ok(await p1.waitForEvent('started', WAIT_MS), 'the wave started');

    // origination gate: a roster member's broadcast is accepted; the spectator's is refused
    t.ok(
      await p1.waitForLine(/NOTE-SENT ok=true/, WAIT_MS),
      'a roster member (p1) originated its note'
    );
    t.ok(
      await p2.waitForLine(/NOTE-SENT ok=true/, WAIT_MS),
      'a roster member (p2) originated its note'
    );
    t.ok(
      await p3.waitForLine(/NOTE-SENT ok=false/, WAIT_MS),
      'the spectator (p3) was refused at origination (not a roster member)'
    );

    // relay/process: each roster member receives the OTHER roster member's note (author is on the
    // roster), post-wave — proving the feed-lifetime roster gate works after the WaveState is gone
    t.ok(
      await p2.waitForEvent('note', WAIT_MS, (evt) => evt.note?.from === 'p1'),
      'p2 received p1’s note (roster → roster)'
    );
    t.ok(
      await p1.waitForEvent('note', WAIT_MS, (evt) => evt.note?.from === 'p2'),
      'p1 received p2’s note (roster → roster)'
    );

    // the spectator's note never went on the wire, so it appears NOWHERE. Check the roster members
    // both saw p1↔p2 before asserting absence, so the flood window has clearly elapsed.
    t.absent(
      await p1.waitForEvent('note', 8000, (evt) => evt.note?.from === 'p3'),
      'no peer received the non-member (p3) note — it was dropped at origination'
    );
    t.absent(
      await p2.waitForEvent('note', 1, (evt) => evt.note?.from === 'p3'),
      'p2 never saw the non-member note either'
    );
  }
);
