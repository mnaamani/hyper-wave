// The concentric wave rings (ring.js) — geometry, the inward drift, and the pointer contract.
//   node --test renderer/lib/     (or `npm run test:renderer` from the repo root)
//
// This is the only automated coverage the renderer has, and it earned its place: the walk-the-
// pointer-in case below is what caught a shipped bug where the ✕ could never be clicked, because
// the badge sits outside the ring's own hit band and moving toward it dropped the hover that drew
// it. Assert what a USER does (move, then click), not just what the functions return.
//
// ring.js is a singleton module owning one canvas and one rAF loop, so these tests deliberately
// run in order and share that state — each picks up the field the previous one left.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installCanvas } from './canvas-stub.js';

const SIZE = 700;
const CENTRE = SIZE / 2;
const OUTER_MARGIN = 36; // ring.js's own constant, mirrored so the expectation is explicit
const DISMISS_INSET = 26;

const dom = installCanvas({ size: SIZE, dpr: 2 });
// Dynamic, so the stub globals exist before ring.js grabs its canvas at module scope.
const ring = await import('./ring.js');

const PEER_A = 'aa'.repeat(16);
const PEER_B = 'bb'.repeat(16);
const PEER_C = 'cc'.repeat(16);

const waves = new Map([
  ['w-lobby', { waveId: 'w-lobby', phase: 'lobby', by: PEER_B, count: 3 }],
  ['w-race', { waveId: 'w-race', phase: 'racing', by: PEER_C, count: 5 }],
  [
    'w-end',
    { waveId: 'w-end', phase: 'ended', by: PEER_A, count: 2, mine: true }
  ]
]);

// The distinct full-circle arcs centred on the canvas centre — i.e. the rings, outermost first.
function ringRadii() {
  const centred = dom
    .calls()
    .filter(([op, x, y]) => op === 'arc' && x === CENTRE && y === CENTRE)
    .map(([, , , radius]) => Math.round(radius));
  return [...new Set(centred)].sort((left, right) => right - left);
}

// Where a wave's ✕ badge is drawn: inside its ring, at the initiator's seat angle.
function badgePoint(peerId, ringRadius) {
  const radians = ((ring.angleOfId(peerId) - 90) * Math.PI) / 180;
  const radius = ringRadius - DISMISS_INSET;
  return {
    clientX: CENTRE + radius * Math.cos(radians),
    clientY: CENTRE + radius * Math.sin(radians)
  };
}

function drewDismissBadge() {
  return dom.calls().some(([op, text]) => op === 'fillText' && text === '✕');
}

ring.setState({
  me: { id: PEER_A, angle: ring.angleOfId(PEER_A), country: 'KE' },
  peers: [
    { id: PEER_B, angle: ring.angleOfId(PEER_B), country: 'BR' },
    { id: PEER_C, angle: ring.angleOfId(PEER_C), country: 'JP' }
  ]
});
ring.setWaves(waves, 'w-race');
ring.setActiveSeats([{ id: PEER_C, country: 'JP' }]);
ring.start();

test('the backing store is the CSS box scaled by devicePixelRatio', () => {
  dom.frames(1);
  assert.equal(dom.canvas.width, SIZE * 2);
  assert.equal(dom.canvas.height, SIZE * 2);
});

test('a new ring is born on the topic ring, not at its final band', () => {
  dom.frames(1);
  const radii = ringRadii();
  assert.equal(radii[0], SIZE / 2 - OUTER_MARGIN, 'topic ring is outermost');
  for (const radius of radii.slice(1)) {
    assert.ok(
      radii[0] - radius < 20,
      `a wave ring started at ${radius}, far from the topic ring ${radii[0]}`
    );
  }
});

test('rings drift to their lifecycle bands: lobby → racing → ended, inward', () => {
  dom.frames(220); // ~3.5s of easing
  const radii = ringRadii();
  assert.equal(radii.length, 4, 'topic ring + one per wave');
  assert.deepEqual(radii, [314, 286, 228, 170]);
});

test('no ring encroaches on the centre stage', () => {
  assert.ok(Math.min(...ringRadii()) >= 148);
});

test('a fading wave falls inward to the stage floor', () => {
  waves.set('w-end', { ...waves.get('w-end'), fading: true });
  ring.setWaves(waves, 'w-race');
  dom.frames(60);
  const innermost = Math.min(...ringRadii());
  assert.ok(innermost < 170, `expected a fall, got ${innermost}`);

  waves.set('w-end', { ...waves.get('w-end'), fading: false });
  ring.setWaves(waves, 'w-race');
  dom.frames(220); // settle again for the tests below
});

test('clicking a ghost ring selects that wave', () => {
  let selected = null;
  ring.onWaveSelect((waveId) => {
    selected = waveId;
  });
  const lobbyRadius = ringRadii()[1];

  assert.equal(ring.selectableWaveAt(CENTRE + lobbyRadius, CENTRE), 'w-lobby');
  dom.fire('click', { clientX: CENTRE + lobbyRadius, clientY: CENTRE });
  assert.equal(selected, 'w-lobby');
});

test('the active ring is the scrubber’s, never a selection target', () => {
  for (const radius of ringRadii().slice(1)) {
    assert.notEqual(ring.selectableWaveAt(CENTRE + radius, CENTRE), 'w-race');
  }
});

test('a click in the empty centre selects nothing', () => {
  assert.equal(ring.selectableWaveAt(CENTRE + 5, CENTRE), null);
});

test('the ✕ is inert until its ring is hovered', () => {
  let dismissed = null;
  ring.onWaveDismiss((waveId) => {
    dismissed = waveId;
  });
  dom.fire('pointerleave', {});
  dom.fire('click', badgePoint(PEER_B, ringRadii()[1]));
  assert.equal(dismissed, null, 'a badge nobody can see must not be clickable');
});

// THE REGRESSION: a real pointer travels to the badge, firing pointermove on the way. The badge
// sits inside the ring, outside its hit band — so if hover is only kept near the ring line, the ✕
// vanishes before the pointer arrives and the click lands on nothing.
test('the ✕ survives the pointer moving onto it, and dismisses', () => {
  let dismissed = null;
  ring.onWaveDismiss((waveId) => {
    dismissed = waveId;
  });
  const lobbyRadius = ringRadii()[1];

  dom.fire('pointermove', { clientX: CENTRE + lobbyRadius, clientY: CENTRE });
  dom.frames(2);
  assert.ok(drewDismissBadge(), 'hovering the ring reveals its ✕');

  const badge = badgePoint(PEER_B, ringRadii()[1]);
  dom.fire('pointermove', badge);
  dom.frames(2);
  assert.ok(
    drewDismissBadge(),
    'the ✕ is still there once the pointer reaches it'
  );

  dom.fire('click', badge);
  assert.equal(dismissed, 'w-lobby');
});

test('the rings claim the presses that are theirs, and no others', () => {
  // the host removes a dismissed wave (app-core does it); the ring just stops being handed it
  waves.delete('w-lobby');
  ring.setWaves(waves, 'w-race');
  dom.frames(220);
  const radii = ringRadii();
  assert.equal(radii.length, 3, 'the dismissed ring is gone');
  assert.equal(radii[1], 286, 'and the survivors re-settled');

  assert.equal(
    ring.claimsPointer(CENTRE + radii[2], CENTRE),
    true,
    'a press on a ghost ring belongs to the rings'
  );
  assert.equal(
    ring.claimsPointer(CENTRE + 60, CENTRE),
    false,
    'a press in open space belongs to the scrubber'
  );
});

test('a cross-network wave is filtered out of the field entirely', () => {
  // the local wallet's network is unset here, and networksMatch is permissive about unknowns, so
  // this wave SHOWS — the assertion pins the permissive half of the rule
  const before = ringRadii().length;
  waves.set('w-other', {
    waveId: 'w-other',
    phase: 'lobby',
    by: PEER_B,
    count: 9,
    network: 'mainnet'
  });
  ring.setWaves(waves, 'w-race');
  dom.frames(2);
  assert.equal(ringRadii().length, before + 1);
});
