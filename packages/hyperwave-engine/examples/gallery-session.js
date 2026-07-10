// gallery-session.js — the GallerySession manages the PER-WAVE gallery lifecycle over a
// Corestore: open/create the current wave's Autobase, the archivist rule (a wave I
// initiated is retained and reused; anyone else's is closed when moving on), and posting
// through the admission flow (trivially writable here — we're the creator).
// Run:  bare examples/gallery-session.js
const Corestore = require('corestore');
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const fs = require('bare-fs');
const { GallerySession } = require('hyperwave-engine/lib/gallery-session');
const { signReceipt } = require('hyperwave-engine/lib/token');

async function main() {
  const dir = '/tmp/hw-example-gallery-session-' + Date.now();
  const store = new Corestore(dir);
  const keyPair = crypto.keyPair();

  const session = new GallerySession({
    store,
    me: { id: b4a.toString(keyPair.publicKey, 'hex'), country: 'BR' },
    floodGossip: () => {}, // no mesh in this demo (admission floods ride this in wave.js)
    onGallery: (items) =>
      console.log(
        'gallery view:',
        items.map((entry) => entry.caption)
      ),
    onEvent: (evt) => console.log('event:', evt),
    enforcePaid: () => false, // wallet-less: receipt-only admission
    walletAddress: () => null,
    burnProof: () => null,
    log: (...args) => console.log('[session]', ...args)
  });

  // I initiate wave w1 → retain marks me its archivist.
  session.retain('w1');
  const mine = session.open('w1', null); // bootstrapKey=null → create fresh
  await mine.ready();
  console.log('current wave:', session.waveId, 'key:', session.key.slice(0, 12) + '…');

  // Post through the session: admission (we're the creator, already writable) + append.
  const receipt = {
    waveId: 'w1',
    hopCount: 0,
    prevChainHash: b4a.toString(b4a.alloc(32), 'hex'),
    timestamp: Date.now()
  };
  await session.postSelfie({
    waveId: receipt.waveId,
    hopCount: receipt.hopCount,
    chainHash: receipt.prevChainHash,
    receiptTs: receipt.timestamp,
    receiptSig: signReceipt(keyPair, receipt),
    caption: 'kick-off!',
    image: '<jpeg-data-url>'
  });

  // Moving on to someone else's wave: w1 is retained (still open for latecomers)…
  session.open('w2', null);
  console.log('moved on → current wave:', session.waveId);
  // …so coming back reuses the SAME Autobase (an unretained one would have been closed).
  console.log('back to my wave, same instance:', session.open('w1', null) === mine);

  session.tick(); // periodic pull for every held gallery (wave.js runs this on its ring tick)
  await new Promise((resolve) => setTimeout(resolve, 200)); // let the view emit
  await session.close();
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('FAIL', err);
  Bare.exit(1);
});
