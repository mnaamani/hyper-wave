// entry.js — the EntryPipeline pairs the host-staged entry payload with my sweep slot
// (arriving in either order) and posts the combined feed entry exactly once per wave.
// The payload is opaque to the engine — the host owns its shape. The burn proof survives
// reset() (it rides the entry as the tip-address binding) and drops only when a genuinely
// new wave begins. Stateless demo (the post callback logs). Run:  bare examples/entry.js
const { EntryPipeline } = require('hyperwave-engine/lib/entry');

const state = { waveId: 'w1' };
const pipeline = new EntryPipeline({
  currentWaveId: () => state.waveId,
  post: (entry) =>
    console.log('POST →', entry.payload, '(slot', entry.hopCount + ')')
});

const slot = { waveId: 'w1', hopCount: 3 }; // my rank in the angle-ordered sweep

// Either half can land first; whichever arrives second fires the post — exactly once.
// The payload is arbitrary JSON the host owns (here a {label}).
pipeline.stage({ payload: { label: 'hello' } });
console.log('staged (no post yet — waiting for my sweep slot)');
pipeline.recordSlot(slot); // → POST
pipeline.recordSlot(slot); // duplicate — the once-per-wave guard drops it

// The burn proof survives reset(): a fast wave can end before the fee burn confirms, and
// the proof is still the tip-address binding on the (already-posted or late) entry.
pipeline.setBurnProof({ waveId: 'w1', txHash: 'dead...', sig: 'beef...' });
pipeline.reset(); // wave ended — staging/slot/posted cleared…
console.log('after reset, burn proof kept:', pipeline.burnProof !== null);
pipeline.clearBurnProof(); // …but a NEW wave's lobby drops the old ticket
console.log('after a new wave, ticket kept:', pipeline.burnProof !== null);
