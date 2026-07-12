// My-selfie pipeline: the per-wave state machine that pairs the lobby-captured selfie
// with my sweep slot and posts the combined gallery entry exactly once. The two halves
// arrive in either order (the renderer can stage before or after my slot fires);
// whichever lands second triggers the post. Extracted from wave.js so the invariants live
// in one place:
//   - post exactly once per wave (#posted guard);
//   - only for the CURRENT wave (a stale slot from a superseded wave never posts);
//   - only when opted in (ctx.canSelfie — roster members, not spectators);
//   - the burn proof survives reset() — the wave ends quickly but a joiner's
//     fee burn can confirm later, and the proof rides the (already-posted or late)
//     entry as its tip-address binding (it's bound to its waveId).
//     It's dropped only when a genuinely new wave begins (clearBurnProof, from enterLobby).

/**
 * My sweep slot — recorded when the sweep reaches my ring position.
 * @typedef {Object} SelfieSlot
 * @property {string} waveId - The wave this slot belongs to.
 * @property {number} hopCount - My rank in the sweep (gallery ordering key).
 */

/**
 * The callbacks the pipeline is wired with (all supplied by wave.js).
 * @typedef {Object} SelfiePipelineCtx
 * @property {function(): boolean} canSelfie - Am I opted into the current wave (roster member)?
 * @property {function(): (string|null)} currentWaveId - The engaged wave's id, or null when idle.
 * @property {function(Object): void} post - Post the combined entry (slot + image + caption)
 *   to the gallery (the writable wait + append happen inside; fire-and-forget here).
 */

/**
 * Pairs the staged lobby selfie with my sweep slot and posts exactly once per wave.
 */
class SelfiePipeline {
  #staged = null; // { image, caption } captured in the lobby, awaiting my slot
  #slot = null; // my sweep slot once it fires, awaiting the selfie
  #posted = false; // guard: post my selfie exactly once per wave
  #burnProof = null; // my signed fee-burn attestation — my gallery-admission ticket
  #canSelfie;
  #currentWaveId;
  #post;

  /**
   * @param {SelfiePipelineCtx} ctx - The wave.js callbacks (see typedef).
   */
  constructor({ canSelfie, currentWaveId, post }) {
    this.#canSelfie = canSelfie;
    this.#currentWaveId = currentWaveId;
    this.#post = post;
  }

  /**
   * The renderer captured my selfie during the lobby and stages it here; it's posted to
   * the gallery when my sweep slot fires. Staging may arrive before or after the slot —
   * whichever half lands second fires the post.
   * @param {{image?: string, caption?: string}} [selfie] The captured frame + optional caption.
   * @returns {void}
   */
  stage({ image, caption } = {}) {
    this.#staged = { image: image || '', caption: caption || '' };
    this.#tryPost();
  }

  /**
   * Record my sweep slot when it fires. Ignored unless I'm an opted-in roster member
   * (spectators never selfie).
   * @param {SelfieSlot} slot - My sweep slot.
   * @returns {void}
   */
  recordSlot(slot) {
    if (!this.#canSelfie()) {
      return;
    }
    this.#slot = slot;
    this.#tryPost();
  }

  /**
   * Post once BOTH my slot (the sweep reached me) and the staged image (captured in the
   * lobby) are available, exactly once per wave, and only for the current wave.
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
    this.#post({
      ...this.#slot,
      image: this.#staged.image,
      caption: this.#staged.caption
    });
  }

  /**
   * Clear this wave's staged selfie / slot / posted guard — but NOT the burn proof
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
   * My signed fee-burn attestation (the gallery-admission ticket), or null before the
   * worker reports a confirmed burn.
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
   * A genuinely new wave began — the previous wave's burn ticket can never admit it,
   * so drop it (called from enterLobby, never from reset()).
   * @returns {void}
   */
  clearBurnProof() {
    this.#burnProof = null;
  }
}

module.exports = { SelfiePipeline };
