// Random-K pin selection (pins.js): sticky top-up semantics — keep valid pins,
// never re-roll them, fill to budget from the candidate pool, drop dead ones.
// Pure — no swarm. Runs under Bare:  bare lib/pins.test.js   (or `npm test`)
const test = require('brittle');
const { topUpPins } = require('./pins');

// Deterministic "RNG": pops preset values (defaults to 0 → always pick pool[0]).
function fakeRandom(values = []) {
  return () => (values.length ? values.shift() : 0);
}

test('fills an empty pin set up to the budget from candidates', (t) => {
  const targets = topUpPins({
    current: [],
    candidates: ['a', 'b', 'c', 'd'],
    budget: 3,
    random: fakeRandom()
  });
  t.is(targets.size, 3, 'holds exactly the budget');
  for (const id of targets) {
    t.ok(['a', 'b', 'c', 'd'].includes(id), 'only ever picks candidates');
  }
});

test('sticky: still-valid pins are kept, never re-rolled', (t) => {
  const targets = topUpPins({
    current: ['b', 'c'],
    candidates: ['a', 'b', 'c', 'd'],
    budget: 3,
    random: fakeRandom()
  });
  t.ok(targets.has('b') && targets.has('c'), 'existing pins survive');
  t.is(targets.size, 3, 'topped up by exactly one new pin');
});

test('a pin that is no longer a candidate (dead) is dropped and replaced', (t) => {
  const targets = topUpPins({
    current: ['dead', 'b'],
    candidates: ['a', 'b', 'c'],
    budget: 2,
    random: fakeRandom()
  });
  t.absent(targets.has('dead'), 'a dead pin is not kept');
  t.ok(targets.has('b'), 'the live pin is kept');
  t.is(targets.size, 2, 'replaced from the pool');
});

test('holds fewer than budget when candidates run out (never invents peers)', (t) => {
  const targets = topUpPins({
    current: [],
    candidates: ['a'],
    budget: 7,
    random: fakeRandom()
  });
  t.alike([...targets], ['a']);
});

test('over-budget current pins are trimmed to the budget', (t) => {
  const targets = topUpPins({
    current: ['a', 'b', 'c', 'd'],
    candidates: ['a', 'b', 'c', 'd'],
    budget: 2,
    random: fakeRandom()
  });
  t.is(targets.size, 2, 'never holds more than the budget');
});

test('random picks are drawn without replacement across the pool', (t) => {
  // random always returns 0.99… → always the last pool entry; the swap-pop
  // must still yield distinct picks.
  const targets = topUpPins({
    current: [],
    candidates: ['a', 'b', 'c'],
    budget: 3,
    random: () => 0.999
  });
  t.alike([...targets].sort(), ['a', 'b', 'c'], 'no duplicates, full fill');
});
