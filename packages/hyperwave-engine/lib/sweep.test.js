// Sweep slot math (sweep.js): deterministic schedules from the canonical roster —
// angle ordering, even slot spacing across the lap, cross-peer determinism, and
// spectator lookup. Pure — no swarm, no timers. Runs under Bare:
//   bare lib/sweep.test.js   (or `npm test`)
const test = require('brittle');
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const { sweepSchedule, mySlot, archivists } = require('./sweep');
const { angleOfId } = require('./ring');

const T0 = 1_800_000_000_000;
const LAP_MS = 12000;

function randomIds(count) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    ids.push(b4a.toString(crypto.keyPair().publicKey, 'hex'));
  }
  return ids;
}

test('schedule is angle-ordered with evenly spaced slots across the lap', (t) => {
  const rosterIds = randomIds(6);
  const schedule = sweepSchedule({ rosterIds, t0: T0, lapMs: LAP_MS });
  t.is(schedule.length, 6, 'one slot per roster member');
  for (let i = 0; i < schedule.length; i++) {
    const slot = schedule[i];
    t.is(slot.rank, i, 'rank matches position');
    t.is(slot.angle, angleOfId(slot.id), 'angle derived from the id');
    t.is(slot.at, T0 + Math.round((i / 6) * LAP_MS), 'evenly spaced');
    if (i > 0) {
      t.ok(slot.angle >= schedule[i - 1].angle, 'sorted clockwise by angle');
    }
  }
  t.is(schedule[0].at, T0, 'the first slot fires at t0');
  t.ok(schedule[5].at < T0 + LAP_MS, 'the last slot fires before the lap ends');
});

test('every peer derives the identical schedule from the same wave-start', (t) => {
  const rosterIds = randomIds(9);
  const shuffled = [...rosterIds].reverse();
  const scheduleA = sweepSchedule({ rosterIds, t0: T0, lapMs: LAP_MS });
  const scheduleB = sweepSchedule({
    rosterIds: shuffled,
    t0: T0,
    lapMs: LAP_MS
  });
  t.alike(scheduleA, scheduleB, 'roster order on the wire does not matter');
});

test('duplicate roster ids collapse to one slot', (t) => {
  const [only] = randomIds(1);
  const schedule = sweepSchedule({
    rosterIds: [only, only, only],
    t0: T0,
    lapMs: LAP_MS
  });
  t.is(schedule.length, 1);
  t.is(schedule[0].at, T0, 'a solo sweep fires immediately at t0');
});

test('mySlot finds my slot; spectators (not in the roster) get null', (t) => {
  const rosterIds = randomIds(4);
  const schedule = sweepSchedule({ rosterIds, t0: T0, lapMs: LAP_MS });
  const mine = mySlot(schedule, rosterIds[2]);
  t.ok(mine, 'roster member has a slot');
  t.is(mine.id, rosterIds[2]);
  t.is(mySlot(schedule, 'ff'.repeat(32)), null, 'spectator has none');
});

test('archivists: K spread around the ring, deterministic, same for every peer', (t) => {
  const rosterIds = randomIds(30);
  const scheduleA = sweepSchedule({ rosterIds, t0: T0, lapMs: LAP_MS });
  // a different peer with the roster in wire-shuffled order derives the same schedule…
  const scheduleB = sweepSchedule({
    rosterIds: [...rosterIds].reverse(),
    t0: T0,
    lapMs: LAP_MS
  });
  const setA = archivists(scheduleA, 3);
  const setB = archivists(scheduleB, 3);
  t.is(setA.size, 3, 'picks exactly K');
  t.alike([...setA].sort(), [...setB].sort(), 'every peer agrees on the set');
  // spread: chosen ranks are ~evenly spaced (0, 10, 20 for N=30, K=3)
  const ranks = scheduleA
    .map((slot, rank) => (setA.has(slot.id) ? rank : -1))
    .filter((rank) => rank >= 0);
  t.alike(ranks, [0, 10, 20], 'ranks are evenly spaced around the ring');
});

test('archivists: a roster smaller than K makes everyone an archivist', (t) => {
  const rosterIds = randomIds(2);
  const schedule = sweepSchedule({ rosterIds, t0: T0, lapMs: LAP_MS });
  const set = archivists(schedule, 3);
  t.is(set.size, 2, 'clamped to the roster size');
  for (const id of rosterIds) {
    t.ok(set.has(id), 'every member archives when the roster is tiny');
  }
});
