// gallery.js — the wave selfie gallery is an Autobase multi-writer log merged into one
// ordered view. galleryConfig() is the apply/open config; readGallery() reads it back.
// apply() enforces the write-gate (valid receipt), byte caps, and one-entry-per-peer
// deterministically on every peer. Run:  bare examples/gallery.js
const Corestore = require('corestore');
const Autobase = require('autobase');
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const fs = require('bare-fs');
const { galleryConfig, readGallery } = require('hyperwave-lib-core/lib/gallery');
const { signReceipt } = require('hyperwave-lib-core/lib/token');

const waveId = 'w1';
const chainHash = b4a.toString(b4a.alloc(32), 'hex');

// Build a receipt-valid wave-selfie op signed by keyPair for a given hop.
function selfie(keyPair, hopCount, caption, timestamp) {
  const peerId = b4a.toString(keyPair.publicKey, 'hex');
  const receiptTs = timestamp;
  return {
    type: 'wave-selfie',
    waveId,
    peerId,
    hopCount,
    chainHash,
    receiptTs,
    receiptSig: signReceipt(keyPair, waveId, hopCount, chainHash, receiptTs),
    image: '<jpeg-data-url>',
    caption,
    timestamp
  };
}

async function main() {
  const dir = '/tmp/hw-example-gallery-' + Date.now();
  const store = new Corestore(dir);
  const base = new Autobase(store.namespace('wave-gallery'), null, galleryConfig());
  await base.ready();
  console.log('gallery bootstrap key:', b4a.toString(base.key, 'hex').slice(0, 12) + '…');

  const alice = crypto.keyPair();
  const bob = crypto.keyPair();

  await base.append(selfie(bob, 1, 'bob', 200));
  await base.append(selfie(alice, 0, 'alice', 100));
  await base.append(selfie(alice, 0, 'alice-again', 300)); // 2nd from alice → dropped at write
  const unsigned = selfie(bob, 2, 'forged', 400);
  unsigned.receiptSig = '00'.repeat(64); // invalid receipt → dropped by apply()
  await base.append(unsigned);
  await base.update();

  const items = await readGallery(base);
  console.log(
    'gallery (ordered by hop, one per peer):',
    items.map((entry) => entry.caption)
  );

  await base.close();
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('FAIL', err);
  Bare.exit(1);
});
