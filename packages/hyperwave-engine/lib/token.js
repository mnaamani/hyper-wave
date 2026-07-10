// Pure token crypto for the wave race. Ed25519 receipts + a constant-size blake2b
// chain accumulator (docs/protocol.md §2.3 — NOT a growing hops[] array). No state,
// no I/O — unit-tested in wave.token.test.js.
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
 * @property {string} reason - Why the fee was burned (e.g. 'kickoff', 'join').
 * @property {number} amount - The burned amount.
 * @property {string} txHash - The on-chain burn transaction hash.
 * @property {string} tronAddress - The Tron wallet that funded the burn.
 * @property {number} burnTs - The burn timestamp (ms).
 */

/**
 * A signed burn attestation: the burn fields plus the ring-key signature.
 * @typedef {BurnFields & {sig: string}} BurnProof
 */

/**
 * The token message that races between peers (unicast to each successor).
 * @typedef {Object} Token
 * @property {string} senderPeerId - Ring peer id (hex) of the forwarding peer.
 * @property {string} waveId - The wave this token belongs to.
 * @property {number} hopCount - Hop index of this forward.
 * @property {string} prevChainHash - The rolling accumulator hash before this hop.
 * @property {number} timestamp - When the sender stamped the token (ms).
 * @property {string} senderReceiptSig - The sender's Ed25519 receipt signature (hex).
 */

const ZERO_HASH = b4a.toString(b4a.alloc(32), 'hex'); // genesis accumulator

/**
 * The hop tuple a receipt signs, plus (for verification) the claimed signer.
 * @typedef {Object} ReceiptFields
 * @property {string} [peerId] - The claimed signer's ring peer id (hex; verification only).
 * @property {string} waveId - The wave id.
 * @property {number} hopCount - The hop index.
 * @property {string} prevChainHash - The accumulator hash before this hop (hex).
 * @property {number} timestamp - The hop timestamp (ms).
 */

/**
 * A receipt binds a peer to a specific hop: sign(H(waveId|hop|prevChainHash|ts)).
 * @param {ReceiptFields} fields - The hop tuple.
 * @returns {Buffer} The blake2b hash of the hop tuple.
 */
function receiptHash({ waveId, hopCount, prevChainHash, timestamp }) {
  return crypto.hash(b4a.from(`${waveId}|${hopCount}|${prevChainHash}|${timestamp}`));
}

/**
 * Sign a receipt over its hop tuple with the peer's ring key.
 * @param {KeyPair} keyPair - The signing ring keypair.
 * @param {ReceiptFields} fields - The hop tuple to sign.
 * @returns {string} The Ed25519 receipt signature (hex).
 */
function signReceipt(keyPair, fields) {
  return b4a.toString(crypto.sign(receiptHash(fields), keyPair.secretKey), 'hex');
}

/**
 * Verify a receipt is a valid Ed25519 signature by `fields.peerId` over its hop
 * tuple. This authenticates a gallery entry to a peer identity (no impersonation,
 * no unsigned spam). NOTE: it does NOT prove the peer actually held the token — a
 * peer can self-sign a receipt for a hop it never held. Proof of participation
 * (cross-checking against the real token chain) is the validator's job.
 * @param {ReceiptFields} fields - The hop tuple (peerId is the claimed signer).
 * @param {string} receiptSigHex - The receipt signature to verify (hex).
 * @returns {boolean} True if the signature is valid for that peer + hop.
 */
function verifyReceipt(fields, receiptSigHex) {
  try {
    const hash = receiptHash(fields);
    return crypto.verify(hash, b4a.from(receiptSigHex, 'hex'), b4a.from(fields.peerId, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Verify the receipt the *sender* stamped on the token they forwarded.
 * @param {Token} token - The received token message.
 * @returns {boolean} True if the sender's stamped receipt is valid.
 */
function verifyToken(token) {
  return verifyReceipt(
    {
      peerId: token.senderPeerId,
      waveId: token.waveId,
      hopCount: token.hopCount,
      prevChainHash: token.prevChainHash,
      timestamp: token.timestamp
    },
    token.senderReceiptSig
  );
}

/**
 * Constant-size rolling accumulator: newHash = blake2b(prevHash || receiptSig).
 * @param {string} prevChainHash - The accumulator hash before this hop (hex).
 * @param {string} receiptSigHex - This hop's receipt signature (hex).
 * @returns {string} The advanced accumulator hash (hex).
 */
function advanceChain(prevChainHash, receiptSigHex) {
  return b4a.toString(
    crypto.hash(b4a.concat([b4a.from(prevChainHash, 'hex'), b4a.from(receiptSigHex, 'hex')])),
    'hex'
  );
}

// --- burn attestation ------------------------------------------------------
// Bridges the peer's RING identity (Ed25519) to its on-chain burn: the peer signs, with
// its ring key, a statement binding (waveId, peerId, reason, amount, txHash, tronAddress).
// The Tron key that signed the burn is a *different* keypair, so this ring-key signature is
// what ties the burn to the ring participant. Used for the paid-wave anti-spam gate: the
// initiator's kick-off proof rides `wave-announce`, and peers cross-check its txHash on-chain
// (to==black hole, amount, memo commits waveId) before joining. (§ protocol.md §9)
/**
 * Hash the burn attestation tuple that the peer signs with its ring key.
 * @param {BurnFields} fields - The burn attestation fields.
 * @returns {Buffer} The blake2b hash of the burn tuple.
 */
function burnHash({ waveId, peerId, reason, amount, txHash, tronAddress, burnTs }) {
  return crypto.hash(
    b4a.from(`${waveId}|${peerId}|${reason}|${amount}|${txHash}|${tronAddress}|${burnTs}`)
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
    return crypto.verify(burnHash(fields), b4a.from(sigHex, 'hex'), b4a.from(fields.peerId, 'hex'));
  } catch {
    return false;
  }
}

// Does this burn attestation authorize `peerId` to write to `waveId`'s gallery? Checks the
// signature and that the burn is bound to this exact peer + wave (so a burn can't be replayed
// for another identity or wave). This is the gallery-admission gate: presence in the gallery
// requires a real fee burn, which makes every tippable selfie one from a peer who paid in.
// The on-chain reality of the txHash is verified separately by the admitter (network I/O).
/**
 * Does this burn attestation authorize `peerId` to write to `waveId`'s gallery?
 * Checks the signature and that the burn is bound to this exact peer + wave.
 * @param {BurnProof} burn - The signed burn proof to check.
 * @param {string} peerId - The peer id the burn must be bound to.
 * @param {string} waveId - The wave id the burn must be bound to.
 * @returns {boolean} True if the burn is valid and bound to this peer + wave.
 */
function burnAuthorizes(burn, peerId, waveId) {
  return !!(burn && burn.peerId === peerId && burn.waveId === waveId && verifyBurn(burn, burn.sig));
}

// --- gallery-key attestation -----------------------------------------------
// The wave's gallery Autobase key is chosen by the originator and then travels on unsigned,
// relayed fields (`wave-start`, the token, `wave-sync`). Without a binding, a malicious relay
// could swap the key and point peers at an attacker-controlled gallery. So the originator
// signs (waveId, autobaseKey) with its ring key; every peer verifies the signature against
// the wave's originator before opening the gallery. (Independent of payments — pure integrity.)
/**
 * Hash the (waveId, autobaseKey) binding the originator signs.
 * @param {string} waveId - The wave id.
 * @param {string} autobaseKey - The gallery Autobase key (hex).
 * @returns {Buffer} The blake2b hash of the gallery-key tuple.
 */
function galleryKeyHash(waveId, autobaseKey) {
  return crypto.hash(b4a.from(`gallery-key|${waveId}|${autobaseKey}`));
}

/**
 * Sign the gallery key binding with the originator's ring key.
 * @param {KeyPair} keyPair - The originator's signing ring keypair.
 * @param {{waveId: string, autobaseKey: string}} fields - The gallery-key tuple.
 * @returns {string} The Ed25519 gallery-key signature (hex).
 */
function signGalleryKey(keyPair, { waveId, autobaseKey }) {
  return b4a.toString(crypto.sign(galleryKeyHash(waveId, autobaseKey), keyPair.secretKey), 'hex');
}

/**
 * Verify the gallery key is the one the wave's `originatorId` published for `waveId`.
 * @param {{originatorId: string, waveId: string, autobaseKey: string}} fields - The
 *   gallery-key tuple (originatorId is the claimed signer, hex).
 * @param {string} sigHex - The gallery-key signature to verify (hex).
 * @returns {boolean} True if the originator signed this key for this wave.
 */
function verifyGalleryKey({ originatorId, waveId, autobaseKey }, sigHex) {
  try {
    return crypto.verify(
      galleryKeyHash(waveId, autobaseKey),
      b4a.from(sigHex, 'hex'),
      b4a.from(originatorId, 'hex')
    );
  } catch {
    return false;
  }
}

// --- wave-end completion attestation ---------------------------------------
// A completed wave is announced by its ORIGINATOR flooding a `wave-end`. Because a flood
// message can be forged by any peer, the originator signs the completion with its ring key
// so receivers can't be tricked into ending a wave that didn't really finish. Binds
// (waveId, hops, chainHash) to the originator identity.
/**
 * Hash the (waveId, hops, chainHash) completion the originator signs.
 * @param {string} waveId - The wave id.
 * @param {number} hops - The total number of hops the wave completed.
 * @param {string} chainHash - The final accumulator hash (hex).
 * @returns {Buffer} The blake2b hash of the wave-end tuple.
 */
function waveEndHash(waveId, hops, chainHash) {
  return crypto.hash(b4a.from(`wave-end|${waveId}|${hops}|${chainHash}`));
}

/**
 * Sign a wave completion with the originator's ring key.
 * @param {KeyPair} keyPair - The originator's signing ring keypair.
 * @param {{waveId: string, hops: number, chainHash: string}} fields - The
 *   completion tuple.
 * @returns {string} The Ed25519 wave-end signature (hex).
 */
function signWaveEnd(keyPair, { waveId, hops, chainHash }) {
  return b4a.toString(crypto.sign(waveEndHash(waveId, hops, chainHash), keyPair.secretKey), 'hex');
}

/**
 * Verify a completion is validly signed by `originatorId` over its
 * (waveId, hops, chainHash).
 * @param {{originatorId: string, waveId: string, hops: number, chainHash: string}} fields -
 *   The completion tuple (originatorId is the claimed signer, hex).
 * @param {string} sigHex - The wave-end signature to verify (hex).
 * @returns {boolean} True if the originator signed this completion.
 */
function verifyWaveEnd({ originatorId, waveId, hops, chainHash }, sigHex) {
  try {
    return crypto.verify(
      waveEndHash(waveId, hops, chainHash),
      b4a.from(sigHex, 'hex'),
      b4a.from(originatorId, 'hex')
    );
  } catch {
    return false;
  }
}

module.exports = {
  ZERO_HASH,
  receiptHash,
  signReceipt,
  verifyReceipt,
  verifyToken,
  advanceChain,
  burnHash,
  signBurn,
  verifyBurn,
  burnAuthorizes,
  signGalleryKey,
  verifyGalleryKey,
  signWaveEnd,
  verifyWaveEnd
};
