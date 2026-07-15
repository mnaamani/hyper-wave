// messages.js — the gossip message seam: one factory per on-wire kind (every send site
// builds through it) and one shape validator per kind (run at the receive edge before any
// signature/state work). Shape only — signatures/paid gate live in attest.js + handlers.
// Run:  bare examples/messages.js
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const {
  FLOODED_KINDS,
  validGossip,
  makeHeartbeat,
  makeWaveJoin
} = require('hyperwave-engine/lib/messages');
const { signJoin } = require('hyperwave-engine/lib/attest');

const keyPair = crypto.keyPair();
const peerId = b4a.toString(keyPair.publicKey, 'hex');
const waveId = b4a.toString(crypto.randomBytes(16), 'hex');
const writerKey = b4a.toString(crypto.keyPair().publicKey, 'hex');

// Direct kind: valid straight out of the factory.
const heartbeat = makeHeartbeat({ id: peerId, tag: 'BR' });
console.log('heartbeat valid:', validGossip(heartbeat));

// Flooded kind: valid only once the flood mid is stamped (floodGossip does this).
const join = makeWaveJoin({
  waveId,
  peerId,
  writerKey,
  joinSig: signJoin(keyPair, { waveId, writerKey })
});
console.log('join without mid:', validGossip(join)); // false — flooded kinds need a mid
const mid = b4a.toString(crypto.randomBytes(8), 'hex');
console.log('join with mid:', validGossip({ ...join, mid }));

// The receive edge drops unknown kinds and malformed fields outright.
console.log('unknown kind:', validGossip({ kind: 'token', waveId }));
console.log('bad peer id:', validGossip(makeHeartbeat({ id: 'not-hex' })));

// The flooded/direct classification the relay decision uses.
console.log('flooded kinds:', [...FLOODED_KINDS]);
