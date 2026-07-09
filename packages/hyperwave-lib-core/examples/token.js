// token.js — pure crypto behind the racing token and the paid-wave gates: Ed25519
// receipts + a constant-size blake2b accumulator, plus the burn / gallery-key /
// wave-end attestations. All stateless. Run:  bare examples/token.js
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const {
  ZERO_HASH,
  signReceipt,
  verifyReceipt,
  advanceChain,
  verifyToken,
  signBurn,
  verifyBurn,
  burnAuthorizes,
  signGalleryKey,
  verifyGalleryKey,
  signWaveEnd,
  verifyWaveEnd
} = require('hyperwave-lib-core/lib/token');

const kp = crypto.keyPair();
const peerId = b4a.toString(kp.publicKey, 'hex');
const waveId = 'w1';
const ts = Date.now();

// --- receipt chain: each hop signs a receipt; the accumulator rolls forward ---
const sig = signReceipt(kp, waveId, 1, ZERO_HASH, ts); // ZERO_HASH = genesis accumulator
console.log('verifyReceipt:', verifyReceipt(peerId, waveId, 1, ZERO_HASH, ts, sig));
const chainHash = advanceChain(ZERO_HASH, sig); // blake2b(prev || sig) — constant size
console.log('chainHash advanced:', chainHash !== ZERO_HASH);

// verifyToken() checks the receipt the SENDER stamped on a forwarded token.
const tokenMsg = {
  senderPeerId: peerId,
  waveId,
  hopCount: 1,
  prevChainHash: ZERO_HASH,
  timestamp: ts,
  senderReceiptSig: sig
};
console.log('verifyToken:', verifyToken(tokenMsg));

// tamper check: a flipped receipt fails verification.
console.log(
  'tampered receipt rejected:',
  !verifyReceipt(peerId, waveId, 1, ZERO_HASH, ts, sig.replace(/^../, '00'))
);

// --- burn attestation: bridges the ring identity to the on-chain fee burn ---
const fields = {
  waveId,
  peerId,
  reason: 'kickoff',
  amount: 1,
  txHash: 'deadbeef',
  tronAddress: 'TExample',
  burnTs: ts
};
const proof = { ...fields, sig: signBurn(kp, fields) };
console.log('verifyBurn:', verifyBurn(fields, proof.sig));
console.log('burnAuthorizes (this peer + wave):', burnAuthorizes(proof, peerId, waveId));
console.log('burnAuthorizes for a DIFFERENT wave:', burnAuthorizes(proof, peerId, 'other-wave'));

// --- gallery-key + wave-end: the originator signs so a relay can't swap either ---
const keySig = signGalleryKey(kp, waveId, 'autobaseKeyHex');
console.log('verifyGalleryKey:', verifyGalleryKey(peerId, waveId, 'autobaseKeyHex', keySig));
const endSig = signWaveEnd(kp, waveId, 8, chainHash);
console.log('verifyWaveEnd:', verifyWaveEnd(peerId, waveId, 8, chainHash, endSig));
