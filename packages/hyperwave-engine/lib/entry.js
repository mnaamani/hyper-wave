// My-entry pipeline: the per-wave state machine that pairs the host-staged entry payload
// with my sweep slot and posts the combined feed entry exactly once. The two halves
// arrive in either order (the host can stage before or after my slot fires);
// whichever lands second triggers the post. Extracted from wave.js so the invariants live
// in one place:
//   - post exactly once per wave (#posted guard);
//   - only for the CURRENT wave (a stale slot from a superseded wave never posts);
//   - the burn proof survives reset() — the wave ends quickly but a joiner's
//     fee burn can confirm later, and the proof rides the (already-posted or late)
//     entry as its tip-address binding (it's bound to its waveId).
//     It's dropped only when a genuinely new wave begins (clearBurnProof, from enterLobby).
//
// The entry `payload` is opaque to the engine — an arbitrary JSON value the host stages
// (the desktop app puts a {image, caption} selfie in it; another host puts anything). The
// engine only transports and byte-caps it (feed.js).

/**
 * My sweep slot — recorded when the sweep reaches my ring position.
 * @typedef {Object} EntrySlot
 * @property {string} waveId - The wave this slot belongs to.
 * @property {number} hopCount - My rank in the sweep (feed ordering key).
 */

/**
 * The callbacks the pipeline is wired with (all supplied by wave.js).
 * @typedef {Object} EntryPipelineCtx
 * @property {function(): (string|null)} currentWaveId - The engaged wave's id, or null when idle.
 * @property {function(Object): void} post - Post the combined entry (slot + payload)
 *   to the feed (the writable wait + append happen inside; fire-and-forget here).
 */

/**
 * Pairs the staged entry payload with my sweep slot and posts exactly once per wave.
 */
class EntryPipeline {
  #staged = null; // { payload } staged by the host, awaiting my slot
  #slot = null; // my sweep slot once it fires, awaiting the payload
  #posted = false; // guard: post my entry exactly once per wave
  #burnProof = null; // my signed fee-burn attestation — the entry's tip-address binding
  #currentWaveId;
  #post;

  /**
   * @param {EntryPipelineCtx} ctx - The wave.js callbacks (see typedef).
   */
  constructor({ currentWaveId, post }) {
    this.#currentWaveId = currentWaveId;
    this.#post = post;
  }

  /**
   * The host staged my entry payload; it's posted to the feed when my sweep slot fires.
   * Staging may arrive before or after the slot — whichever half lands second fires the
   * post. The `payload` is opaque (arbitrary JSON the host owns); the engine never reads it.
   * @param {{payload?: *}} [entry] The staged payload.
   * @returns {void}
   */
  stage({ payload } = {}) {
    this.#staged = { payload: payload ?? null };
    this.#tryPost();
  }

  /**
   * Record my sweep slot when it fires (wave.js only arms the slot timer for a joined
   * roster member — spectators never reach here).
   * @param {EntrySlot} slot - My sweep slot.
   * @returns {void}
   */
  recordSlot(slot) {
    this.#slot = slot;
    this.#tryPost();
  }

  /**
   * Post once BOTH my slot (the sweep reached me) and the staged payload are available,
   * exactly once per wave, and only for the current wave.
   * @returns {void}
   */
  #tryPost() {
    if (this.#posted || !this.#slot || !this.#staged) {
      return;
    }
    if (this.#slot.waveId !== this.#currentWaveId()) {
      return;
    }
    this.#posted = true;
    this.#post({ ...this.#slot, payload: this.#staged.payload });
  }

  /**
   * Clear this wave's staged payload / slot / posted guard — but NOT the burn proof
   * (see the module header); it's dropped only by clearBurnProof() when a genuinely
   * new wave's lobby begins.
   * @returns {void}
   */
  reset() {
    this.#staged = null;
    this.#slot = null;
    this.#posted = false;
  }

  /**
   * My signed fee-burn attestation (the entry's tip-address binding), or null before
   * the worker reports a confirmed burn.
   * @returns {(Object|null)} The signed burn proof.
   */
  get burnProof() {
    return this.#burnProof;
  }

  /**
   * Stash my signed fee-burn attestation once the worker confirms the burn on-chain.
   * @param {Object} proof - The signed burn attestation (attest.js signBurn over its fields).
   * @returns {void}
   */
  setBurnProof(proof) {
    this.#burnProof = proof;
  }

  /**
   * A genuinely new wave began — the previous wave's burn ticket can never apply to it
   * (it's bound to its own waveId), so drop it (called from enterLobby, never from reset()).
   * @returns {void}
   */
  clearBurnProof() {
    this.#burnProof = null;
  }
}

module.exports = { EntryPipeline };
