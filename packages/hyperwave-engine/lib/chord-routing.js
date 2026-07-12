// Distributed findSuccessor routing over the gossip mesh (Chord §4.5), extracted from wave.js so
// the wave engine stays focused on the ring/token/gallery. It locates the true successor of a
// keyspace position by routing a query through fingers — correct even when no single peer knows
// the whole ring — plus the one-shot join-time self-placement and the periodic successor repair.
// Pure Chord MATH lives in chord.js; this is the NETWORK-driven orchestration. wave.js constructs
// it with a ctx of shared ring state + accessors and drives it through the public methods; all
// the routing state (in-flight lookups, reverse paths, routing-discovered pin candidates) lives
// in private fields.
const b4a = require('b4a');
const crypto = require('hypercore-crypto');
const {
  findSuccessorStep,
  closestPrecedingNode,
  nodeIdOfHex,
  RING
} = require('./chord');
const { nextClockwise } = require('./ring');

/**
 * The context of the shared peer table + accessors that wave.js hands the routing layer.
 * The table is shared by reference so this module sees wave.js's live view.
 * @typedef {Object} ChordRoutingCtx
 * @property {{id: string, angle: number}} me - my own peer identity (hex id + ring angle).
 * @property {import('./peer-table').PeerTable} table - the live peer table (seats, channels, pins).
 * @property {function(string, Object): boolean} trySend - direct one-hop gossip send; returns whether it went out.
 * @property {function(): void} maintainNeighbours - re-pin ring edges (called when repair surfaces a truer successor).
 * @property {function(...*): void} log - diagnostic logger.
 */

const LOOKUP_TTL = 24; // max routing hops for a findSuccessor query (safety cap; O(log N) expected)
const LOOKUP_TIMEOUT_MS = 5000; // how long the origin waits for a lookup reply
const PIN_CANDIDATE_MS = 30000; // how long a routing-discovered successor stays a pin candidate
const BOOTSTRAP_MS = 1500; // after my first connection, wait this long before self-placement

/**
 * The distributed findSuccessor routing control plane. All routing state (in-flight lookups,
 * reverse paths, routing-discovered pin candidates) lives in private fields; the shared ring
 * state arrives by reference through the ctx.
 */
class ChordRouting {
  // shared peer table + accessors (ctx, by reference — wave.js's live view)
  #me;
  #table;
  #trySend;
  #maintainNeighbours;
  #log;
  // routing state
  #routed = new Map(); // id -> expiry: successor found via lookup (a pin candidate)
  #pendingLookups = new Map(); // qid -> { resolve, timer }: lookups I originated
  #lookupRoute = new Map(); // qid -> upstream id: reverse path to return a reply
  #bootstrapTimer = null; // one-shot join-time findSuccessor placement
  #bootstrapDone = false;

  /**
   * @param {ChordRoutingCtx} ctx - accessor closures + shared ring state (see typedef).
   */
  constructor({ me, table, trySend, maintainNeighbours, log }) {
    this.#me = me;
    this.#table = table;
    this.#trySend = trySend;
    this.#maintainNeighbours = maintainNeighbours;
    this.#log = log;
  }

  /**
   * My current successor id (next reachable clockwise) — one input to Chord's per-hop
   * routing decision.
   * @returns {(string|null)} my successor's hex id, or null if I have no live peers.
   */
  #mySuccessorId() {
    const succ = nextClockwise(this.#me.angle, this.#table.liveRing());
    return succ ? succ.id : null;
  }

  /**
   * Locate the true successor of a keyspace position by routing the query through fingers. The
   * request hops along connected fingers (findSuccessorStep chooses the next); the reply retraces
   * the same path back to the origin.
   * @param {(bigint|string)} target - the keyspace position, or a hex peer id whose ring position is used.
   * @returns {Promise<(string|null)>} the successor's hex id, or null on timeout / no peers.
   */
  findSuccessor(target) {
    const targetNid = typeof target === 'bigint' ? target : nodeIdOfHex(target);
    return new Promise((resolve) => {
      const start =
        closestPrecedingNode(this.#table.knownIds(), this.#me.id, targetNid) ||
        this.#mySuccessorId();
      if (!start || !this.#table.hasSender(start)) {
        resolve(null); // nobody to ask
        return;
      }
      const qid = b4a.toString(crypto.randomBytes(8), 'hex');
      const timer = setTimeout(() => {
        this.#pendingLookups.delete(qid);
        resolve(null);
      }, LOOKUP_TIMEOUT_MS);
      this.#pendingLookups.set(qid, { resolve, timer });
      if (
        !this.#trySend(start, {
          kind: 'find-succ',
          qid,
          target: targetNid.toString(),
          hops: 0
        })
      ) {
        clearTimeout(timer);
        this.#pendingLookups.delete(qid);
        resolve(null);
      }
    });
  }

  /**
   * A find-succ request reached me: answer if the target falls in (me, successor], else
   * forward to my closest preceding finger, remembering the upstream for the reply.
   * @param {Object} msg - the find-succ message ({ qid, target, hops }).
   * @param {string} fromId - the hex id of the peer that sent it to me (the reply upstream).
   * @returns {void}
   */
  handleFindSucc(msg, fromId) {
    let target;
    try {
      target = BigInt(msg.target);
    } catch {
      return;
    }
    const step = findSuccessorStep({
      me: this.#me.id,
      successor: this.#mySuccessorId(),
      known: this.#table.knownIds(),
      target
    });
    if (step.done || (msg.hops || 0) >= LOOKUP_TTL) {
      this.#trySend(fromId, {
        kind: 'find-succ-reply',
        qid: msg.qid,
        successor: step.done ? step.successor : this.#mySuccessorId()
      });
      return;
    }
    if (!this.#table.hasSender(step.next)) {
      this.#trySend(fromId, {
        kind: 'find-succ-reply',
        qid: msg.qid,
        successor: this.#mySuccessorId()
      });
      return;
    }
    this.#lookupRoute.set(msg.qid, fromId);
    setTimeout(() => this.#lookupRoute.delete(msg.qid), LOOKUP_TIMEOUT_MS);
    this.#trySend(step.next, {
      kind: 'find-succ',
      qid: msg.qid,
      target: msg.target,
      hops: (msg.hops || 0) + 1
    });
  }

  /**
   * A find-succ-reply reached me: resolve it if I'm the origin, else pass it back up the
   * reverse path toward whoever asked me.
   * @param {Object} msg - the find-succ-reply message ({ qid, successor }).
   * @returns {void}
   */
  handleFindSuccReply(msg) {
    const pend = this.#pendingLookups.get(msg.qid);
    if (pend) {
      clearTimeout(pend.timer);
      this.#pendingLookups.delete(msg.qid);
      pend.resolve(msg.successor || null);
      return;
    }
    const up = this.#lookupRoute.get(msg.qid);
    if (up) {
      this.#lookupRoute.delete(msg.qid);
      this.#trySend(up, msg);
    }
  }

  /**
   * Chord repair: verify my successor via distributed routing and, if the lookup surfaces a truer
   * successor my local view missed (a node between me and who I think is next), add it as a pin
   * candidate so maintainNeighbours connects to it. Additive and safe: a no-op at small scale
   * (local knowledge already resolves the lookup with no hops).
   * @returns {Promise<void>} resolves when the repair lookup completes.
   */
  async repairSuccessor() {
    if (this.#table.senderCount === 0) {
      return;
    }
    const succId = await this.findSuccessor(
      (nodeIdOfHex(this.#me.id) + 1n) % RING
    );
    if (succId && succId !== this.#me.id && !this.#table.hasSender(succId)) {
      this.#routed.set(succId, Date.now() + PIN_CANDIDATE_MS);
      this.#maintainNeighbours();
    }
  }

  /**
   * Chord join (§4.5): once I have my first connection(s), place myself in the ring by asking an
   * already-connected peer to route findSuccessor(me) — so a joiner finds its true successor via
   * O(log N) routing even when its own DHT sample is incomplete, instead of waiting for the slow
   * periodic repair. One-shot per connected session; re-armed (markSolo) if I go solo.
   * @returns {void}
   */
  scheduleBootstrap() {
    if (this.#bootstrapDone || this.#bootstrapTimer) {
      return;
    }
    this.#bootstrapTimer = setTimeout(() => {
      this.#bootstrapTimer = null;
      this.#bootstrapDone = true;
      this.#log('join: placing myself via findSuccessor');
      this.repairSuccessor().catch(() => {});
    }, BOOTSTRAP_MS);
  }

  /**
   * I went solo (lost all connections) — re-arm the join-time placement for when I reconnect.
   * @returns {void}
   */
  markSolo() {
    this.#bootstrapDone = false;
  }

  /**
   * Pin candidates discovered via routing (expired ones pruned) — maintainNeighbours dials these
   * in addition to its local ring neighbours.
   * @returns {string[]} the currently-valid routing-discovered candidate hex ids.
   */
  pinCandidates() {
    const now = Date.now();
    for (const [id, exp] of this.#routed) {
      if (exp <= now) {
        this.#routed.delete(id);
      }
    }
    return [...this.#routed.keys()];
  }

  /**
   * Tear down all timers (bootstrap + any in-flight lookup timeouts).
   * @returns {void}
   */
  close() {
    clearTimeout(this.#bootstrapTimer);
    for (const { timer } of this.#pendingLookups.values()) {
      clearTimeout(timer);
    }
  }
}

module.exports = { ChordRouting };
