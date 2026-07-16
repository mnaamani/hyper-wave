// The gossip message seam: the single definition point for every on-wire message kind
// (protocol.md §5). Each kind has a `make*` factory (used at every send site, so a shape
// can't drift per call site) and a shape validator (run once at the receive edge, so
// handlers downstream can trust field presence and types). Validation here is SHAPE ONLY
// — the envelope signature (attest.verifyMessage), the age check, the paid gate, and
// hostile-value clamps are semantics and stay in the handlers (wave.js) and attest.js.
// Unknown extra fields are tolerated (forward compat); unknown kinds are rejected. Pure —
// no state, no I/O. Unit-tested in messages.test.js.
//
// UNIFORM ENVELOPE (protocol.md §5.0): every message carries `origin` (the author's ring id,
// hex), `ts` (author timestamp, ms), and `sig` (an Ed25519 signature by `origin` over the whole
// message minus `sig` — attest.signMessage). Factories build the KIND + PAYLOAD; the envelope is
// stamped at wave.js's single origination point (which holds the ring key). So there is no
// per-kind author field — `origin` is the author everywhere — except wave-sync's `by`, which
// names the wave INITIATOR (payload) distinct from the sync's sender (`origin`).

/**
 * Any gossip message: the envelope (`origin`/`ts`/`sig`) + `kind` + that kind's payload (protocol.md §5).
 * @typedef {Object} GossipMessage
 * @property {string} kind - The message kind (one of the six below).
 * @property {string} [origin] - The author's ring id (hex); stamped by wave.js at origination.
 * @property {number} [ts] - The author's timestamp (ms); enables the receive-edge age bound.
 * @property {string} [sig] - The envelope signature by `origin` (attest.signMessage / verifyMessage).
 * @property {string} [mid] - Flood-dedup id (stamped on flooded kinds at origination).
 */

/**
 * A participant's feed-core credential as carried in `writers` (protocol.md §5).
 * @typedef {Object} WriterCred
 * @property {string} peerId - The participant's ring id (64 hex chars).
 * @property {string} writerKey - Its feed core key (64 hex chars).
 * @property {string} joinSig - Its join attestation signature (hex).
 */

// Kinds that are flooded (relayed hop-to-hop with `mid` dedup) rather than one-hop.
// wave-sync is unicast (join-time catch-up) and heartbeat/subs are one-hop; none carry
// a `mid`. wave-announce floods the whole directory; wave-join/wave-start flood only the
// subscribed subgraph of their wave (Phase 3 scoping) — the `mid` dedup is identical either way.
const FLOODED_KINDS = new Set(['wave-announce', 'wave-join', 'wave-start']);

const HEX_RE = /^[0-9a-f]+$/;

/**
 * Is `value` a lowercase hex string of exactly `length` chars?
 * @param {*} value - The candidate value.
 * @param {number} length - Required string length.
 * @returns {boolean} True if it is.
 */
function isHex(value, length) {
  return (
    typeof value === 'string' && value.length === length && HEX_RE.test(value)
  );
}

/** @param {*} value - Candidate. @returns {boolean} A 32-byte id/key as 64 hex chars. */
function isId(value) {
  return isHex(value, 64);
}

/** @param {*} value - Candidate. @returns {boolean} A 16-byte wave id as 32 hex chars. */
function isWaveId(value) {
  return isHex(value, 32);
}

/** @param {*} value - Candidate. @returns {boolean} An 8-byte flood mid as 16 hex chars. */
function isMid(value) {
  return isHex(value, 16);
}

/** @param {*} value - Candidate. @returns {boolean} A non-empty lowercase hex string (signature). */
function isSig(value) {
  return typeof value === 'string' && value.length > 0 && HEX_RE.test(value);
}

/** @param {*} value - Candidate. @returns {boolean} A finite number ≥ 0. */
function isMillis(value) {
  return Number.isFinite(value) && value >= 0;
}

/** @param {*} value - Candidate. @returns {boolean} Absent, or a plain object (attestations). */
function isOptionalObject(value) {
  return value === undefined || (typeof value === 'object' && value !== null);
}

/** @param {*} value - Candidate. @returns {boolean} Absent/null, or a short tag code. */
function isTag(value) {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.length <= 8)
  );
}

/**
 * Is this a well-formed feed-core credential (a `writers` entry)?
 * @param {*} entry - The candidate credential.
 * @returns {boolean} True if `{peerId, writerKey, joinSig}` are all well-typed.
 */
function isWriterCred(entry) {
  return (
    !!entry &&
    isId(entry.peerId) &&
    isId(entry.writerKey) &&
    isSig(entry.joinSig)
  );
}

/** @param {*} value - Candidate. @returns {boolean} An array of well-formed credentials. */
function isWriters(value) {
  return Array.isArray(value) && value.every(isWriterCred);
}

/** @param {*} value - Candidate. @returns {boolean} An array of wave ids (the `subs` set). */
function isWaveIdList(value) {
  return Array.isArray(value) && value.every(isWaveId);
}

// One PAYLOAD validator per kind (the envelope — origin/ts/sig, + mid on flooded kinds — is
// checked once by validGossip, so these only cover the kind's own fields). The author is the
// envelope's `origin`, so no kind carries a separate id/by/peerId — EXCEPT `wave-sync`, whose
// `by` is the wave INITIATOR (payload; distinct from `origin`, the peer that sent the sync).
const VALIDATORS = {
  heartbeat: (msg) => isTag(msg.tag),

  // subs: this peer's subscription set (which waves it holds cores for). One-hop — a neighbour
  // uses it to scope which waves' join/start/sync it forwards here (Phase 3).
  subs: (msg) => isWaveIdList(msg.subs),

  'wave-announce': (msg) =>
    isWaveId(msg.waveId) && isMillis(msg.lobbyMs) && isOptionalObject(msg.paid),

  // origin (the joiner) + writerKey + joinSig are the feed-core credential; origin is the peerId.
  'wave-join': (msg) =>
    isWaveId(msg.waveId) &&
    isId(msg.writerKey) &&
    isSig(msg.joinSig) &&
    isOptionalObject(msg.burn),

  'wave-start': (msg) =>
    isWaveId(msg.waveId) &&
    isWriters(msg.writers) &&
    isMillis(msg.t0) &&
    isMillis(msg.lapMs) &&
    isOptionalObject(msg.paid),

  'wave-sync': (msg) =>
    isWaveId(msg.waveId) &&
    isId(msg.by) && // the wave initiator (payload) — NOT origin (the sync's sender)
    (msg.phase === 'lobby' || msg.phase === 'racing') &&
    isWriters(msg.writers) &&
    (msg.t0 === undefined || isMillis(msg.t0)) &&
    (msg.lapMs === undefined || isMillis(msg.lapMs)) &&
    isMillis(msg.lobbyMsLeft) &&
    isOptionalObject(msg.paid)
};

/**
 * Does the message carry a well-typed uniform envelope? Every gossip message has `origin` (the
 * author's ring id), `ts` (author timestamp), and `sig` (the envelope signature — verified
 * separately, in attest.verifyMessage; here we only check it's present + hex).
 * @param {Object} msg - The parsed message.
 * @returns {boolean} True if the envelope fields are well-typed.
 */
function hasEnvelope(msg) {
  return isId(msg.origin) && isMillis(msg.ts) && isSig(msg.sig);
}

/**
 * Shape-validate an inbound gossip message: known kind + a well-typed envelope (+ a `mid` on
 * flooded kinds) + that kind's required payload fields. Run once at the receive edge (before the
 * envelope signature / age / state work) so every handler downstream can trust the shape. Extra
 * fields are tolerated.
 * @param {*} msg - The parsed inbound message.
 * @returns {boolean} True if the message is a well-formed known kind.
 */
function validGossip(msg) {
  if (!msg || typeof msg !== 'object') {
    return false;
  }
  const validator = VALIDATORS[msg.kind];
  if (!validator) {
    return false;
  }
  if (!hasEnvelope(msg)) {
    return false;
  }
  if (FLOODED_KINDS.has(msg.kind) && !isMid(msg.mid)) {
    return false;
  }
  return validator(msg);
}

// --- factories (one per kind — every send site builds through these) ---------
// Factories build the KIND + PAYLOAD only. The envelope (`origin`, `ts`, `sig`, and the `mid`
// on flooded kinds) is stamped at the single origination choke point in wave.js (which holds
// the ring key), so the author is never threaded through a factory — `origin` is always the
// originating peer. The one exception is wave-sync's `by` (the wave initiator, payload).

/**
 * Build a heartbeat: pure liveness + cosmetic tag, one hop per connection.
 * @param {Object} fields - The heartbeat fields.
 * @param {string|null} [fields.tag] - My tag code (cosmetic).
 * @returns {GossipMessage} The heartbeat message (pre-envelope).
 */
function makeHeartbeat({ tag }) {
  return { kind: 'heartbeat', tag: tag || null };
}

/**
 * Build a subs message: the waves this peer is subscribed to (holds cores for). A neighbour scopes
 * which waves' join/start/sync it forwards to me by this set. One-hop (sent on connect + on change).
 * @param {Object} fields - The subs fields.
 * @param {string[]} fields.subs - The subscribed wave ids.
 * @returns {GossipMessage} The subs message (pre-envelope).
 */
function makeSubs({ subs }) {
  return { kind: 'subs', subs };
}

/**
 * Build a wave-announce: opens the lobby (flooded). `origin` (the envelope) is the initiator.
 * @param {Object} fields - The announce fields.
 * @param {string} fields.waveId - The new wave's id.
 * @param {number} fields.lobbyMs - Lobby window length in ms.
 * @param {Object|null} [fields.paid] - The signed start burn proof (paid path).
 * @returns {GossipMessage} The wave-announce message (pre-envelope).
 */
function makeWaveAnnounce({ waveId, lobbyMs, paid }) {
  return {
    kind: 'wave-announce',
    waveId,
    lobbyMs,
    ...(paid ? { paid } : {})
  };
}

/**
 * Build a wave-join: publishes the joiner's own feed core (flooded). `origin` (the envelope) is
 * the joiner's ring id — the join attestation binds (waveId, origin, writerKey).
 * @param {Object} fields - The join fields.
 * @param {string} fields.waveId - The wave being joined.
 * @param {string} fields.writerKey - The joiner's feed core key (hex).
 * @param {string} fields.joinSig - The join attestation over (waveId, origin, writerKey).
 * @param {Object|null} [fields.burn] - The joiner's burn attestation (paid gate), if confirmed.
 * @returns {GossipMessage} The wave-join message (pre-envelope).
 */
function makeWaveJoin({ waveId, writerKey, joinSig, burn }) {
  return {
    kind: 'wave-join',
    waveId,
    writerKey,
    joinSig,
    ...(burn ? { burn } : {})
  };
}

/**
 * Build a wave-start: the frozen writers set + sweep parameters (flooded). `origin` (the
 * envelope) is the initiator; the roster is derived as {origin} ∪ writers[].peerId.
 * @param {Object} fields - The start fields.
 * @param {string} fields.waveId - The starting wave's id.
 * @param {WriterCred[]} fields.writers - Every participant's feed-core credential.
 * @param {number} fields.t0 - Epoch ms the sweep starts.
 * @param {number} fields.lapMs - Duration of the full lap.
 * @param {Object|null} [fields.paid] - The start proof (so start-adopters can re-sync).
 * @returns {GossipMessage} The wave-start message (pre-envelope).
 */
function makeWaveStart({ waveId, writers, t0, lapMs, paid }) {
  return {
    kind: 'wave-start',
    waveId,
    writers,
    t0,
    lapMs,
    ...(paid ? { paid } : {})
  };
}

/**
 * Build a wave-sync: catch-up state, unicast to a mutually-subscribed neighbour. `origin` (the
 * envelope) is the SENDER of the sync; `by` is the wave INITIATOR (payload — the roster is
 * derived as {by} ∪ writers[].peerId, and the initiator signed the `paid` proof).
 * @param {Object} fields - The sync fields.
 * @param {string} fields.waveId - The engaged wave's id.
 * @param {'lobby'|'racing'} fields.phase - The wave's current phase.
 * @param {string} fields.by - The wave initiator's ring id.
 * @param {WriterCred[]} fields.writers - Every participant's feed-core credential.
 * @param {number} [fields.t0] - Sweep start (racing), so a newcomer animates + ends right.
 * @param {number} [fields.lapMs] - Lap duration (racing).
 * @param {Object|null} [fields.paid] - The start proof (so the newcomer can verify + join).
 * @param {number} fields.lobbyMsLeft - Lobby time remaining in ms (0 when racing).
 * @returns {GossipMessage} The wave-sync message (pre-envelope).
 */
function makeWaveSync({
  waveId,
  phase,
  by,
  writers,
  t0,
  lapMs,
  paid,
  lobbyMsLeft
}) {
  return {
    kind: 'wave-sync',
    waveId,
    phase,
    by,
    writers,
    ...(t0 !== undefined ? { t0 } : {}),
    ...(lapMs !== undefined ? { lapMs } : {}),
    ...(paid ? { paid } : {}),
    lobbyMsLeft
  };
}

module.exports = {
  FLOODED_KINDS,
  validGossip,
  makeHeartbeat,
  makeSubs,
  makeWaveAnnounce,
  makeWaveJoin,
  makeWaveStart,
  makeWaveSync
};
