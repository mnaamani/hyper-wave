// feed.js — the wave entry feed is a multicore CRDT: each participant owns one
// Hypercore and appends its single entry; every peer collects the block-0 entries and
// folds them into one ordered view with the PURE mergeFeed(). Same set of ops in →
// byte-identical feed out on every peer (no indexer, no consensus). mergeFeed is
// the write-gate: it drops ops without a valid join attestation or over the payload byte
// cap, keeps a tip address only if a burn backs it, and keeps one entry per peer, hop-ordered.
// This demo runs mergeFeed over a hand-built bag of ops (no swarm needed).
// Run:  bare examples/feed.js
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const { mergeFeed } = require('hyperwave-engine/lib/feed');
const { signJoin } = require('hyperwave-engine/lib/attest');

const waveId = 'w1';

// Build a join-attested wave-entry op signed by keyPair. writerKey is the peer's own
// feed core key; the join attestation binds (waveId, peerId, writerKey) — that's the
// write-gate mergeFeed checks (there is no shared feed key).
// `payload` is opaque application content (arbitrary JSON the host owns) — here a label.
function entry(keyPair, hopCount, payload, timestamp) {
  const peerId = b4a.toString(keyPair.publicKey, 'hex');
  const writerKey = b4a.toString(crypto.keyPair().publicKey, 'hex');
  return {
    type: 'wave-entry',
    waveId,
    peerId,
    hopCount, // my rank in the angle-ordered sweep (the feed ordering key)
    writerKey,
    joinSig: signJoin(keyPair, { waveId, writerKey }),
    payload,
    timestamp
  };
}

const alice = crypto.keyPair();
const bob = crypto.keyPair();

const forged = entry(bob, 2, 'forged', 400);
forged.joinSig = '00'.repeat(64); // invalid join attestation → dropped by mergeFeed

const bag = [
  entry(bob, 1, 'bob', 200),
  entry(alice, 0, 'alice', 100),
  entry(alice, 0, 'alice-newer', 300), // 2nd alice op → one-per-peer keeps the newest
  forged
];

const items = mergeFeed(bag);
console.log(
  'feed (ordered by slot, one per peer, forged dropped):',
  items.map((entry) => entry.payload)
);
