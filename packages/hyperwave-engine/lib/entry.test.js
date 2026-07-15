// EntryPipeline: pairing the lobby-captured entry with my sweep slot, posting exactly
// once per wave, and the burn-ticket lifetime (survives reset, dropped on a new wave —
// the "fast wave ends mid-post" gotcha). Pure — no swarm. Runs under
// Bare:  bare lib/entry.test.js   (or `npm test`)
const test = require('brittle');
const { EntryPipeline } = require('./entry');

const SLOT = { waveId: 'w1', hopCount: 2 };

// A pipeline wired to a controllable fake wave: flip `state` fields to simulate the
// engine; `posts` collects every entry the pipeline pushed to the feed.
function makePipeline({ waveId = 'w1' } = {}) {
  const state = { waveId };
  const posts = [];
  const pipeline = new EntryPipeline({
    currentWaveId: () => state.waveId,
    post: (entry) => posts.push(entry)
  });
  return { pipeline, posts, state };
}

test('stage then slot posts once, merging the payload into the entry', (t) => {
  const { pipeline, posts } = makePipeline();
  // the payload is opaque — an arbitrary JSON value the host owns
  const payload = { a: 1, nested: ['b', 'c'] };
  pipeline.stage({ payload });
  t.is(posts.length, 0, 'staged half alone does not post');
  pipeline.recordSlot(SLOT);
  t.is(posts.length, 1, 'posts when the second half lands');
  t.alike(posts[0], { ...SLOT, payload });
});

test('slot then stage posts once (halves arrive in either order)', (t) => {
  const { pipeline, posts } = makePipeline();
  pipeline.recordSlot(SLOT);
  t.is(posts.length, 0, 'slot alone does not post');
  pipeline.stage({ payload: 'anything' });
  t.is(posts.length, 1);
  t.is(posts[0].payload, 'anything', 'the opaque payload rides through');
});

test('a missing payload defaults to null', (t) => {
  const { pipeline, posts } = makePipeline();
  pipeline.recordSlot(SLOT);
  pipeline.stage();
  t.is(posts[0].payload, null, 'no payload → null');
});

test('posts exactly once per wave (re-staging or a duplicate slot never reposts)', (t) => {
  const { pipeline, posts } = makePipeline();
  pipeline.stage({ payload: 'one' });
  pipeline.recordSlot(SLOT);
  pipeline.stage({ payload: 'two' });
  pipeline.recordSlot({ ...SLOT, hopCount: 3 });
  t.is(posts.length, 1, 'the once-per-wave guard holds');
  t.is(posts[0].payload, 'one');
});

test('a slot for a superseded wave never posts', (t) => {
  const { pipeline, posts, state } = makePipeline();
  pipeline.stage({ payload: 'x' });
  pipeline.recordSlot(SLOT); // slot is for w1...
  state.waveId = 'w0'; // ...but a lower-id wave won before both halves paired
  pipeline.stage({ payload: 'x' }); // re-trigger pairing
  t.is(
    posts.filter((entry) => entry.waveId === 'w0').length,
    0,
    'never posts into another wave'
  );
});

test('reset clears staging/slot/posted so the next wave starts fresh', (t) => {
  const { pipeline, posts, state } = makePipeline();
  pipeline.stage({ payload: 'old' });
  pipeline.recordSlot(SLOT);
  t.is(posts.length, 1);
  pipeline.reset();
  state.waveId = 'w2';
  pipeline.stage({ payload: 'new' });
  pipeline.recordSlot({ ...SLOT, waveId: 'w2' });
  t.is(posts.length, 2, 'the posted guard was re-armed');
  t.is(posts[1].payload, 'new', 'no stale staged payload leaked across waves');
});

test('the burn proof survives reset (late tip-address binding) but not a new wave', (t) => {
  const { pipeline } = makePipeline();
  const proof = { waveId: 'w1', peerId: 'p1', txHash: 'dead', sig: 'beef' };
  pipeline.setBurnProof(proof);
  pipeline.reset(); // wave ended at network speed; the burn may confirm after
  t.is(
    pipeline.burnProof,
    proof,
    'reset keeps the proof for a late-confirming burn'
  );
  pipeline.clearBurnProof(); // a genuinely new wave's lobby began
  t.is(pipeline.burnProof, null, 'a new wave drops the previous ticket');
});
