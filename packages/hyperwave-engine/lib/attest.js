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

module.exports = {
  signBurn,
  verifyBurn,
  burnAuthorizes,
  signJoin,
  verifyJoin
};
