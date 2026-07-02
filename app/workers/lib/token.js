// Pure token crypto for the wave race. Ed25519 receipts + a constant-size blake2b
// chain accumulator (final-idea.md §1.1 — NOT a growing hops[] array). No state,
// no I/O — unit-tested in wave.token.test.js.
const crypto = require('hypercore-crypto')
const b4a = require('b4a')

const ZERO_HASH = b4a.toString(b4a.alloc(32), 'hex') // genesis accumulator

// A receipt binds a peer to a specific hop: sign(H(waveId|hop|prevChainHash|ts)).
function receiptHash (waveId, hopCount, prevChainHash, timestamp) {
  return crypto.hash(b4a.from(`${waveId}|${hopCount}|${prevChainHash}|${timestamp}`))
}

function signReceipt (keyPair, waveId, hopCount, prevChainHash, timestamp) {
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
function verifyReceipt (peerIdHex, waveId, hopCount, chainHash, timestamp, receiptSigHex) {
  try {
    const h = receiptHash(waveId, hopCount, chainHash, timestamp)
    return crypto.verify(h, b4a.from(receiptSigHex, 'hex'), b4a.from(peerIdHex, 'hex'))
  } catch {
    return false
  }
}

// Verify the receipt the *sender* stamped on the token they forwarded.
function verifyToken (token) {
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
function advanceChain (prevChainHash, receiptSigHex) {
  return b4a.toString(
    crypto.hash(b4a.concat([b4a.from(prevChainHash, 'hex'), b4a.from(receiptSigHex, 'hex')])),
    'hex'
  )
}

module.exports = { ZERO_HASH, receiptHash, signReceipt, verifyReceipt, verifyToken, advanceChain }
