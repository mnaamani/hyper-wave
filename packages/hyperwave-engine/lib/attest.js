// Pure attestation crypto for the wave protocol: Ed25519 signatures binding a peer's
// ring identity to its fee burn (the paid-wave gate + tip-address binding) and to its
// wave join (the feed write credential). No state, no I/O — unit-tested in
// attest.test.js.
const crypto = require('hypercore-crypto');
const b4a = require('b4a');

/**
 * An Ed25519 keypair (from hypercore-crypto).
 * @typedef {{publicKey: Buffer, secretKey: Buffer}} KeyPair
 */

/**
 * The unsigned fields of a burn attestation bound by burnHash.
 * @typedef {Object} BurnFields
 * @property {string} waveId - The wave the burn is for.
 * @property {string} peerId - The ring peer id (hex) that signs the attestation.
 * @property {string} reason - Why the fee was burned (e.g. 'start', 'join').
 * @property {number} amount - The burned amount.
 * @property {string} txHash - The on-chain burn transaction hash.
 * @property {string} tronAddress - The Tron wallet that funded the burn.
 * @property {number} burnTs - The burn timestamp (ms).
 */

/**
 * A signed burn attestation: the burn fields plus the ring-key signature.
 * @typedef {BurnFields & {sig: string}} BurnProof
 */

// --- burn attestation ------------------------------------------------------
// Bridges the peer's RING identity (Ed25519) to its on-chain burn: the peer signs, with
// its ring key, a statement binding (waveId, peerId, reason, amount, txHash, tronAddress).
// The Tron key that signed the burn is a *different* keypair, so this ring-key signature is
// what ties the burn to the ring participant. Used for the paid-wave anti-spam gate: the
// initiator's start proof rides `wave-announce`, and peers cross-check its txHash on-chain
// (to==black hole, amount, memo commits waveId) before joining. (§ protocol.md §9)
/**
 * Hash the burn attestation tuple that the peer signs with its ring key.
 * @param {BurnFields} fields - The burn attestation fields.
 * @returns {Buffer} The blake2b hash of the burn tuple.
 */
function burnHash({
  waveId,
  peerId,
  reason,
  amount,
  txHash,
  tronAddress,
  burnTs
}) {
  return crypto.hash(
    b4a.from(
      `${waveId}|${peerId}|${reason}|${amount}|${txHash}|${tronAddress}|${burnTs}`
    )
  );
}

/**
 * Sign a burn attestation with the peer's ring key.
 * @param {KeyPair} keyPair - The signing ring keypair.
 * @param {BurnFields} fields - The burn attestation fields.
 * @returns {string} The Ed25519 burn signature (hex).
 */
function signBurn(keyPair, fields) {
  return b4a.toString(crypto.sign(burnHash(fields), keyPair.secretKey), 'hex');
}

/**
 * Verify a burn attestation is a valid Ed25519 signature by `fields.peerId` over the
 * tuple. Only the burnHash fields are read — callers may pass a whole proof object
 * (an extra `sig` key is ignored).
 * @param {BurnFields} fields - The burn attestation fields (peerId is the signer).
 * @param {string} sigHex - The burn signature to verify (hex).
 * @returns {boolean} True if the signature is valid for that peer over the tuple.
 */
function verifyBurn(fields, sigHex) {
  try {
    return crypto.verify(
      burnHash(fields),
      b4a.from(sigHex, 'hex'),
      b4a.from(fields.peerId, 'hex')
    );
  } catch {
    return false;
  }
}

// Does this burn attestation authorize `peerId` to write to `waveId`'s feed? Checks the
// signature and that the burn is bound to this exact peer + wave (so a burn can't be replayed
// for another identity or wave). This is the feed-admission gate: presence in the feed
// requires a real fee burn, which makes every tippable entry one from a peer who paid in.
// The on-chain reality of the txHash is verified separately by the admitter (network I/O).
/**
 * Does this burn attestation authorize `peerId` to write to `waveId`'s feed?
 * Checks the signature and that the burn is bound to this exact peer + wave.
 * @param {BurnProof} burn - The signed burn proof to check.
 * @param {string} peerId - The peer id the burn must be bound to.
 * @param {string} waveId - The wave id the burn must be bound to.
 * @returns {boolean} True if the burn is valid and bound to this peer + wave.
 */
function burnAuthorizes(burn, peerId, waveId) {
  return !!(
    burn &&
    burn.peerId === peerId &&
    burn.waveId === waveId &&
    verifyBurn(burn, burn.sig)
  );
}

// Is a wave's START burn proof valid enough to ADOPT the wave (the paid-wave anti-spam gate)?
// A start proof must be a 'start'-reason burn bound to this wave + signed by the claimed
// initiator, AND recent — its signed `burnTs` within `maxAgeMs` of `now`. The freshness bound is
// replay-attack prevention: a captured, still-validly-signed announce that reuses an old burn is
// rejected (burnTs is inside the signed burn tuple, so it can't be back-dated without the key).
// Pure — the on-chain reality of the txHash is checked separately (network I/O). Extracted here
// (from wave.js) so the gate + its freshness window are unit-testable without a swarm.
/**
 * @param {Object} opts
 * @param {BurnProof} opts.proof - The start burn attestation to check.
 * @param {string} opts.waveId - The wave the proof must name.
 * @param {string} opts.byId - Hex id of the initiator the proof must be signed by.
 * @param {number} opts.now - The current time (ms).
 * @param {number} opts.maxAgeMs - Reject a burn whose `burnTs` is farther than this from `now`.
 * @returns {boolean} True if the start proof is structurally valid, correctly signed, and fresh.
 */
function startProofValid({ proof, waveId, byId, now, maxAgeMs }) {
  return !!(
    proof &&
    proof.reason === 'start' &&
    proof.waveId === waveId &&
    proof.peerId === byId &&
    Number.isFinite(proof.burnTs) &&
    Math.abs(now - proof.burnTs) <= maxAgeMs &&
    verifyBurn(proof, proof.sig)
  );
}

// --- join attestation --------------------------------------------------------
// A peer's signed opt-in to a wave, binding its identity to the feed writer
// core it publishes. Carried on `wave-join` (the join IS the write credential —
// self-certifying, no admission) and on every feed entry (mergeFeed's
// write-gate: no valid join attestation = no write).
// Covering the writerKey matters: without it, a relay could swap in its own
// writer key under someone else's peerId and steal that peer's one feed seat.
/**
 * Hash the (waveId, peerId, writerKey) tuple a join attestation signs.
 * @param {string} waveId - The wave id.
 * @param {string} peerId - The joining peer's ring id (hex).
 * @param {string} writerKey - The peer's feed writer core key (hex).
 * @returns {Buffer} The blake2b hash of the join tuple.
 */
function joinHash(waveId, peerId, writerKey) {
  return crypto.hash(b4a.from(`join|${waveId}|${peerId}|${writerKey}`));
}

/**
 * Sign a join attestation with the peer's ring key.
 * @param {KeyPair} keyPair - The joining peer's signing ring keypair.
 * @param {{waveId: string, writerKey: string}} fields - The join tuple (the
 *   peerId is the keypair's own public key).
 * @returns {string} The Ed25519 join signature (hex).
 */
function signJoin(keyPair, { waveId, writerKey }) {
  const peerId = b4a.toString(keyPair.publicKey, 'hex');
  return b4a.toString(
    crypto.sign(joinHash(waveId, peerId, writerKey), keyPair.secretKey),
    'hex'
  );
}

/**
 * Verify a join attestation is validly signed by `peerId` over
 * (waveId, peerId, writerKey). This is authenticity, not
 * uniqueness — one-entry-per-peer and the byte caps bound what a seat can do.
 * @param {{waveId: string, peerId: string, writerKey: string}} fields - The
 *   join tuple (peerId is the claimed signer, hex).
 * @param {string} sigHex - The join signature to verify (hex).
 * @returns {boolean} True if `peerId` signed this join.
 */
function verifyJoin({ waveId, peerId, writerKey }, sigHex) {
  try {
    return crypto.verify(
      joinHash(waveId, peerId, writerKey),
      b4a.from(sigHex, 'hex'),
      b4a.from(peerId, 'hex')
    );
  } catch {
    return false;
  }
}

// --- message envelope -------------------------------------------------------
// Every gossip message carries a uniform envelope: `origin` (the author's ring id, hex),
// `ts` (author timestamp, ms), and `sig` (an Ed25519 signature by `origin`'s ring key over
// the WHOLE message minus `sig`). This generalizes the ad-hoc per-kind identity binding into
// one shared check: any relay or recipient can verify authenticity independent of the
// connection a flooded message arrived over, and the signed `ts` gives every message a
// hard age bound (a replayed message can't have its timestamp refreshed without the key).
// The domain attestations above (join, burn) still bind their own tuples; the envelope `sig`
// additionally authenticates the message as a whole. (§ protocol.md §5.0)

/**
 * Deterministically serialize any JSON value with object keys sorted recursively, so the
 * sender and every verifier compute the identical bytes regardless of key insertion order.
 * @param {*} value - Any JSON-serializable value.
 * @returns {string} The canonical serialization.
 */
function stableStringify(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const pairs = keys.map(
      (key) => JSON.stringify(key) + ':' + stableStringify(value[key])
    );
    return '{' + pairs.join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * Hash the canonical form of a message EXCLUDING its `sig` field — the bytes the envelope
 * signature covers (everything else: kind, origin, ts, mid, and the kind's payload).
 * @param {Object} msg - The gossip message (with or without `sig`).
 * @returns {Buffer} The blake2b hash of the canonical, sig-less message.
 */
function messageHash(msg) {
  const { sig: _sig, ...rest } = msg;
  return crypto.hash(b4a.from(stableStringify(rest)));
}

/**
 * Sign a message envelope with the author's ring key (covers the whole message minus `sig`).
 * @param {KeyPair} keyPair - The author's signing ring keypair (its public key is `msg.origin`).
 * @param {Object} msg - The message to sign (already carrying `origin`, `ts`, and payload).
 * @returns {string} The Ed25519 envelope signature (hex).
 */
function signMessage(keyPair, msg) {
  return b4a.toString(crypto.sign(messageHash(msg), keyPair.secretKey), 'hex');
}

/**
 * Verify a message's envelope signature: `msg.sig` is a valid Ed25519 signature by
 * `msg.origin` over the whole message minus `sig`. Authenticity independent of transport —
 * a relayed (flooded) message is trusted by this, not by the connection it arrived on.
 * @param {Object} msg - The message with `origin` + `sig`.
 * @returns {boolean} True if `origin` signed this exact message.
 */
function verifyMessage(msg) {
  try {
    return crypto.verify(
      messageHash(msg),
      b4a.from(msg.sig, 'hex'),
      b4a.from(msg.origin, 'hex')
    );
  } catch {
    return false;
  }
}

module.exports = {
  signBurn,
  verifyBurn,
  burnAuthorizes,
  startProofValid,
  signJoin,
  verifyJoin,
  stableStringify,
  signMessage,
  verifyMessage
};
