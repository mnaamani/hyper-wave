// Token crypto: receipts, the constant-size chain accumulator, completion, and
// tamper rejection. Simulates a full lap O -> P1 -> P2 -> O. Runs under Bare:
//   bare workers/lib/wave.token.test.js   (or `npm test`)
const test = require('brittle')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { receiptHash, signReceipt, verifyToken, advanceChain } = require('./token')

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
