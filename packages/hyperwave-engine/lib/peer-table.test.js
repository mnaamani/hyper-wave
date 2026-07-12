// PeerTable: the consistency rules across seats / channels / pins / churn cooldowns —
// wire-supplied angles are never trusted, fresher sightings win, a direct disconnect is
// authoritative (immediate drop + cooldown so ghosts can't be resurrected), and pin
// updates come back as a mirrorable diff. Pure — no swarm. Runs under Bare:
//   bare lib/peer-table.test.js   (or `npm test`)
const test = require('brittle');
const { PeerTable } = require('./peer-table');
const { angleOfId } = require('./ring');

const ME = 'ff'.repeat(32);
const PEER_A = 'aa'.repeat(32);
const PEER_B = '11'.repeat(32);
const STALE_MS = 1000;
const NOOP_SEND = () => {};

function makeTable() {
  return new PeerTable({ meId: ME, staleMs: STALE_MS });
}

test('upsert derives the angle from the id and never seats me', (t) => {
  const table = makeTable();
  table.upsert(PEER_A, Date.now());
  table.upsert(ME, Date.now());
  const ring = table.liveRing();
  t.is(ring.length, 1, 'my own id is never a seat');
  t.is(
    ring[0].angle,
    angleOfId(PEER_A),
    'angle comes from the id, not the wire'
  );
});

test('a fresher sighting wins; a staler one may still contribute its country', (t) => {
  const table = makeTable();
  const now = Date.now();
  table.upsert(PEER_A, now, 'BR');
  table.upsert(PEER_A, now - 500); // staler, no country
  let seat = table.liveRing(now)[0];
  t.is(seat.lastSeen, now, 'staler sighting does not roll lastSeen back');
  t.is(seat.country, 'BR', 'known country survives a country-less refresh');
  table.upsert(PEER_A, now - 500, 'AR'); // staler but carries a country
  seat = table.liveRing(now)[0];
  t.is(
    seat.country,
    'AR',
    'a stale sighting can still update the cosmetic country'
  );
});

test('liveRing drops stale seats and sorts clockwise by angle', (t) => {
  const table = makeTable();
  const now = Date.now();
  table.upsert(PEER_A, now);
  table.upsert(PEER_B, now - STALE_MS - 1);
  const ring = table.liveRing(now);
  t.alike(
    ring.map((seat) => seat.id),
    [PEER_A],
    'the stale seat dropped'
  );
  table.upsert(PEER_B, now);
  t.alike(
    table.liveRing(now).map((seat) => seat.angle),
    table
      .liveRing(now)
      .map((seat) => seat.angle)
      .sort((a, b) => a - b),
    'sorted by angle'
  );
});

test('onConnect seats the peer, stores its channel, and lifts the cooldown', (t) => {
  const table = makeTable();
  table.onDisconnect(PEER_A); // puts A in cooldown
  t.ok(table.coolingDown(PEER_A), 'disconnect starts the churn cooldown');
  table.onConnect(PEER_A, NOOP_SEND);
  t.absent(table.coolingDown(PEER_A), 'reconnect lifts it');
  t.ok(table.hasSender(PEER_A));
  t.is(table.send(PEER_A), NOOP_SEND);
  t.is(table.liveRing().length, 1, 'connected peer is seated');
});

test('onDisconnect is authoritative: seat + channel drop at once, cooldown starts', (t) => {
  const table = makeTable();
  table.onConnect(PEER_A, NOOP_SEND);
  table.onConnect(PEER_B, NOOP_SEND);
  const first = table.onDisconnect(PEER_A);
  t.alike(first, { solo: false, wasPinned: false });
  t.absent(table.hasSender(PEER_A));
  t.is(table.liveRing().length, 1, 'the seat dropped immediately');
  t.ok(table.coolingDown(PEER_A), 'ghost-resurrection guard armed');
  const second = table.onDisconnect(PEER_B);
  t.is(second.solo, true, 'last connection gone -> solo');
});

test('the cooldown expires (and self-prunes) after staleMs', (t) => {
  const table = makeTable();
  table.onDisconnect(PEER_A);
  const now = Date.now();
  t.ok(table.coolingDown(PEER_A, now), 'active within the window');
  t.absent(table.coolingDown(PEER_A, now + STALE_MS + 1), 'expired after it');
  t.absent(table.coolingDown(PEER_A, now), 'expired check pruned the entry');
});

test('updatePins diffs against the desired targets and reports the churn', (t) => {
  const table = makeTable();
  const first = table.updatePins(new Set([PEER_A, PEER_B]));
  t.alike(
    first.added.sort(),
    [PEER_A, PEER_B].sort(),
    'all new targets pinned'
  );
  t.alike(first.removed, []);
  const second = table.updatePins(new Set([PEER_B]));
  t.alike(second.added, []);
  t.alike(second.removed, [PEER_A], 'a dropped target is unpinned');
  t.alike([...table.pinnedIds()], [PEER_B]);
  t.is(
    table.onDisconnect(PEER_B).wasPinned,
    true,
    'pin state feeds the churn repair'
  );
});

test('knownIds is pinned ∪ connected, deduped', (t) => {
  const table = makeTable();
  table.onConnect(PEER_A, NOOP_SEND);
  table.updatePins(new Set([PEER_A, PEER_B])); // A is both pinned and connected
  t.alike(table.knownIds().sort(), [PEER_A, PEER_B].sort());
});
