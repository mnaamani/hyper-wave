// Token crypto: receipts, the constant-size chain accumulator, completion, and
// tamper rejection. Simulates a full lap O -> P1 -> P2 -> O. Runs under Bare:
//   bare workers/lib/wave.token.test.js   (or `npm test`)
const test = require('brittle')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const {
  receiptHash,
  signReceipt,
  verifyToken,
  advanceChain,
  signBurn,
  verifyBurn,
  longestValidChain,
  payableFromChain
} = require('./token')

const ZERO = b4a.toString(b4a.alloc(32), 'hex')

// three identities
const kp = [crypto.keyPair(), crypto.keyPair(), crypto.keyPair()]
const id = kp.map((k) => b4a.toString(k.publicKey, 'hex'))

// forge one hop: given the token a peer received, produce the token it forwards
function stampHop(keyPair, peerId, waveId, prevToken) {
  const hopCount = prevToken.hopCount + 1
  const prevChainHash = advanceChain(prevToken.prevChainHash, prevToken.senderReceiptSig)
  const timestamp = prevToken.timestamp + 50
  const senderReceiptSig = signReceipt(keyPair, waveId, hopCount, prevChainHash, timestamp)
  return {
    waveId,
    originator: prevToken.originator,
    hopCount,
    prevChainHash,
    senderPeerId: peerId,
    senderReceiptSig,
    timestamp
  }
}

const waveId = 'wave-abc'
const t0 = {
  waveId,
  originator: id[0],
  hopCount: 0,
  prevChainHash: ZERO,
  senderPeerId: id[0],
  senderReceiptSig: signReceipt(kp[0], waveId, 0, ZERO, 1000),
  timestamp: 1000
}
const t1 = stampHop(kp[1], id[1], waveId, t0)
const t2 = stampHop(kp[2], id[2], waveId, t1)

test('every hop receipt verifies against its signer', (t) => {
  t.ok(verifyToken(t0), 'origin receipt')
  t.ok(verifyToken(t1), 'hop1 receipt')
  t.ok(verifyToken(t2), 'hop2 receipt')
})

test('advanceChain is deterministic and input-sensitive', (t) => {
  t.is(advanceChain(ZERO, t0.senderReceiptSig), t1.prevChainHash)
  t.not(advanceChain(ZERO, t0.senderReceiptSig), advanceChain(ZERO, t1.senderReceiptSig))
})

test('chain accumulator reproducible by an independent validator walk', (t) => {
  let h = ZERO
  h = advanceChain(h, t0.senderReceiptSig)
  h = advanceChain(h, t1.senderReceiptSig)
  t.is(h, t2.prevChainHash, 'validator reaches the same accumulator P2 carried')
})

test('completion condition: token back at originator with hopCount > 0', (t) => {
  t.ok(t2.originator === id[0] && t2.hopCount > 0)
})

test('tampered receipt signature fails verification', (t) => {
  t.absent(verifyToken({ ...t1, senderReceiptSig: t1.senderReceiptSig.replace(/^../, '00') }))
})

test('receipt is bound to its hop (replaying a receipt at another hop fails)', (t) => {
  t.absent(verifyToken({ ...t1, hopCount: 7 }))
})

test('receipt cannot be attributed to a different peer', (t) => {
  t.absent(verifyToken({ ...t1, senderPeerId: id[2] }))
})

test('receiptHash is stable for identical inputs', (t) => {
  t.ok(b4a.equals(receiptHash(waveId, 1, ZERO, 1000), receiptHash(waveId, 1, ZERO, 1000)))
})

// --- burn attestation (participation-fee proof) ----------------------------
const burnFields = {
  waveId,
  peerId: id[1],
  reason: 'join',
  amount: 1,
  txHash: 'd6a0dd3fdeadbeef',
  tronAddress: 'TJbnvY1Qudc6BE48KenG172EV1uEM5QVvJ',
  burnTs: 1783150000000
}

test('signBurn/verifyBurn binds the ring peer to its on-chain burn', (t) => {
  const sig = signBurn(kp[1], burnFields)
  t.ok(verifyBurn(burnFields, sig), 'valid attestation verifies')
})

test('burn attestation rejects impersonation and tampering', (t) => {
  const sig = signBurn(kp[1], burnFields)
  t.absent(verifyBurn({ ...burnFields, peerId: id[2] }, sig), 'wrong peerId (impersonation)')
  t.absent(verifyBurn({ ...burnFields, txHash: 'other' }, sig), 'swapped txHash')
  t.absent(verifyBurn({ ...burnFields, waveId: 'other-wave' }, sig), 'reused for another wave')
  t.absent(verifyBurn({ ...burnFields, amount: 99 }, sig), 'inflated amount')
})

// --- interlocked payout (the golden rule) ----------------------------------
// A collected hop receipt, as the validator stores it (§wave-proof), derived from a token.
function proofOf(tok, address) {
  return {
    hopCount: tok.hopCount,
    peerId: tok.senderPeerId,
    receiptSig: tok.senderReceiptSig,
    chainHash: tok.prevChainHash,
    receiptTs: tok.timestamp,
    address
  }
}
const chainProofs = [proofOf(t0, 'Taddr0'), proofOf(t1, 'Taddr1'), proofOf(t2, 'Taddr2')]

test('longestValidChain walks the whole chain when every link verifies', (t) => {
  const chain = longestValidChain(chainProofs, waveId)
  t.alike(
    chain.map((p) => p.hopCount),
    [0, 1, 2],
    'all three hops form a valid chain'
  )
})

test('longestValidChain stops at a forged/broken link (longest valid prefix)', (t) => {
  const tampered = [
    proofOf(t0, 'a'),
    { ...proofOf(t1, 'b'), receiptSig: t1.senderReceiptSig.replace(/^../, '00') },
    proofOf(t2, 'c')
  ]
  t.is(longestValidChain(tampered, waveId).length, 1, 'stops before the forged hop 1')
  const gap = [proofOf(t0, 'a'), proofOf(t2, 'c')] // missing hop 1
  t.is(longestValidChain(gap, waveId).length, 1, 'a gap breaks the chain')
  const wrongLink = [proofOf(t0, 'a'), { ...proofOf(t1, 'b'), chainHash: ZERO }] // link doesn't match
  t.is(longestValidChain(wrongLink, waveId).length, 1, 'a non-linking accumulator breaks it')
})

test('payableFromChain applies the golden rule (successor must continue)', (t) => {
  const chain = longestValidChain(chainProofs, waveId)
  // stalled: only hops with a proven *successor* in the chain are paid (drop the last)
  t.alike(
    payableFromChain(chain, { completed: false }).map((p) => p.hopCount),
    [0, 1],
    'stall pays the longest prefix — the last hop has no proven successor'
  )
  // completed at the last hop: the return to the originator proves the last hop too
  t.alike(
    payableFromChain(chain, { completed: true, completedHops: 2 }).map((p) => p.hopCount),
    [0, 1, 2],
    'completion pays everyone including the last'
  )
  t.alike(payableFromChain([], { completed: true }), [], 'empty chain pays nobody')
})
