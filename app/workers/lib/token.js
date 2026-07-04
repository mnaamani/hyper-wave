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
// what ties the burn to the ring participant. The validator also cross-checks txHash on the
// chain (to==black hole, amount, memo commits waveId) — see final-idea.md payment layer.
function burnHash({ waveId, peerId, reason, amount, txHash, tronAddress, burnTs }) {
  return crypto.hash(
    b4a.from(`${waveId}|${peerId}|${reason}|${amount}|${txHash}|${tronAddress}|${burnTs}`)
  )
}

function signBurn(keyPair, fields) {
  return b4a.toString(crypto.sign(burnHash(fields), keyPair.secretKey), 'hex')
}

// Verify a burn attestation is a valid Ed25519 signature by `fields.peerId` over the tuple.
// Only the burnHash fields are read — callers may pass a whole burn-proof op (extra keys
// like `sig`/`type` are ignored).
function verifyBurn(fields, sigHex) {
  try {
    return crypto.verify(burnHash(fields), b4a.from(sigHex, 'hex'), b4a.from(fields.peerId, 'hex'))
  } catch {
    return false
  }
}

// --- interlocked payout (final-idea.md the golden rule) --------------------
// The validator reassembles the hop receipts it collected (§wave-proof) and walks them
// from hop 0, verifying the CHAIN: each hop's receipt must sign the accumulator it carries,
// and the next hop's accumulator must be advanceChain(prev, prevReceiptSig). The walk stops
// at the first broken/forged/missing link — so a self-signed receipt for a hop the peer
// never held (or a gap) can't extend the chain. Returns the longest valid prefix (in order).
function longestValidChain(proofs, waveId) {
  const sorted = [...proofs].sort((a, b) => a.hopCount - b.hopCount)
  const valid = []
  let expectedHop = 0
  let expectedChainHash = ZERO_HASH
  for (const p of sorted) {
    if (p.hopCount !== expectedHop) break // gap — not contiguous from 0
    if (p.chainHash !== expectedChainHash) break // accumulator doesn't link to the prev hop
    if (!verifyReceipt(p.peerId, waveId, p.hopCount, p.chainHash, p.receiptTs, p.receiptSig)) break
    valid.push(p)
    expectedChainHash = advanceChain(p.chainHash, p.receiptSig)
    expectedHop++
  }
  return valid
}

// The golden rule: peer N is paid only when peer N+1 continued the wave. So within the
// valid chain, every hop except the last has a proven successor and is payable; the LAST
// hop is payable only if the wave completed (the token returned to the originator, proving
// that hop forwarded onward too). On a break/stall, this is the longest valid *prefix*.
function payableFromChain(validChain, { completed = false, completedHops = -1 } = {}) {
  if (validChain.length === 0) return []
  const payable = validChain.slice(0, -1) // all but the last: successor proves them
  const last = validChain[validChain.length - 1]
  if (completed && completedHops === last.hopCount) payable.push(last)
  return payable
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
  longestValidChain,
  payableFromChain
}
