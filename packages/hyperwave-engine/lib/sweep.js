// The deterministic angular sweep (protocol.md §6): pure slot
// math, no transport. A wave-start carries the canonical roster plus `t0` (epoch ms)
// and `lapMs`; every peer derives the SAME schedule locally — roster sorted by ring
// angle, one slot per member, evenly spread across the lap — and self-triggers at its
// own slot. Nothing is passed peer-to-peer, so nothing can stall: a dead peer's
// slot simply passes.
const { angleOfId } = require('./ring');

/**
 * One entry of a sweep schedule.
 * @typedef {Object} SweepSlot
 * @property {string} id - The roster member's hex peer id.
 * @property {number} angle - Its ring angle in degrees (derived from the id).
 * @property {number} rank - Its position in the sweep (0 = first to fire).
 * @property {number} at - Epoch ms this slot fires.
 */

/**
 * Derive the full sweep schedule from the canonical roster. Deterministic: every
 * peer that receives the same (rosterIds, t0, lapMs) computes the identical
 * schedule. Order is by ring angle (id as a tie-break), matching the visual
 * clockwise wave; slots are spread evenly across the lap starting at t0.
 * @param {Object} opts The sweep parameters (from wave-start).
 * @param {string[]} opts.rosterIds The canonical roster (as flooded by the initiator).
 * @param {number} opts.t0 Epoch ms the sweep starts.
 * @param {number} opts.lapMs Duration of the full lap.
 * @returns {SweepSlot[]} The schedule, ordered by firing time.
 */
function sweepSchedule({ rosterIds, t0, lapMs }) {
  const seats = [...new Set(rosterIds)].map((id) => ({
    id,
    angle: angleOfId(id)
  }));
  seats.sort((a, b) => {
    if (a.angle !== b.angle) {
      return a.angle - b.angle;
    }
    return a.id < b.id ? -1 : 1;
  });
  const count = seats.length;
  return seats.map((seat, rank) => ({
    id: seat.id,
    angle: seat.angle,
    rank,
    at: t0 + Math.round((rank / count) * lapMs)
  }));
}

/**
 * My slot in a schedule, or null if I'm not in the roster (spectator).
 * @param {SweepSlot[]} schedule The derived sweep schedule.
 * @param {string} myId My hex peer id.
 * @returns {(SweepSlot|null)} My slot.
 */
function mySlot(schedule, myId) {
  for (const slot of schedule) {
    if (slot.id === myId) {
      return slot;
    }
  }
  return null;
}

module.exports = { sweepSchedule, mySlot };
