// messages.js — the gossip message seam: one factory per on-wire kind (builds KIND + PAYLOAD)
// and one shape validator per kind (run at the receive edge). Every message ALSO carries the
// uniform envelope (origin/ts/sig — protocol.md §5.0), stamped at origination; validGossip
// checks the envelope + payload shape, and attest.verifyMessage verifies the signature.
// Run:  bare examples/messages.js
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const {
  FLOODED_KINDS,
  validGossip,
  makeHeartbeat,
  makeWaveJoin
} = require('hyperwave-engine/lib/messages');
const {
  signJoin,
  signMessage,
  verifyMessage
} = require('hyperwave-engine/lib/attest');

const keyPair = crypto.keyPair();
const peerId = b4a.toString(keyPair.publicKey, 'hex');
const waveId = b4a.toString(crypto.randomBytes(16), 'hex');
const writerKey = b4a.toString(crypto.keyPair().publicKey, 'hex');

// Seal a factory-built message with the uniform envelope, exactly as wave.js's originate() does:
// origin = this peer, ts = now, sig = Ed25519 over the whole message minus sig.
function seal(msg) {
  const framed = { ...msg, origin: peerId, ts: Date.now() };
  return { ...framed, sig: signMessage(keyPair, framed) };
}

// A factory output is not a valid gossip message until it's sealed with the envelope.
const heartbeat = makeHeartbeat({ tag: 'BR' });
console.log('heartbeat pre-envelope valid:', validGossip(heartbeat)); // false
console.log('heartbeat sealed valid:', validGossip(seal(heartbeat))); // true

// Flooded kind: needs the flood mid AND the envelope (origin is the joiner).
const join = makeWaveJoin({
  waveId,
  writerKey,
  joinSig: signJoin(keyPair, { waveId, writerKey })
});
console.log('join without mid:', validGossip(seal(join))); // false — flooded kinds need a mid
const mid = b4a.toString(crypto.randomBytes(8), 'hex');
const sealedJoin = seal({ ...join, mid });
console.log('join with mid + envelope:', validGossip(sealedJoin)); // true

// The envelope signature authenticates the author independent of the connection.
console.log('envelope sig verifies:', verifyMessage(sealedJoin)); // true
console.log(
  'envelope sig rejects a forged origin:',
  verifyMessage({ ...sealedJoin, origin: 'ab'.repeat(32) })
); // false

// The receive edge drops unknown kinds and malformed fields outright.
console.log('unknown kind:', validGossip(seal({ kind: 'token', waveId })));

// The flooded/direct classification the relay decision uses.
console.log('flooded kinds:', [...FLOODED_KINDS]);
