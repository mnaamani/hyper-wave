// gallery.js — the wave selfie gallery is a multicore CRDT: each participant owns one
// Hypercore and appends its single selfie; every peer collects the block-0 entries and
// folds them into one ordered view with the PURE mergeGallery(). Same set of ops in →
// byte-identical gallery out on every peer (no indexer, no consensus). mergeGallery is
// the write-gate: it drops ops without a valid join attestation or over the byte caps,
// keeps a tip address only if a burn backs it, and keeps one entry per peer, hop-ordered.
// This demo runs mergeGallery over a hand-built bag of ops (no swarm needed).
// Run:  bare examples/gallery.js
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const { mergeGallery } = require('hyperwave-engine/lib/gallery');
const { signJoin } = require('hyperwave-engine/lib/attest');

const waveId = 'w1';

// Build a join-attested wave-selfie op signed by keyPair. writerKey is the peer's own
// gallery core key; the join attestation binds (waveId, peerId, writerKey) — that's the
// write-gate mergeGallery checks (there is no shared gallery key).
function selfie(keyPair, hopCount, caption, timestamp) {
  const peerId = b4a.toString(keyPair.publicKey, 'hex');
  const writerKey = b4a.toString(crypto.keyPair().publicKey, 'hex');
  return {
    type: 'wave-selfie',
    waveId,
    peerId,
    hopCount, // my rank in the angle-ordered sweep (the gallery ordering key)
    writerKey,
    joinSig: signJoin(keyPair, { waveId, writerKey }),
    image: '<jpeg-data-url>',
    caption,
    timestamp
  };
}

const alice = crypto.keyPair();
const bob = crypto.keyPair();

const forged = selfie(bob, 2, 'forged', 400);
forged.joinSig = '00'.repeat(64); // invalid join attestation → dropped by mergeGallery

const bag = [
  selfie(bob, 1, 'bob', 200),
  selfie(alice, 0, 'alice', 100),
  selfie(alice, 0, 'alice-newer', 300), // 2nd alice op → one-per-peer keeps the newest
  forged
];

const items = mergeGallery(bag);
console.log(
  'gallery (ordered by slot, one per peer, forged dropped):',
  items.map((entry) => entry.caption)
);
