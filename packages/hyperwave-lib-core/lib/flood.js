// Pure gossip-flood dedup (protocol.md §3.1). A peer floods a lifecycle control message
// by stamping it with a unique id and relaying each id **on first sight only**; repeats
// are dropped. That single rule is what turns a one-hop broadcast into an epidemic that
// blankets a partial mesh, without loops or unbounded traffic.
//
// This module owns only the "have I seen this id?" decision, size-capped so the set can't
// grow without limit over a long session. It's transport-agnostic on purpose: wave.js
// wires it to the real swarm (send/relay), and flood.test.js drives it over synthetic
// topologies to verify reach — both exercise the exact same decision code.

/**
 * Create a flood dedup tracker: the "have I seen this id?" decision, size-capped.
 * @param {object} [options] - Options.
 * @param {number} [options.cap=4096] - Max ids to remember before wholesale clear.
 * @returns {{firstSight(mid: string): boolean, readonly size: number}} The tracker.
 */
function createFlood({ cap = 4096 } = {}) {
  const seen = new Set();
  return {
    /**
     * True the first time `mid` is seen (=> process it locally and relay it onward);
     * false on any repeat (=> drop). Past `cap` the set is cleared wholesale, which at
     * worst lets a lone straggler re-flood once — harmless and very rare.
     * @param {string} mid - The unique flood message id.
     * @returns {boolean} True on first sight, false on a repeat.
     */
    firstSight(mid) {
      if (seen.has(mid)) {
        return false;
      }
      if (seen.size >= cap) {
        seen.clear();
      }
      seen.add(mid);
      return true;
    },
    /**
     * The number of ids currently remembered.
     * @returns {number} The current size of the seen set.
     */
    get size() {
      return seen.size;
    }
  };
}

module.exports = { createFlood };
