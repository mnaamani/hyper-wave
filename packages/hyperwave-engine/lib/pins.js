// Random-K pin selection — the last vestige of deliberate topology.
//
// WHY PIN AT ALL (vs. relying on Hyperswarm's incidental topic mesh alone)?
// The flood layer (flood.js) carries the entire wave protocol — announce, join
// (with its admission credential), start. Flood reach needs a CONNECTED graph.
// Hyperswarm's own topic mesh is *approximately* a random graph of degree
// ≈ maxPeers, which would flood fine — but "approximately" is doing real work
// in that sentence: the mesh is shaped by DHT lookup order, join-time cohorts,
// NAT-traversal success (NAT-type islands), and connection caps filling on
// BOTH sides. None of that is adversarial, but none of it is a guarantee
// either, and it degrades exactly when it matters (large N, churn, low
// maxPeers configs). Explicit pins are the edges we CHOSE: `swarm.joinPeer`
// targets are dialed with priority and bypass `maxPeers`, so a few pinned
// edges per peer put a floor under the flood graph that does not depend on
// the transport's incidental behaviour. ~20 lines of insurance.
//
// WHY RANDOM-K (vs. the structured Chord ring this replaced)? Nothing in the
// protocol consumes successor/predecessor anymore (the sweep routes nothing),
// so ring-shaped pins only ever bought a *deterministic* connectivity proof.
// Measured at N=128 (200 fresh graphs per config, real Flood decision, 10%
// simultaneous kills): random K=7 pinning floods with 100% reach in every
// trial and BEATS the ring on diameter (4 rounds flat vs 4.9–6) — uniform
// random edges are better long-range shortcuts than structured fingers. The
// reach cliff sits at K≤3 (K=3 + kill stranded ~1 node in 1.5% of trials;
// K=2 + kill missed peers in 12.5%), so PIN_BUDGET stays well above it.
// Going random deletes chord.js (the last successor/predecessor concepts)
// for equal-or-better flood behaviour at the same pin budget.
//
// THE DOWNSIDE (accepted): connectivity is now probabilistic, not proven.
// A pinned ring contained the full ring by construction — connected, period.
// A random-K-out graph is connected with (very) high probability at K≥5, but
// there is no proof, the guarantee erodes if K is ever lowered near the
// cliff, and a reach failure at scale is harder to reason about than "is the
// ring intact?". Selection stickiness matters too: pins are TOPPED UP, never
// reshuffled (a stable pin set keeps channels alive — re-rolling pins every
// tick would churn connections, the exact flapping that once broke the token
// walk). If the 128-peer public-DHT run ever shows ragged flood reach, the
// fix is raising PIN_BUDGET — or resurrecting the ring rule from git history.
//
// Pure selection logic — no swarm; wave.js wires it to joinPeer/leavePeer via
// PeerTable.updatePins. Unit-tested in pins.test.js.

/**
 * Top up a sticky random pin set: keep every current pin that is still a
 * valid candidate, then add uniform-random candidates until `budget` pins
 * are held (or candidates run out). Never evicts a still-valid pin — the
 * set only changes when pins die or the budget is short.
 * @param {Object} opts - Selection inputs.
 * @param {Iterable<string>} opts.current - Currently pinned ids.
 * @param {Iterable<string>} opts.candidates - All dialable ids (discovered ∪
 *   connected ∪ known), excluding self.
 * @param {number} opts.budget - How many pins to hold (PIN_BUDGET).
 * @param {() => number} [opts.random] - RNG in [0,1) (injectable for tests).
 * @returns {Set<string>} The new pin target set (≤ budget of them).
 */
function topUpPins({ current, candidates, budget, random = Math.random }) {
  const candidateSet = new Set(candidates);
  const targets = new Set();
  for (const id of current) {
    if (targets.size >= budget) {
      break;
    }
    if (candidateSet.has(id)) {
      targets.add(id); // sticky: a live pin is never re-rolled
    }
  }
  const pool = [...candidateSet].filter((id) => !targets.has(id));
  while (targets.size < budget && pool.length > 0) {
    const index = Math.floor(random() * pool.length);
    targets.add(pool[index]);
    pool[index] = pool[pool.length - 1];
    pool.pop();
  }
  return targets;
}

module.exports = { topUpPins };
