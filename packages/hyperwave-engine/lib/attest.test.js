// Attestation crypto (attest.js): the burn attestation (paid-wave gate + tip-address
// binding) and the join attestation (the feed write credential + self-certifying core
// key). Pure — no swarm. Runs under Bare:
//   bare lib/attest.test.js   (or `npm test`)
const test = require('brittle');
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const {
  signBurn,
  verifyBurn,
  burnAuthorizes,
  signJoin,
  verifyJoin
} = require('./attest');

const waveId = 'wave-attest-1';
const keyPairs = [crypto.keyPair(), crypto.keyPair(), crypto.keyPair()];
const ids = keyPairs.map((keyPair) => b4a.toString(keyPair.publicKey, 'hex'));

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
  t.absent(
    verifyBurn({ ...burnFields, peerId: ids[2] }, sig),
    'wrong peerId (impersonation)'
  );
  t.absent(
    verifyBurn({ ...burnFields, txHash: 'other' }, sig),
    'swapped txHash'
  );
  t.absent(
    verifyBurn({ ...burnFields, waveId: 'other-wave' }, sig),
    'reused for another wave'
  );
  t.absent(verifyBurn({ ...burnFields, amount: 99 }, sig), 'inflated amount');
});

test('burnAuthorizes gates the paid join on a real, bound burn', (t) => {
  const proof = { ...burnFields, sig: signBurn(keyPairs[1], burnFields) };
  t.ok(
    burnAuthorizes(proof, ids[1], waveId),
    'a valid burn authorizes its own peer + wave'
  );
  t.absent(burnAuthorizes(null, ids[1], waveId), 'no burn = not counted');
  t.absent(
    burnAuthorizes(proof, ids[2], waveId),
    'not another peer’s join (bound to peerId)'
  );
  t.absent(
    burnAuthorizes(proof, ids[1], 'other-wave'),
    'not reusable for another wave'
  );
  const forged = { ...burnFields, sig: signBurn(keyPairs[2], burnFields) }; // someone else's signature
  t.absent(
    burnAuthorizes(forged, ids[1], waveId),
    'signature must be by the joining peer'
  );
});

// --- join attestation --------------------------------------------------------
test('signJoin/verifyJoin binds a peer to its wave + writer core', (t) => {
  const writerKey = b4a.toString(crypto.keyPair().publicKey, 'hex');
  const sig = signJoin(keyPairs[1], { waveId, writerKey });
  const bound = { waveId, peerId: ids[1], writerKey };
  t.ok(verifyJoin(bound, sig), 'a valid join attestation verifies');
  t.absent(
    verifyJoin({ ...bound, peerId: ids[2] }, sig),
    'wrong peerId (impersonation)'
  );
  t.absent(
    verifyJoin({ ...bound, writerKey: 'deadbeef' }, sig),
    'a swapped writer key is rejected (nobody can steal a seat)'
  );
  t.absent(
    verifyJoin({ ...bound, waveId: 'other-wave' }, sig),
    'not reusable for another wave'
  );
  t.absent(
    verifyJoin(bound, '00'.repeat(64)),
    'wrong signature bytes rejected'
  );
});
