// Pure token crypto for the wave race. Ed25519 receipts + a constant-size blake2b
// chain accumulator (final-idea.md §1.1 — NOT a growing hops[] array). No state,
// no I/O — unit-tested in wave.token.test.js.
const crypto = require('hypercore-crypto')
const b4a = require('b4a')

const ZERO_HASH = b4a.toString(b4a.alloc(32), 'hex') // genesis accumulator

// A receipt binds a peer to a specific hop: sign(H(waveId|hop|prevChainHash|ts)).
function receiptHash(waveId, hopCount, prevChainHash, timestamp) {
  return crypto.hash(b4a.from(`${waveId}|${hopCount}|${prevChainHash}|${timestamp}`))
}

function signReceipt(keyPair, waveId, hopCount, prevChainHash, timestamp) {
  return b4a.toString(
    crypto.sign(receiptHash(waveId, hopCount, prevChainHash, timestamp), keyPair.secretKey),
    'hex'
  )
}

// Verify a receipt is a valid Ed25519 signature by `peerId` over its hop tuple.
// This authenticates a gallery entry to a peer identity (no impersonation, no
// unsigned spam). NOTE: it does NOT prove the peer actually held the token — a
// peer can self-sign a receipt for a hop it never held. Proof of participation
// (cross-checking against the real token chain) is the validator's job.
function verifyReceipt(peerIdHex, waveId, hopCount, chainHash, timestamp, receiptSigHex) {
  try {
    const h = receiptHash(waveId, hopCount, chainHash, timestamp)
    return crypto.verify(h, b4a.from(receiptSigHex, 'hex'), b4a.from(peerIdHex, 'hex'))
  } catch {
    return false
  }
}

// Verify the receipt the *sender* stamped on the token they forwarded.
function verifyToken(token) {
  return verifyReceipt(
    token.senderPeerId,
    token.waveId,
    token.hopCount,
    token.prevChainHash,
    token.timestamp,
    token.senderReceiptSig
  )
}

// Constant-size rolling accumulator: newHash = blake2b(prevHash || receiptSig).
function advanceChain(prevChainHash, receiptSigHex) {
  return b4a.toString(
    crypto.hash(b4a.concat([b4a.from(prevChainHash, 'hex'), b4a.from(receiptSigHex, 'hex')])),
    'hex'
  )
}

// --- burn attestation ------------------------------------------------------
// Bridges the peer's RING identity (Ed25519) to its on-chain burn: the peer signs, with
// its ring key, a statement binding (waveId, peerId, reason, amount, txHash, tronAddress).
// The Tron key that signed the burn is a *different* keypair, so this ring-key signature is
// what ties the burn to the ring participant. Used for the paid-wave anti-spam gate: the
// initiator's kick-off proof rides `wave-announce`, and peers cross-check its txHash on-chain
// (to==black hole, amount, memo commits waveId) before joining. (§ protocol.md §9)
function burnHash({ waveId, peerId, reason, amount, txHash, tronAddress, burnTs }) {
  return crypto.hash(
    b4a.from(`${waveId}|${peerId}|${reason}|${amount}|${txHash}|${tronAddress}|${burnTs}`)
  )
}

function signBurn(keyPair, fields) {
  return b4a.toString(crypto.sign(burnHash(fields), keyPair.secretKey), 'hex')
}

// Verify a burn attestation is a valid Ed25519 signature by `fields.peerId` over the tuple.
// Only the burnHash fields are read — callers may pass a whole proof object (an extra `sig`
// key is ignored).
function verifyBurn(fields, sigHex) {
  try {
    return crypto.verify(burnHash(fields), b4a.from(sigHex, 'hex'), b4a.from(fields.peerId, 'hex'))
  } catch {
    return false
  }
}

// --- wave-end completion attestation ---------------------------------------
// A completed wave is announced by its ORIGINATOR flooding a `wave-end`. Because a flood
// message can be forged by any peer, the originator signs the completion with its ring key
// so receivers can't be tricked into ending a wave that didn't really finish. Binds
// (waveId, hops, chainHash) to the originator identity.
function waveEndHash(waveId, hops, chainHash) {
  return crypto.hash(b4a.from(`wave-end|${waveId}|${hops}|${chainHash}`))
}

function signWaveEnd(keyPair, waveId, hops, chainHash) {
  return b4a.toString(crypto.sign(waveEndHash(waveId, hops, chainHash), keyPair.secretKey), 'hex')
}

// Verify a completion is validly signed by `originatorHex` over its (waveId, hops, chainHash).
function verifyWaveEnd(originatorHex, waveId, hops, chainHash, sigHex) {
  try {
    return crypto.verify(
      waveEndHash(waveId, hops, chainHash),
      b4a.from(sigHex, 'hex'),
      b4a.from(originatorHex, 'hex')
    )
  } catch {
    return false
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
  signWaveEnd,
  verifyWaveEnd
}
