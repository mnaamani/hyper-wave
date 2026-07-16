// The live peer table: who is on the ring and who we can reach directly. Extracted
// from wave.js so the consistency rules across these collections live in one place:
//   - a seat's angle is ALWAYS derived from its id (never trusted from the wire);
//   - a fresher sighting wins; a stale one may still contribute its tag;
//   - a direct disconnect is authoritative: the seat is dropped immediately (DHT
//     discovery never seeds a seat, so a stale announce can't resurrect a ghost —
//     seats come only from live connections and gossip).
// Pure bookkeeping — no swarm, no transport, no timers.
const { angleOfId, liveRing } = require('./ring');

/**
 * A ring seat as tracked by the table (angle derived from the id).
 * @typedef {{id: string, angle: number, lastSeen: number, tag: (string|null)}} PeerSeat
 */

/**
 * Live peer bookkeeping: seats and direct-send channels.
 */
class PeerTable {
  #peers = new Map(); // id -> PeerSeat
  #senders = new Map(); // id -> direct-send fn (string) for connected peers
  #meId;
  #staleMs;

  /**
   * @param {Object} opts - Table options.
   * @param {string} opts.meId - My own hex peer id (self-sightings are ignored).
   * @param {number} opts.staleMs - Staleness window: a seat unseen for this long drops
   *   from the live ring.
   */
  constructor({ meId, staleMs }) {
    this.#meId = meId;
    this.#staleMs = staleMs;
  }

  /**
   * Insert or refresh a peer seat. Angle is always derived from the peer id, never
   * trusted from the wire. A fresher `lastSeen` replaces the seat (keeping a known
   * tag unless the sighting carries one); a staler sighting may still update the
   * tag (self-reported flag, purely cosmetic).
   * @param {string} id - Peer hex id (its Noise public key).
   * @param {number} lastSeen - Epoch ms of this sighting (drives staleness).
   * @param {string} [tag] - Optional tag code.
   * @returns {void}
   */
  upsert(id, lastSeen, tag) {
    if (id === this.#meId) {
      return;
    }
    const cur = this.#peers.get(id);
    if (!cur || lastSeen > cur.lastSeen) {
      this.#peers.set(id, {
        id,
        angle: angleOfId(id),
        lastSeen,
        tag: tag ?? cur?.tag ?? null
      });
    } else if (tag && cur) {
      cur.tag = tag;
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
   * A peer connected: seat it and remember its send channel.
   * @param {string} id - The connected peer's hex id.
   * @param {function(string): void} send - Its direct-send fn (JSON string frames).
   * @returns {void}
   */
  onConnect(id, send) {
    this.upsert(id, Date.now());
    this.#senders.set(id, send);
  }

  /**
   * A peer disconnected: a direct disconnect is authoritative, so drop its channel and
   * seat immediately.
   * @param {string} id - The disconnected peer's hex id.
   * @returns {void}
   */
  onDisconnect(id) {
    this.#senders.delete(id);
    this.#peers.delete(id);
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
   * The direct-send fn for one connected peer (unicast, e.g. a wave-sync catch-up), or undefined.
   * @param {string} id - The peer's connection id.
   * @returns {(function(string): void)|undefined} Its send fn, or undefined if not connected.
   */
  senderOf(id) {
    return this.#senders.get(id);
  }
}

module.exports = { PeerTable };
