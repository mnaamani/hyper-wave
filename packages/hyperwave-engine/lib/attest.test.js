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
  startProofValid,
  signJoin,
  verifyJoin,
  stableStringify,
  signMessage,
  verifyMessage
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
  burnRef: 'd6a0dd3fdeadbeef',
  payerAddress: 'TJbnvY1Qudc6BE48KenG172EV1uEM5QVvJ',
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
    verifyBurn({ ...burnFields, burnRef: 'other' }, sig),
    'swapped burnRef'
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

// --- start proof gate (paid-wave adoption + kick-off freshness) --------------
test('startProofValid gates wave adoption on a signed, bound, FRESH start burn', (t) => {
  const initiator = keyPairs[0];
  const byId = ids[0];
  const wave = 'paid-wave-1';
  const now = 1783150000000;
  const fields = {
    waveId: wave,
    peerId: byId,
    reason: 'start',
    amount: 1,
    burnRef: 'startburntx',
    payerAddress: 'TInitiator',
    burnTs: now
  };
  const proof = { ...fields, sig: signBurn(initiator, fields) };
  const maxAgeMs = 300000;

  t.ok(
    startProofValid({ proof, waveId: wave, byId, now, maxAgeMs }),
    'a fresh, signed, bound start proof is valid'
  );
  t.absent(
    startProofValid({ proof: null, waveId: wave, byId, now, maxAgeMs }),
    'no proof → invalid (unpaid/spam announce)'
  );
  t.absent(
    startProofValid({
      proof: { ...proof, reason: 'join' },
      waveId: wave,
      byId,
      now,
      maxAgeMs
    }),
    'a join burn cannot pass as a start proof'
  );
  t.absent(
    startProofValid({ proof, waveId: 'other-wave', byId, now, maxAgeMs }),
    'a burn for another wave is rejected (bound to waveId)'
  );
  t.absent(
    startProofValid({ proof, waveId: wave, byId: ids[1], now, maxAgeMs }),
    'must be signed by the claimed initiator'
  );
  const forged = { ...fields, sig: signBurn(keyPairs[1], fields) };
  t.absent(
    startProofValid({ proof: forged, waveId: wave, byId, now, maxAgeMs }),
    'a signature by someone other than the initiator is rejected'
  );

  // freshness / replay: a captured proof replayed later (now advanced past the window) is stale
  t.absent(
    startProofValid({
      proof,
      waveId: wave,
      byId,
      now: now + maxAgeMs + 1,
      maxAgeMs
    }),
    'a start burn older than the freshness window is rejected (replay prevention)'
  );
  t.ok(
    startProofValid({
      proof,
      waveId: wave,
      byId,
      now: now + maxAgeMs,
      maxAgeMs
    }),
    'a burn just inside the window is still accepted'
  );
  t.absent(
    startProofValid({
      proof: { ...proof, burnTs: 'soon' },
      waveId: wave,
      byId,
      now,
      maxAgeMs
    }),
    'a non-numeric burnTs is rejected'
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

// --- message envelope (origin/ts/sig on every gossip message) ----------------
test('stableStringify is canonical (key order independent, sig excluded upstream)', (t) => {
  t.is(
    stableStringify({ b: 1, a: 2 }),
    stableStringify({ a: 2, b: 1 }),
    'object key order does not change the serialization'
  );
  t.is(
    stableStringify([{ y: 1, x: 2 }]),
    '[{"x":2,"y":1}]',
    'nested object keys sorted; array order preserved'
  );
  t.not(
    stableStringify([1, 2]),
    stableStringify([2, 1]),
    'array order IS significant'
  );
});

test('signMessage/verifyMessage authenticate the whole message by origin', (t) => {
  const author = keyPairs[0];
  const origin = ids[0];
  const msg = {
    kind: 'wave-start',
    mid: 'ab'.repeat(8),
    origin,
    ts: 1719705612080,
    waveId,
    writers: [{ peerId: ids[1], writerKey: 'ee'.repeat(32), joinSig: 'ff' }],
    t0: 1,
    lapMs: 8000
  };
  const sig = signMessage(author, msg);
  t.ok(
    verifyMessage({ ...msg, sig }),
    'a valid envelope verifies against origin'
  );

  t.absent(
    verifyMessage({ ...msg, sig, ts: msg.ts + 1 }),
    'tampering with any field (ts) breaks the signature'
  );
  t.absent(
    verifyMessage({ ...msg, sig, origin: ids[1] }),
    'a different claimed origin (relay forgery) is rejected'
  );
  t.absent(
    verifyMessage({ ...msg, sig: '00'.repeat(64) }),
    'a garbage signature is rejected'
  );

  // key-order independence: re-serialized (parsed→stringified) message still verifies
  const roundTripped = JSON.parse(JSON.stringify({ sig, ...msg }));
  t.ok(
    verifyMessage(roundTripped),
    'survives a JSON round-trip (canonical hash is key-order independent)'
  );
});
