// Token crypto: receipts, the constant-size chain accumulator, completion, and
// tamper rejection. Simulates a full lap O -> P1 -> P2 -> O. Runs under Bare:
//   bare workers/lib/wave.token.test.js   (or `npm test`)
const test = require('brittle');
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const {
  receiptHash,
  signReceipt,
  verifyToken,
  advanceChain,
  signBurn,
  verifyBurn,
  burnAuthorizes,
  signGalleryKey,
  verifyGalleryKey,
  signWaveEnd,
  verifyWaveEnd
} = require('./token');

const ZERO = b4a.toString(b4a.alloc(32), 'hex');

// three identities
const keyPairs = [crypto.keyPair(), crypto.keyPair(), crypto.keyPair()];
const ids = keyPairs.map((keyPair) => b4a.toString(keyPair.publicKey, 'hex'));

// forge one hop: given the token a peer received, produce the token it forwards
function stampHop(keyPair, peerId, waveId, prevToken) {
  const hopCount = prevToken.hopCount + 1;
  const prevChainHash = advanceChain(prevToken.prevChainHash, prevToken.senderReceiptSig);
  const timestamp = prevToken.timestamp + 50;
  const senderReceiptSig = signReceipt(keyPair, waveId, hopCount, prevChainHash, timestamp);
  return {
    waveId,
    originator: prevToken.originator,
    hopCount,
    prevChainHash,
    senderPeerId: peerId,
    senderReceiptSig,
    timestamp
  };
}

const waveId = 'wave-abc';
const token0 = {
  waveId,
  originator: ids[0],
  hopCount: 0,
  prevChainHash: ZERO,
  senderPeerId: ids[0],
  senderReceiptSig: signReceipt(keyPairs[0], waveId, 0, ZERO, 1000),
  timestamp: 1000
};
const token1 = stampHop(keyPairs[1], ids[1], waveId, token0);
const token2 = stampHop(keyPairs[2], ids[2], waveId, token1);

test('every hop receipt verifies against its signer', (t) => {
  t.ok(verifyToken(token0), 'origin receipt');
  t.ok(verifyToken(token1), 'hop1 receipt');
  t.ok(verifyToken(token2), 'hop2 receipt');
});

test('advanceChain is deterministic and input-sensitive', (t) => {
  t.is(advanceChain(ZERO, token0.senderReceiptSig), token1.prevChainHash);
  t.not(advanceChain(ZERO, token0.senderReceiptSig), advanceChain(ZERO, token1.senderReceiptSig));
});

test('chain accumulator reproducible by an independent validator walk', (t) => {
  let chainHash = ZERO;
  chainHash = advanceChain(chainHash, token0.senderReceiptSig);
  chainHash = advanceChain(chainHash, token1.senderReceiptSig);
  t.is(chainHash, token2.prevChainHash, 'validator reaches the same accumulator P2 carried');
});

test('completion condition: token back at originator with hopCount > 0', (t) => {
  t.ok(token2.originator === ids[0] && token2.hopCount > 0);
});

test('tampered receipt signature fails verification', (t) => {
  t.absent(
    verifyToken({ ...token1, senderReceiptSig: token1.senderReceiptSig.replace(/^../, '00') })
  );
});

test('receipt is bound to its hop (replaying a receipt at another hop fails)', (t) => {
  t.absent(verifyToken({ ...token1, hopCount: 7 }));
});

test('receipt cannot be attributed to a different peer', (t) => {
  t.absent(verifyToken({ ...token1, senderPeerId: ids[2] }));
});

test('receiptHash is stable for identical inputs', (t) => {
  t.ok(b4a.equals(receiptHash(waveId, 1, ZERO, 1000), receiptHash(waveId, 1, ZERO, 1000)));
});

// --- burn attestation (participation-fee proof) ----------------------------
const burnFields = {
  waveId,
  peerId: ids[1],
  reason: 'join',
  amount: 1,
  txHash: 'd6a0dd3fdeadbeef',
  tronAddress: 'TJbnvY1Qudc6BE48KenG172EV1uEM5QVvJ',
  burnTs: 1783150000000
};

test('signBurn/verifyBurn binds the ring peer to its on-chain burn', (t) => {
  const sig = signBurn(keyPairs[1], burnFields);
  t.ok(verifyBurn(burnFields, sig), 'valid attestation verifies');
});

test('burn attestation rejects impersonation and tampering', (t) => {
  const sig = signBurn(keyPairs[1], burnFields);
  t.absent(verifyBurn({ ...burnFields, peerId: ids[2] }, sig), 'wrong peerId (impersonation)');
  t.absent(verifyBurn({ ...burnFields, txHash: 'other' }, sig), 'swapped txHash');
  t.absent(verifyBurn({ ...burnFields, waveId: 'other-wave' }, sig), 'reused for another wave');
  t.absent(verifyBurn({ ...burnFields, amount: 99 }, sig), 'inflated amount');
});

test('burnAuthorizes gates gallery admission on a real, bound burn', (t) => {
  const proof = { ...burnFields, sig: signBurn(keyPairs[1], burnFields) };
  t.ok(burnAuthorizes(proof, ids[1], waveId), 'a valid burn authorizes its own peer + wave');
  t.absent(burnAuthorizes(null, ids[1], waveId), 'no burn = no gallery seat');
  t.absent(burnAuthorizes(proof, ids[2], waveId), 'not another peer’s admission (bound to peerId)');
  t.absent(burnAuthorizes(proof, ids[1], 'other-wave'), 'not reusable for another wave');
  const forged = { ...burnFields, sig: signBurn(keyPairs[2], burnFields) }; // someone else's signature
  t.absent(burnAuthorizes(forged, ids[1], waveId), 'signature must be by the admitted peer');
});

// --- gallery-key attestation -----------------------------------------------
test('signGalleryKey/verifyGalleryKey binds the gallery key to the originator', (t) => {
  const key = 'a4da63edc0ffee';
  const sig = signGalleryKey(keyPairs[0], waveId, key);
  t.ok(verifyGalleryKey(ids[0], waveId, key, sig), 'the originator’s signed key verifies');
  t.absent(verifyGalleryKey(ids[1], waveId, key, sig), 'a non-originator can’t vouch for the key');
  t.absent(verifyGalleryKey(ids[0], waveId, 'deadbeef', sig), 'a swapped key is rejected');
  t.absent(verifyGalleryKey(ids[0], 'other-wave', key, sig), 'not reusable for another wave');
});

// --- wave-end completion attestation ---------------------------------------
test('signWaveEnd/verifyWaveEnd authenticates a completion to the originator', (t) => {
  const sig = signWaveEnd(keyPairs[0], waveId, 3, 'abc123');
  t.ok(verifyWaveEnd(ids[0], waveId, 3, 'abc123', sig), 'valid completion verifies');
});

test('wave-end attestation rejects forgery and tampering', (t) => {
  const sig = signWaveEnd(keyPairs[0], waveId, 3, 'abc123');
  t.absent(
    verifyWaveEnd(ids[1], waveId, 3, 'abc123', sig),
    'a non-originator can’t sign a completion'
  );
  t.absent(verifyWaveEnd(ids[0], waveId, 9, 'abc123', sig), 'tampered hop count');
  t.absent(verifyWaveEnd(ids[0], waveId, 3, 'deadbeef', sig), 'tampered chain hash');
  t.absent(verifyWaveEnd(ids[0], 'other-wave', 3, 'abc123', sig), 'reused for another wave');
});
