// The gossip message seam: the single definition point for every on-wire message kind
// (protocol.md §5). Each kind has a `make*` factory (used at every send site, so a shape
// can't drift per call site) and a shape validator (run once at the receive edge, so
// handlers downstream can trust field presence and types). Validation here is SHAPE ONLY
// — signatures, the paid gate, and hostile-value clamps are semantics and stay in the
// handlers (wave.js) and attest.js. Unknown extra fields are tolerated (forward compat);
// unknown kinds are rejected. Pure — no state, no I/O. Unit-tested in messages.test.js.

/**
 * Any gossip message: a `kind` plus that kind's fields (see protocol.md §5).
 * @typedef {Object} GossipMessage
 * @property {string} kind - The message kind (one of the six below).
 * @property {string} [mid] - Flood-dedup id (stamped by floodGossip on flooded kinds).
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

// One shape validator per kind. Flooded kinds require their `mid` (so the dedup/relay
// decision never sees a mid-less flood); direct kinds simply don't check it.
const VALIDATORS = {
  heartbeat: (msg) => isId(msg.id) && isTag(msg.tag),

  // subs: this peer's subscription set (which waves it holds cores for). One-hop, no mid — a
  // neighbour uses it to scope which waves' join/start/sync it forwards here (Phase 3).
  subs: (msg) => isWaveIdList(msg.subs),

  'wave-announce': (msg) =>
    isMid(msg.mid) &&
    isWaveId(msg.waveId) &&
    isId(msg.by) &&
    isMillis(msg.lobbyMs) &&
    isOptionalObject(msg.paid),

  'wave-join': (msg) =>
    isMid(msg.mid) &&
    isWaveId(msg.waveId) &&
    isWriterCred(msg) && // peerId + writerKey + joinSig live top-level on the join
    isOptionalObject(msg.burn),

  'wave-start': (msg) =>
    isMid(msg.mid) &&
    isWaveId(msg.waveId) &&
    isId(msg.by) &&
    isWriters(msg.writers) &&
    isMillis(msg.t0) &&
    isMillis(msg.lapMs) &&
    isOptionalObject(msg.paid),

  'wave-sync': (msg) =>
    isWaveId(msg.waveId) &&
    isId(msg.by) &&
    (msg.phase === 'lobby' || msg.phase === 'racing') &&
    isWriters(msg.writers) &&
    (msg.t0 === undefined || isMillis(msg.t0)) &&
    (msg.lapMs === undefined || isMillis(msg.lapMs)) &&
    isMillis(msg.lobbyMsLeft) &&
    isOptionalObject(msg.paid)
};

/**
 * Shape-validate an inbound gossip message: known kind + that kind's required fields,
 * well-typed. Run once at the receive edge (before any signature or state work) so every
 * handler downstream can trust the shape. Extra fields are tolerated.
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
  return validator(msg);
}

// --- factories (one per kind — every send site builds through these) ---------

/**
 * Build a heartbeat: pure liveness + cosmetic tag, one hop per connection.
 * @param {Object} fields - The heartbeat fields.
 * @param {string} fields.id - My ring id (hex).
 * @param {string|null} [fields.tag] - My tag code (cosmetic).
 * @returns {GossipMessage} The heartbeat message.
 */
function makeHeartbeat({ id, tag }) {
  return { kind: 'heartbeat', id, tag: tag || null };
}

/**
 * Build a subs message: the waves this peer is subscribed to (holds cores for). A neighbour scopes
 * which waves' join/start/sync it forwards to me by this set. One-hop (sent on connect + on change).
 * @param {Object} fields - The subs fields.
 * @param {string[]} fields.subs - The subscribed wave ids.
 * @returns {GossipMessage} The subs message.
 */
function makeSubs({ subs }) {
  return { kind: 'subs', subs };
}

/**
 * Build a wave-announce: opens the lobby (flooded; floodGossip stamps the mid).
 * @param {Object} fields - The announce fields.
 * @param {string} fields.waveId - The new wave's id.
 * @param {string} fields.by - The initiator's ring id.
 * @param {number} fields.lobbyMs - Lobby window length in ms.
 * @param {Object|null} [fields.paid] - The signed start burn proof (paid path).
 * @returns {GossipMessage} The wave-announce message.
 */
function makeWaveAnnounce({ waveId, by, lobbyMs, paid }) {
  return {
    kind: 'wave-announce',
    waveId,
    by,
    lobbyMs,
    ...(paid ? { paid } : {})
  };
}

/**
 * Build a wave-join: publishes the joiner's own feed core (flooded).
 * @param {Object} fields - The join fields.
 * @param {string} fields.waveId - The wave being joined.
 * @param {string} fields.peerId - The joiner's ring id.
 * @param {string} fields.writerKey - The joiner's feed core key (hex).
 * @param {string} fields.joinSig - The join attestation over (waveId, peerId, writerKey).
 * @param {Object|null} [fields.burn] - The joiner's burn attestation (paid gate), if confirmed.
 * @returns {GossipMessage} The wave-join message.
 */
function makeWaveJoin({ waveId, peerId, writerKey, joinSig, burn }) {
  return {
    kind: 'wave-join',
    waveId,
    peerId,
    writerKey,
    joinSig,
    ...(burn ? { burn } : {})
  };
}

/**
 * Build a wave-start: the frozen writers set + sweep parameters (flooded). The roster
 * is derived by receivers as {by} ∪ writers[].peerId — it does not travel.
 * @param {Object} fields - The start fields.
 * @param {string} fields.waveId - The starting wave's id.
 * @param {string} fields.by - The initiator's ring id.
 * @param {WriterCred[]} fields.writers - Every participant's feed-core credential.
 * @param {number} fields.t0 - Epoch ms the sweep starts.
 * @param {number} fields.lapMs - Duration of the full lap.
 * @param {Object|null} [fields.paid] - The start proof (so start-adopters can re-sync).
 * @returns {GossipMessage} The wave-start message.
 */
function makeWaveStart({ waveId, by, writers, t0, lapMs, paid }) {
  return {
    kind: 'wave-start',
    waveId,
    by,
    writers,
    t0,
    lapMs,
    ...(paid ? { paid } : {})
  };
}

/**
 * Build a wave-sync: join-time catch-up state, unicast to a newcomer on connect.
 * @param {Object} fields - The sync fields.
 * @param {string} fields.waveId - The engaged wave's id.
 * @param {'lobby'|'racing'} fields.phase - The wave's current phase.
 * @param {string} fields.by - The initiator's ring id.
 * @param {WriterCred[]} fields.writers - Every participant's feed-core credential.
 * @param {number} [fields.t0] - Sweep start (racing), so a newcomer animates + ends right.
 * @param {number} [fields.lapMs] - Lap duration (racing).
 * @param {Object|null} [fields.paid] - The start proof (so the newcomer can verify + join).
 * @param {number} fields.lobbyMsLeft - Lobby time remaining in ms (0 when racing).
 * @returns {GossipMessage} The wave-sync message.
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
