// selfie.js — the SelfiePipeline pairs the lobby-captured selfie with the hop receipt
// (arriving in either order) and posts the combined gallery entry exactly once per wave.
// The burn proof survives reset() — the late-admission ticket — and drops only when a
// genuinely new wave begins. Stateless demo (the post callback just logs).
// Run:  bare examples/selfie.js
const { SelfiePipeline } = require('hyperwave-engine/lib/selfie');

const state = { canSelfie: true, waveId: 'w1' };
const pipeline = new SelfiePipeline({
  canSelfie: () => state.canSelfie,
  currentWaveId: () => state.waveId,
  post: (entry) =>
    console.log('POST →', entry.caption, '(hop', entry.hopCount + ')')
});

const receipt = {
  waveId: 'w1',
  hopCount: 3,
  receiptSig: 'aa'.repeat(32),
  chainHash: '00'.repeat(32),
  receiptTs: Date.now()
};

// Either half can land first; whichever arrives second fires the post — exactly once.
pipeline.stage({ image: '<jpeg-data-url>', caption: 'goal!' });
console.log('staged (no post yet — waiting for my hop)');
pipeline.recordReceipt(receipt); // → POST
pipeline.recordReceipt(receipt); // duplicate — the once-per-wave guard drops it

// The burn proof (gallery-admission ticket) survives reset(): a fast wave can end before
// the fee burn confirms, and the ticket still admits a LATE post into the kept gallery.
pipeline.setBurnProof({ waveId: 'w1', txHash: 'dead...', sig: 'beef...' });
pipeline.reset(); // wave ended — staging/receipt/posted cleared…
console.log('after reset, ticket kept:', pipeline.burnProof !== null);
pipeline.clearBurnProof(); // …but a NEW wave's lobby drops the old ticket
console.log('after a new wave, ticket kept:', pipeline.burnProof !== null);
