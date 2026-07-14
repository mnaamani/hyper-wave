// The live peer table: who is on the ring, who we can reach directly, who we've pinned
// (the flood graph's floor — pins.js), and who just disconnected (churn cooldown).
// Extracted from wave.js so the consistency rules across these collections live in one
// place:
//   - a seat's angle is ALWAYS derived from its id (never trusted from the wire);
//   - a fresher sighting wins; a stale one may still contribute its country;
//   - a direct disconnect is authoritative: the seat is dropped immediately and the id
//     enters a cooldown (goneUntil) so DHT re-seeds can't resurrect a ghost seat before
//     the cooldown expires;
//   - pins are maintained as a diff (updatePins) so wave.js can mirror exactly the
//     additions/removals into swarm.joinPeer/leavePeer.
// Pure bookkeeping — no swarm, no transport, no timers.
const { angleOfId, liveRing } = require('./ring');

/**
 * A ring seat as tracked by the table (angle derived from the id).
 * @typedef {{id: string, angle: number, lastSeen: number, country: (string|null)}} PeerSeat
 */

/**
 * Live peer bookkeeping: seats, direct-send channels, pins, and churn cooldowns.
 */
class PeerTable {
  #peers = new Map(); // id -> PeerSeat
  #senders = new Map(); // id -> direct-send fn (string) for connected peers
  #pinned = new Set(); // ids we've asked the swarm to keep connected (ring edges)
  #goneUntil = new Map(); // id -> ts: suppress re-seeding a just-closed peer (churn)
  #meId;
  #staleMs;

  /**
   * @param {Object} opts - Table options.
   * @param {string} opts.meId - My own hex peer id (self-sightings are ignored).
   * @param {number} opts.staleMs - Staleness window: a seat unseen for this long drops
   *   from the live ring; doubles as the disconnect cooldown duration.
   */
  constructor({ meId, staleMs }) {
    this.#meId = meId;
    this.#staleMs = staleMs;
  }

  /**
   * Insert or refresh a peer seat. Angle is always derived from the peer id, never
   * trusted from the wire. A fresher `lastSeen` replaces the seat (keeping a known
   * country unless the sighting carries one); a staler sighting may still update the
   * country (self-reported flag, purely cosmetic).
   * @param {string} id - Peer hex id (its Noise public key).
   * @param {number} lastSeen - Epoch ms of this sighting (drives staleness).
   * @param {string} [country] - Optional supported-nation code.
   * @returns {void}
   */
  upsert(id, lastSeen, country) {
    if (id === this.#meId) {
      return;
    }
    const cur = this.#peers.get(id);
    if (!cur || lastSeen > cur.lastSeen) {
      this.#peers.set(id, {
        id,
        angle: angleOfId(id),
        lastSeen,
        country: country ?? cur?.country ?? null
      });
    } else if (country && cur) {
      cur.country = country;
    }
  }

  /**
   * The current live ring: non-stale seats sorted clockwise by angle.
   * @param {number} [now] - Epoch ms to evaluate staleness at (defaults to Date.now()).
   * @returns {PeerSeat[]} The live seats, sorted by angle.
   */
  liveRing(now = Date.now()) {
    return liveRing([...this.#peers.values()], now, this.#staleMs);
  }

  /**
   * A peer connected: lift any churn cooldown, seat it, and remember its send channel.
   * @param {string} id - The connected peer's hex id.
   * @param {function(string): void} send - Its direct-send fn (JSON string frames).
   * @returns {void}
   */
  onConnect(id, send) {
    this.#goneUntil.delete(id); // reconnected — lift any churn cooldown
    this.upsert(id, Date.now());
    this.#senders.set(id, send);
  }

  /**
   * A peer disconnected: a direct disconnect is authoritative, so drop its channel and
   * seat immediately and start the churn cooldown (don't re-pin it yet).
   * @param {string} id - The disconnected peer's hex id.
   * @returns {{wasPinned: boolean}} Whether the dropped peer was pinned (drives an
   *   immediate pin top-up).
   */
  onDisconnect(id) {
    this.#senders.delete(id);
    this.#peers.delete(id);
    this.#goneUntil.set(id, Date.now() + this.#staleMs);
    return { wasPinned: this.#pinned.has(id) };
  }

  /**
   * Is this id inside its churn cooldown? (A just-disconnected peer: skip discovery
   * re-seeds so a ghost seat can't be resurrected.) Expired cooldowns are pruned as
   * they're checked.
   * @param {string} id - The peer hex id to check.
   * @param {number} [now] - Epoch ms to evaluate at (defaults to Date.now()).
   * @returns {boolean} True while the cooldown is active.
   */
  coolingDown(id, now = Date.now()) {
    const gone = this.#goneUntil.get(id);
    if (!gone) {
      return false;
    }
    if (now < gone) {
      return true;
    }
    this.#goneUntil.delete(id);
    return false;
  }

  /**
   * Diff the pinned set against the desired pin targets. The table updates `pinned`;
   * the caller mirrors the returned additions/removals into swarm.joinPeer/leavePeer
   * (side-effects stay outside).
   * @param {Set<string>} targets - The ids that should be pinned now.
   * @returns {{added: string[], removed: string[]}} The ids newly pinned / just unpinned.
   */
  updatePins(targets) {
    const added = [];
    const removed = [];
    for (const id of targets) {
      if (!this.#pinned.has(id)) {
        this.#pinned.add(id);
        added.push(id);
      }
    }
    for (const id of this.#pinned) {
      if (!targets.has(id)) {
        this.#pinned.delete(id);
        removed.push(id);
      }
    }
    return { added, removed };
  }

  /**
   * The direct-send fn for a connected peer, or undefined.
   * @param {string} id - The peer hex id.
   * @returns {(function(string): void)|undefined} Its send fn, if connected.
   */
  send(id) {
    return this.#senders.get(id);
  }

  /**
   * Ids of all directly-connected peers.
   * @returns {IterableIterator<string>} The connected ids.
   */
  senderIds() {
    return this.#senders.keys();
  }

  /**
   * [id, send] entries of all direct channels (broadcast / relay fan-out).
   * @returns {IterableIterator<[string, function(string): void]>} The channel entries.
   */
  senderEntries() {
    return this.#senders.entries();
  }

  /**
   * Ids of every seated peer (live or not-yet-stale).
   * @returns {IterableIterator<string>} The seated ids.
   */
  peerIds() {
    return this.#peers.keys();
  }

  /**
   * Ids of the pinned peers.
   * @returns {IterableIterator<string>} The pinned ids.
   */
  pinnedIds() {
    return this.#pinned.values();
  }
}

module.exports = { PeerTable };
