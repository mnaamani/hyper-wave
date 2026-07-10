// Distributed findSuccessor routing over the gossip mesh (Chord §4.5), extracted from wave.js so
// the wave engine stays focused on the ring/token/gallery. It locates the true successor of a
// keyspace position by routing a query through fingers — correct even when no single peer knows
// the whole ring — plus the one-shot join-time self-placement and the periodic successor repair.
// Pure Chord MATH lives in chord.js; this is the NETWORK-driven orchestration. wave.js wires it
// via createChordRouting(ctx) and drives it through the returned methods; all the routing state
// (in-flight lookups, reverse paths, routing-discovered pin candidates) lives in here.
const b4a = require('b4a');
const crypto = require('hypercore-crypto');
const { findSuccessorStep, closestPrecedingNode, nodeIdOfHex, RING } = require('./chord');
const { liveRing, nextClockwise } = require('./ring');

/**
 * The context of accessor closures + shared ring state that wave.js hands the routing factory.
 * All ring-state properties are shared by reference so this module sees wave.js's live view.
 * @typedef {Object} ChordRoutingCtx
 * @property {{id: string, angle: number}} me - my own peer identity (hex id + ring angle).
 * @property {Map<string, Object>} peers - the live peer table (id -> peer record), by reference.
 * @property {Map<string, Function>} senders - id -> direct-send closure for currently connected peers.
 * @property {Set<string>} pinned - the ids wave.js is deliberately keeping connected, by reference.
 * @property {number} staleMs - peer-staleness window (PEER_STALE_MS) for the local ring snapshot.
 * @property {function(string, Object): boolean} trySend - direct one-hop gossip send; returns whether it went out.
 * @property {function(): void} maintainNeighbours - re-pin ring edges (called when repair surfaces a truer successor).
 * @property {function(...*): void} log - diagnostic logger.
 */

/**
 * The control-plane surface returned by {@link createChordRouting}.
 * @typedef {Object} ChordRouting
 * @property {function((bigint|string)): Promise<(string|null)>} findSuccessor - route a distributed findSuccessor lookup.
 * @property {function(Object, string): void} handleFindSucc - handle an incoming find-succ request.
 * @property {function(Object): void} handleFindSuccReply - handle an incoming find-succ-reply.
 * @property {function(): Promise<void>} repairSuccessor - verify/repair my successor via routing.
 * @property {function(): void} scheduleBootstrap - arm the one-shot join-time self-placement.
 * @property {function(): void} markSolo - re-arm placement after losing all connections.
 * @property {function(): string[]} pinCandidates - routing-discovered pin candidate ids (pruned).
 * @property {function(): void} close - tear down all timers.
 */

const LOOKUP_TTL = 24; // max routing hops for a findSuccessor query (safety cap; O(log N) expected)
const LOOKUP_TIMEOUT_MS = 5000; // how long the origin waits for a lookup reply
const PIN_CANDIDATE_MS = 30000; // how long a routing-discovered successor stays a pin candidate
const BOOTSTRAP_MS = 1500; // after my first connection, wait this long before self-placement

// ctx: {
//   me, peers, senders, pinned,  // shared ring state, by reference
//   staleMs,                     // peer-staleness window (PEER_STALE_MS) for the local ring snapshot
//   trySend,                     // (id, obj) => bool — direct one-hop gossip send
//   maintainNeighbours,          // re-pin ring edges (called when repair surfaces a truer succ)
//   log
// }
/**
 * Build the distributed findSuccessor routing control plane. All routing state (in-flight
 * lookups, reverse paths, routing-discovered pin candidates) lives inside the returned closure.
 * @param {ChordRoutingCtx} ctx - accessor closures + shared ring state (see typedef).
 * @returns {ChordRouting} the routing methods wave.js drives.
 */
function createChordRouting(ctx) {
  const { me, peers, senders, pinned, staleMs, trySend, maintainNeighbours, log } = ctx;
  const routed = new Map(); // id -> expiry: successor found via lookup (a pin candidate)
  const pendingLookups = new Map(); // qid -> { resolve, timer }: lookups I originated
  const lookupRoute = new Map(); // qid -> upstream id: reverse path to return a reply
  let bootstrapTimer = null; // one-shot join-time findSuccessor placement
  let bootstrapDone = false;

  /**
   * My current successor id (next reachable clockwise) — one input to Chord's per-hop
   * routing decision.
   * @returns {(string|null)} my successor's hex id, or null if I have no live peers.
   */
  function mySuccessorId() {
    const succ = nextClockwise(me.angle, liveRing([...peers.values()], Date.now(), staleMs));
    return succ ? succ.id : null;
  }
  /**
   * The finger + successor ids I currently know (pinned ∪ connected senders) — the other
   * input to Chord's per-hop routing decision.
   * @returns {string[]} the deduped known hex peer ids.
   */
  const myKnownIds = () => [...new Set([...pinned, ...senders.keys()])];

  /**
   * Locate the true successor of a keyspace position by routing the query through fingers. The
   * request hops along connected fingers (findSuccessorStep chooses the next); the reply retraces
   * the same path back to the origin.
   * @param {(bigint|string)} target - the keyspace position, or a hex peer id whose ring position is used.
   * @returns {Promise<(string|null)>} the successor's hex id, or null on timeout / no peers.
   */
  function findSuccessor(target) {
    const targetNid = typeof target === 'bigint' ? target : nodeIdOfHex(target);
    return new Promise((resolve) => {
      const start = closestPrecedingNode(myKnownIds(), me.id, targetNid) || mySuccessorId();
      if (!start || !senders.has(start)) {
        return resolve(null); // nobody to ask
      }
      const qid = b4a.toString(crypto.randomBytes(8), 'hex');
      const timer = setTimeout(() => {
        pendingLookups.delete(qid);
        resolve(null);
      }, LOOKUP_TIMEOUT_MS);
      pendingLookups.set(qid, { resolve, timer });
      if (!trySend(start, { kind: 'find-succ', qid, target: targetNid.toString(), hops: 0 })) {
        clearTimeout(timer);
        pendingLookups.delete(qid);
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
  function handleFindSucc(msg, fromId) {
    let target;
    try {
      target = BigInt(msg.target);
    } catch {
      return;
    }
    const step = findSuccessorStep(me.id, mySuccessorId(), myKnownIds(), target);
    if (step.done || (msg.hops || 0) >= LOOKUP_TTL) {
      trySend(fromId, {
        kind: 'find-succ-reply',
        qid: msg.qid,
        successor: step.done ? step.successor : mySuccessorId()
      });
      return;
    }
    if (!senders.has(step.next)) {
      trySend(fromId, { kind: 'find-succ-reply', qid: msg.qid, successor: mySuccessorId() });
      return;
    }
    lookupRoute.set(msg.qid, fromId);
    setTimeout(() => lookupRoute.delete(msg.qid), LOOKUP_TIMEOUT_MS);
    trySend(step.next, {
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
  function handleFindSuccReply(msg) {
    const pend = pendingLookups.get(msg.qid);
    if (pend) {
      clearTimeout(pend.timer);
      pendingLookups.delete(msg.qid);
      pend.resolve(msg.successor || null);
      return;
    }
    const up = lookupRoute.get(msg.qid);
    if (up) {
      lookupRoute.delete(msg.qid);
      trySend(up, msg);
    }
  }

  /**
   * Chord repair: verify my successor via distributed routing and, if the lookup surfaces a truer
   * successor my local view missed (a node between me and who I think is next), add it as a pin
   * candidate so maintainNeighbours connects to it. Additive and safe: a no-op at small scale
   * (local knowledge already resolves the lookup with no hops).
   * @returns {Promise<void>} resolves when the repair lookup completes.
   */
  async function repairSuccessor() {
    if (senders.size === 0) {
      return;
    }
    const succId = await findSuccessor((nodeIdOfHex(me.id) + 1n) % RING);
    if (succId && succId !== me.id && !senders.has(succId)) {
      routed.set(succId, Date.now() + PIN_CANDIDATE_MS);
      maintainNeighbours();
    }
  }

  /**
   * Chord join (§4.5): once I have my first connection(s), place myself in the ring by asking an
   * already-connected peer to route findSuccessor(me) — so a joiner finds its true successor via
   * O(log N) routing even when its own DHT sample is incomplete, instead of waiting for the slow
   * periodic repair. One-shot per connected session; re-armed (markSolo) if I go solo.
   * @returns {void}
   */
  function scheduleBootstrap() {
    if (bootstrapDone || bootstrapTimer) {
      return;
    }
    bootstrapTimer = setTimeout(() => {
      bootstrapTimer = null;
      bootstrapDone = true;
      log('join: placing myself via findSuccessor');
      repairSuccessor().catch(() => {});
    }, BOOTSTRAP_MS);
  }

  /**
   * I went solo (lost all connections) — re-arm the join-time placement for when I reconnect.
   * @returns {void}
   */
  const markSolo = () => {
    bootstrapDone = false;
  };

  /**
   * Pin candidates discovered via routing (expired ones pruned) — maintainNeighbours dials these
   * in addition to its local ring neighbours.
   * @returns {string[]} the currently-valid routing-discovered candidate hex ids.
   */
  function pinCandidates() {
    const now = Date.now();
    for (const [id, exp] of routed) {
      if (exp <= now) {
        routed.delete(id);
      }
    }
    return [...routed.keys()];
  }

  /**
   * Tear down all timers (bootstrap + any in-flight lookup timeouts).
   * @returns {void}
   */
  function close() {
    clearTimeout(bootstrapTimer);
    for (const { timer } of pendingLookups.values()) {
      clearTimeout(timer);
    }
  }

  return {
    findSuccessor,
    handleFindSucc,
    handleFindSuccReply,
    repairSuccessor,
    scheduleBootstrap,
    markSolo,
    pinCandidates,
    close
  };
}

module.exports = { createChordRouting };
