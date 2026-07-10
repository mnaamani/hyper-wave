// My-selfie pipeline: the per-wave state machine that pairs the lobby-captured selfie
// with my hop receipt and posts the combined gallery entry exactly once. The two halves
// arrive in either order (the renderer can stage before or after the token reaches me);
// whichever lands second triggers the post. Extracted from wave.js so the invariants live
// in one place:
//   - post exactly once per wave (#posted guard);
//   - only for the CURRENT wave (a stale receipt from a superseded wave never posts);
//   - only when opted in (ctx.canSelfie — roster members, not relays);
//   - the burn proof survives reset() — the wave ends at network speed but a joiner's
//     fee burn can confirm later, and the proof is the ticket for that LATE gallery
//     admission (it's bound to its waveId, so it can only ever admit its own wave).
//     It's dropped only when a genuinely new wave begins (clearBurnProof, from enterLobby).

/**
 * My hop receipt — the gallery write-gate credential recorded when the token reaches me.
 * @typedef {Object} SelfieReceipt
 * @property {string} waveId - The wave this receipt belongs to.
 * @property {number} hopCount - My hop position.
 * @property {string} receiptSig - My hop receipt signature (hex).
 * @property {string} chainHash - Accumulator chain hash at my hop (hex).
 * @property {number} receiptTs - My receipt timestamp (ms).
 */

/**
 * The callbacks the pipeline is wired with (all supplied by wave.js).
 * @typedef {Object} SelfiePipelineCtx
 * @property {function(): boolean} canSelfie - Am I opted into the current wave (roster member)?
 * @property {function(): (string|null)} currentWaveId - The engaged wave's id, or null when idle.
 * @property {function(Object): void} post - Post the combined entry (receipt + image + caption)
 *   to the gallery (async admission + append happen inside; fire-and-forget here).
 */

/**
 * Pairs the staged lobby selfie with my hop receipt and posts exactly once per wave.
 */
class SelfiePipeline {
  #staged = null; // { image, caption } captured in the lobby, awaiting my hop
  #receipt = null; // my hop's receipt once the token reaches me, awaiting the selfie
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
   * the gallery when the token reaches me. Staging may arrive before or after my hop —
   * whichever half lands second fires the post.
   * @param {{image?: string, caption?: string}} [selfie] The captured frame + optional caption.
   * @returns {void}
   */
  stage({ image, caption } = {}) {
    this.#staged = { image: image || '', caption: caption || '' };
    this.#tryPost();
  }

  /**
   * Record my hop's receipt when the token reaches me — the write-gate credential for my
   * staged selfie. Ignored unless I'm an opted-in roster member (relays never selfie).
   * @param {SelfieReceipt} receipt - My hop receipt.
   * @returns {void}
   */
  recordReceipt(receipt) {
    if (!this.#canSelfie()) {
      return;
    }
    this.#receipt = receipt;
    this.#tryPost();
  }

  /**
   * Post once BOTH the receipt (token reached me) and the staged image (captured in the
   * lobby) are available, exactly once per wave, and only for the current wave.
   * @returns {void}
   */
  #tryPost() {
    if (this.#posted || !this.#receipt || !this.#staged) {
      return;
    }
    if (this.#receipt.waveId !== this.#currentWaveId()) {
      return;
    }
    this.#posted = true;
    this.#post({ ...this.#receipt, image: this.#staged.image, caption: this.#staged.caption });
  }

  /**
   * Clear this wave's staged selfie / receipt / posted guard — but NOT the burn proof,
   * which is the ticket for a late gallery admission (see the module header); it's dropped
   * only by clearBurnProof() when a genuinely new wave's lobby begins.
   * @returns {void}
   */
  reset() {
    this.#staged = null;
    this.#receipt = null;
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
   * @param {Object} proof - The signed burn attestation (token.js signBurn over its fields).
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
