// SelfiePipeline: pairing the lobby-captured selfie with my hop receipt, posting exactly
// once per wave, and the burn-ticket lifetime (survives reset, dropped on a new wave —
// the "fast wave ends mid-admission" gotcha). Pure — no swarm, no Autobase. Runs under
// Bare:  bare lib/selfie.test.js   (or `npm test`)
const test = require('brittle');
const { SelfiePipeline } = require('./selfie');

const RECEIPT = {
  waveId: 'w1',
  hopCount: 2,
  receiptSig: 'aa'.repeat(32),
  chainHash: '00'.repeat(32),
  receiptTs: 1000
};

// A pipeline wired to a controllable fake wave: flip `state` fields to simulate the
// engine; `posts` collects every entry the pipeline pushed to the gallery.
function makePipeline({ canSelfie = true, waveId = 'w1' } = {}) {
  const state = { canSelfie, waveId };
  const posts = [];
  const pipeline = new SelfiePipeline({
    canSelfie: () => state.canSelfie,
    currentWaveId: () => state.waveId,
    post: (entry) => posts.push(entry)
  });
  return { pipeline, posts, state };
}

test('stage then receipt posts once, merging image + caption into the entry', (t) => {
  const { pipeline, posts } = makePipeline();
  pipeline.stage({ image: 'data:jpeg', caption: 'goal!' });
  t.is(posts.length, 0, 'staged half alone does not post');
  pipeline.recordReceipt(RECEIPT);
  t.is(posts.length, 1, 'posts when the second half lands');
  t.alike(posts[0], { ...RECEIPT, image: 'data:jpeg', caption: 'goal!' });
});

test('receipt then stage posts once (halves arrive in either order)', (t) => {
  const { pipeline, posts } = makePipeline();
  pipeline.recordReceipt(RECEIPT);
  t.is(posts.length, 0, 'receipt alone does not post');
  pipeline.stage({ image: 'data:jpeg' });
  t.is(posts.length, 1);
  t.is(posts[0].caption, '', 'missing caption defaults to empty');
});

test('posts exactly once per wave (re-staging or a duplicate receipt never reposts)', (t) => {
  const { pipeline, posts } = makePipeline();
  pipeline.stage({ image: 'one' });
  pipeline.recordReceipt(RECEIPT);
  pipeline.stage({ image: 'two' });
  pipeline.recordReceipt({ ...RECEIPT, hopCount: 3 });
  t.is(posts.length, 1, 'the once-per-wave guard holds');
  t.is(posts[0].image, 'one');
});

test('a receipt for a superseded wave never posts', (t) => {
  const { pipeline, posts, state } = makePipeline();
  pipeline.stage({ image: 'data:jpeg' });
  pipeline.recordReceipt(RECEIPT); // receipt is for w1...
  state.waveId = 'w0'; // ...but a lower-id wave won before both halves paired
  pipeline.stage({ image: 'data:jpeg' }); // re-trigger pairing
  t.is(
    posts.filter((entry) => entry.waveId === 'w0').length,
    0,
    'never posts into another wave'
  );
});

test('receipts are ignored unless opted in (relays never selfie)', (t) => {
  const { pipeline, posts, state } = makePipeline({ canSelfie: false });
  pipeline.stage({ image: 'data:jpeg' });
  pipeline.recordReceipt(RECEIPT);
  t.is(posts.length, 0, 'a non-roster relay holds the ball but never posts');
  state.canSelfie = true;
  pipeline.recordReceipt(RECEIPT);
  t.is(posts.length, 1, 'an opted-in peer posts as usual');
});

test('reset clears staging/receipt/posted so the next wave starts fresh', (t) => {
  const { pipeline, posts, state } = makePipeline();
  pipeline.stage({ image: 'old' });
  pipeline.recordReceipt(RECEIPT);
  t.is(posts.length, 1);
  pipeline.reset();
  state.waveId = 'w2';
  pipeline.stage({ image: 'new' });
  pipeline.recordReceipt({ ...RECEIPT, waveId: 'w2' });
  t.is(posts.length, 2, 'the posted guard was re-armed');
  t.is(posts[1].image, 'new', 'no stale staged frame leaked across waves');
});

test('the burn proof survives reset (late-admission ticket) but not a new wave', (t) => {
  const { pipeline } = makePipeline();
  const proof = { waveId: 'w1', peerId: 'p1', txHash: 'dead', sig: 'beef' };
  pipeline.setBurnProof(proof);
  pipeline.reset(); // wave ended at network speed; the burn may confirm after
  t.is(
    pipeline.burnProof,
    proof,
    'reset keeps the ticket for a late gallery admission'
  );
  pipeline.clearBurnProof(); // a genuinely new wave's lobby began
  t.is(pipeline.burnProof, null, 'a new wave drops the previous ticket');
});
