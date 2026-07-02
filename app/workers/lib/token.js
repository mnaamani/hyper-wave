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

// Verify the receipt the *sender* stamped on the token they forwarded.
function verifyToken (token) {
  try {
    const h = receiptHash(token.waveId, token.hopCount, token.prevChainHash, token.timestamp)
    return crypto.verify(h, b4a.from(token.senderReceiptSig, 'hex'), b4a.from(token.senderPeerId, 'hex'))
  } catch {
    return false
  }
}

// Constant-size rolling accumulator: newHash = blake2b(prevHash || receiptSig).
function advanceChain (prevChainHash, receiptSigHex) {
  return b4a.toString(
    crypto.hash(b4a.concat([b4a.from(prevChainHash, 'hex'), b4a.from(receiptSigHex, 'hex')])),
    'hex'
  )
}

module.exports = { ZERO_HASH, receiptHash, signReceipt, verifyToken, advanceChain }
