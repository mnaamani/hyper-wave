// PeerTable: the consistency rules across seats / channels — wire-supplied angles are
// never trusted, fresher sightings win, and a direct disconnect is authoritative
// (immediate seat + channel drop). Pure — no swarm. Runs under Bare:
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

function channelOf(table, id) {
  return new Map(table.senderEntries()).get(id);
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

test('a fresher sighting wins; a staler one may still contribute its tag', (t) => {
  const table = makeTable();
  const now = Date.now();
  table.upsert(PEER_A, now, 'BR');
  table.upsert(PEER_A, now - 500); // staler, no tag
  let seat = table.liveRing(now)[0];
  t.is(seat.lastSeen, now, 'staler sighting does not roll lastSeen back');
  t.is(seat.tag, 'BR', 'known tag survives a tag-less refresh');
  table.upsert(PEER_A, now - 500, 'AR'); // staler but carries a tag
  seat = table.liveRing(now)[0];
  t.is(seat.tag, 'AR', 'a stale sighting can still update the cosmetic tag');
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

test('onConnect seats the peer and stores its channel', (t) => {
  const table = makeTable();
  table.onConnect(PEER_A, NOOP_SEND);
  t.is(channelOf(table, PEER_A), NOOP_SEND);
  t.is(table.liveRing().length, 1, 'connected peer is seated');
});

test('onDisconnect is authoritative: seat + channel drop at once', (t) => {
  const table = makeTable();
  table.onConnect(PEER_A, NOOP_SEND);
  table.onConnect(PEER_B, NOOP_SEND);
  table.onDisconnect(PEER_A);
  t.absent(channelOf(table, PEER_A), 'channel dropped');
  t.is(table.liveRing().length, 1, 'the seat dropped immediately');
  t.alike([...table.senderIds()], [PEER_B], 'only the live channel remains');
});
