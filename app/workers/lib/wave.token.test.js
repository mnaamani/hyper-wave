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
  signWaveEnd,
  verifyWaveEnd
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

// --- wave-end completion attestation ---------------------------------------
test('signWaveEnd/verifyWaveEnd authenticates a completion to the originator', (t) => {
  const sig = signWaveEnd(kp[0], waveId, 3, 'abc123')
  t.ok(verifyWaveEnd(id[0], waveId, 3, 'abc123', sig), 'valid completion verifies')
})

test('wave-end attestation rejects forgery and tampering', (t) => {
  const sig = signWaveEnd(kp[0], waveId, 3, 'abc123')
  t.absent(
    verifyWaveEnd(id[1], waveId, 3, 'abc123', sig),
    'a non-originator can’t sign a completion'
  )
  t.absent(verifyWaveEnd(id[0], waveId, 9, 'abc123', sig), 'tampered hop count')
  t.absent(verifyWaveEnd(id[0], waveId, 3, 'deadbeef', sig), 'tampered chain hash')
  t.absent(verifyWaveEnd(id[0], 'other-wave', 3, 'abc123', sig), 'reused for another wave')
})
