// The per-wave gallery session: which Autobase is CURRENT, which retired galleries I
// retain (waves I initiated — I'm their archivist), and the writer-admission flow.
// Extracted from wave.js so the gallery lifecycle rules live in one place:
//   - galleries are PER-WAVE (namespace keyed by the random waveId), so each wave — and
//     each fresh run — starts empty instead of accumulating old selfies;
//   - moving on closes the previous wave's gallery UNLESS I initiated it (retain());
//     a retained gallery stays open + syncing so it survives for latecomers;
//   - admission is OPTIMISTIC (§8.2): the admitter checks the hop-receipt signature and
//     the burn attestation SIGNATURE only — no on-chain call on the write path; the burn
//     is verified where it pays off (tippers/auditors via the entry's burnTx);
//   - the requester FLOODS add-writer with a fresh flood id every retry so it reliably
//     reaches a current writer even across a sparse/churned mesh.
// Pure gallery/admission logic — swarm transport arrives via ctx (floodGossip), payments
// via accessors (enforcePaid/walletAddress/burnProof read live wave.js state).
const Autobase = require('autobase');
const b4a = require('b4a');
const { galleryConfig, readGallery } = require('./gallery');
const { verifyReceipt, burnAuthorizes } = require('./token');

// Gallery-writer admission (§8.2). The requester re-floods its add-writer every
// ADMIT_RETRY_MS (a single one-hop broadcast can race connection setup) until admitted or
// ADMIT_TIMEOUT_MS — generous because in a fast few-peer wave the race finishes first (the
// admitter's check itself is a cheap local signature check — burnAuthorizes, no on-chain
// call); the gallery persists after the wave, so a late admission still lands. BURN_WAIT_MS:
// how long to wait for my own join burn to be recorded before requesting admission.
const ADMIT_TIMEOUT_MS = 25000;
const ADMIT_RETRY_MS = 3000;
const BURN_WAIT_MS = 10000;

/**
 * Shorten a hex id for logs.
 * @param {string} hex - Full hex id (peer id, wave id, autobase key…).
 * @returns {string} The first 8 chars.
 */
function shortId(hex) {
  return hex.slice(0, 8);
}

/**
 * Poll `pred` every 200ms (self-rescheduling timeout) until it's true or `timeoutMs` elapses.
 * @param {() => boolean} pred - Predicate polled each tick.
 * @param {number} timeoutMs - Give-up window in ms.
 * @returns {Promise<boolean>} True if `pred` became true, false on timeout.
 */
function waitFor(pred, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    function poll() {
      if (pred()) {
        resolve(true);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(poll, 200);
    }
    poll();
  });
}

/**
 * The context wave.js hands the session (transport + host callbacks + live accessors).
 * @typedef {Object} GallerySessionCtx
 * @property {Object} store - The Corestore all galleries namespace from.
 * @property {{id: string, country: (string|null)}} me - My identity (country read at post time).
 * @property {function(Object): void} floodGossip - Originate a flooded control message (add-writer).
 * @property {function(Object[]): void} onGallery - Push the ordered gallery view to the host.
 * @property {function(Object): void} onEvent - Push a lifecycle/error event to the host.
 * @property {function(): boolean} enforcePaid - Is the paid-wave gate on (wallet present)?
 * @property {function(): (string|null)} walletAddress - My TRX address, for the tip field.
 * @property {function(): (Object|null)} burnProof - My signed fee-burn attestation (admission ticket).
 * @property {function(...*): void} log - Diagnostic logger.
 */

/**
 * The per-wave gallery session: current Autobase, retained (initiated) galleries, and
 * the optimistic writer-admission flow.
 */
class GallerySession {
  #store;
  #me;
  #floodGossip;
  #onGallery;
  #onEvent;
  #enforcePaid;
  #walletAddress;
  #burnProof;
  #log;
  #base = null; // the CURRENT wave's gallery Autobase (created by originator, opened by others)
  #key = null; // hex bootstrap key of #base, shared via gossip + token
  #waveId = null; // which wave #base belongs to (galleries are per-wave)
  #galleries = new Map(); // waveId -> Autobase (every gallery I currently hold open)
  #retained = new Set(); // waveIds I initiated — I keep their galleries open (archivist)
  #admittedKeys = new Set(); // (admitter) writer core keys I've already admitted this wave
  #admissionPromise = null; // in-flight add-writer request (dedup concurrent callers)

  /**
   * @param {GallerySessionCtx} ctx - Transport + host callbacks + live accessors.
   */
  constructor({
    store,
    me,
    floodGossip,
    onGallery,
    onEvent,
    enforcePaid,
    walletAddress,
    burnProof,
    log
  }) {
    this.#store = store;
    this.#me = me;
    this.#floodGossip = floodGossip;
    this.#onGallery = onGallery;
    this.#onEvent = onEvent;
    this.#enforcePaid = enforcePaid;
    this.#walletAddress = walletAddress;
    this.#burnProof = burnProof;
    this.#log = log;
  }

  /**
   * The current gallery's hex bootstrap key (advertised on wave-start / token / wave-sync),
   * or null before the Autobase is ready / when no gallery is open.
   * @returns {(string|null)} The current gallery key (hex).
   */
  get key() {
    return this.#key;
  }

  /**
   * The wave the current gallery belongs to, or null when no gallery is open.
   * @returns {(string|null)} The current gallery's waveId.
   */
  get waveId() {
    return this.#waveId;
  }

  /**
   * Mark a wave as mine (I initiated it): I keep its gallery open when moving on — the
   * per-wave archivist, so the gallery survives for latecomers / late admissions.
   * @param {string} waveId - The wave I initiated.
   * @returns {void}
   */
  retain(waveId) {
    this.#retained.add(waveId);
  }

  /**
   * Open (or, with bootstrapKey=null, create) the gallery Autobase for `waveId` and make
   * it current. All peers share the originator's base; writes come from many admitted
   * writers, merged into one ordered view. Replication rides store.replicate(conn) —
   * wired by wave.js on every connection.
   * @param {string} waveId - The wave whose gallery to open/create.
   * @param {Buffer|null} bootstrapKey - The originator's autobase key, or null to create fresh.
   * @returns {Object} The Autobase instance for this wave.
   */
  open(waveId, bootstrapKey) {
    if (this.#waveId === waveId && this.#base) {
      return this.#base;
    }
    const kept = this.#galleries.get(waveId);
    if (kept) {
      // I already hold this gallery (a wave I initiated) — make it current, don't reopen
      this.#base = kept;
      this.#waveId = waveId;
      this.#key = b4a.toString(kept.key, 'hex');
      return this.#base;
    }
    // Close the previous wave's gallery when moving on — UNLESS I initiated it, in which
    // case I keep it open to archive it (so it survives for latecomers).
    if (this.#base && !this.#retained.has(this.#waveId)) {
      this.#base.close().catch(() => {});
      if (this.#waveId) {
        this.#galleries.delete(this.#waveId);
      }
    }
    this.#waveId = waveId;
    this.#key = null;
    const autobase = new Autobase(
      this.#store.namespace('wave-gallery:' + waveId),
      bootstrapKey,
      galleryConfig()
    );
    this.#base = autobase;
    this.#galleries.set(waveId, autobase);
    autobase.on('update', () => {
      if (this.#base === autobase) {
        this.#emitView();
      }
    });
    autobase.ready().then(() => {
      if (this.#galleries.get(waveId) !== autobase) {
        return; // superseded (peer moved on and closed it)
      }
      const key = b4a.toString(autobase.key, 'hex');
      if (this.#base === autobase) {
        this.#key = key;
      }
      this.#log(
        'gallery ready',
        shortId(waveId),
        'key',
        shortId(key),
        'writable',
        autobase.writable,
        this.#retained.has(waveId) ? '(mine)' : ''
      );
      if (this.#base === autobase) {
        this.#emitView();
      }
    });
    return autobase;
  }

  /**
   * Read the current gallery's ordered view and push it to the host (onGallery). Force the base to
   * catch up first: `readGallery` reads `base.view` as-is, and the `update` event that triggers this
   * can fire a beat before the last node linearizes — without the await the originator (or any peer)
   * can settle one selfie short of the log with nothing to re-trigger the read. `update()` is a no-op
   * when already current, so this is cheap on a settled gallery.
   * @returns {Promise<void>}
   */
  async #emitView() {
    if (!this.#base) {
      return;
    }
    const base = this.#base;
    await base.update().catch(() => {});
    if (this.#base !== base) {
      return; // moved on to another wave's gallery while updating
    }
    this.#onGallery(await readGallery(base));
  }

  // (Admitter side) Grant gallery write access — OPTIMISTIC admission. Only a current writer
  // (the originator, or an already-admitted writer) admits, and only if the requester presents:
  //   1. a valid hop receipt for the current wave (authenticity: the receipt signature binds
  //      the request to peerId, so it stays sound even when flooded through relays), and
  //   2. a fee-burn attestation SIGNED for that peerId + wave (burnAuthorizes) — carrying the
  //      txHash + tip address, but NOT verified on-chain here.
  // We deliberately do *not* verify the burn on-chain at admission: that's O(N) REST calls
  // concentrated on the admitter and doesn't scale. Instead the burn is verified only when it
  // pays off — by tippers/auditors via the entry's `burnTx`. Spam is bounded locally: one entry
  // per peer + a byte-size cap on the image (gallery.js apply). So a fake-burn entry is cheap to
  // make but is worthless to tip and is publicly detectable. Fully local + synchronous.
  /**
   * @param {Object} msg - An `add-writer` request (carries the requester's writer key, hop
   *   receipt, and — when enforcing — its signed burn attestation).
   * @returns {void}
   */
  admitWriter(msg) {
    if (!this.#base || !this.#base.writable || !msg.key || msg.waveId !== this.#waveId) {
      return;
    }
    // Only the wave's ORIGINATOR admits (it retains this gallery). Optimistic *multi*-admitter
    // admission let any writer admit — but a joiner admitted by a non-originator became writable and
    // stopped re-flooding, so the originator never received its request and only learned it if that
    // other writer's add-writer op replicated+linearized back (which lags/stalls, leaving the
    // originator's roster incomplete — its view settles short). Funnelling every admission through
    // the originator's own core keeps its writer set complete → its view (and, via replication of
    // that core, everyone's) reaches the full roster. The request still FLOODS, so it relays across a
    // sparse/churned mesh to the originator; non-originators just pass it on.
    if (!this.#retained.has(msg.waveId)) {
      return;
    }
    if (this.#admittedKeys.has(msg.key)) {
      return;
    }
    if (
      !verifyReceipt(
        {
          peerId: msg.peerId,
          waveId: msg.waveId,
          hopCount: msg.hopCount,
          prevChainHash: msg.chainHash,
          timestamp: msg.receiptTs
        },
        msg.receiptSig
      )
    ) {
      return;
    }
    if (this.#enforcePaid() && !burnAuthorizes(msg.burn, msg.peerId, msg.waveId)) {
      return; // needs a signed burn attestation
    }
    this.#admittedKeys.add(msg.key);
    this.#base.append({ type: 'add-writer', key: msg.key });
    this.#log('admitted gallery writer', shortId(msg.peerId));
  }

  // Become an admitted gallery writer: flood an add-writer request presenting (a) my hop
  // receipt for this wave and (b) my fee-burn attestation — admission is OPTIMISTIC: the
  // admitter checks only the attestation signature (burnAuthorizes), no on-chain call; the
  // burn is verified later where it pays off (tippers/auditors via burnTx). Then
  // wait until writable. `#admissionPromise` dedups concurrent callers into one in-flight
  // request. (The originator is already a writer and never comes here — it paid its
  // kick-off burn.)
  /**
   * @param {{waveId: string, hopCount: number, chainHash: string, receiptTs: number, receiptSig: string}} receipt
   *   My hop receipt, presented as the admission credential.
   * @returns {Promise<boolean>} True once this peer's gallery core is writable, false on timeout.
   */
  #ensureWriter(receipt) {
    if (!this.#base) {
      return Promise.resolve(false);
    }
    if (this.#base.writable) {
      return Promise.resolve(true);
    }
    if (this.#admissionPromise) {
      return this.#admissionPromise;
    }
    this.#admissionPromise = this.#base
      .ready()
      // when enforcing, my burn attestation is my admission ticket; wait for the burn tx to be
      // recorded (join burns are fire-and-forget from the lobby) before requesting admission
      .then(() =>
        this.#enforcePaid() && !this.#burnProof()
          ? waitFor(() => !!this.#burnProof(), BURN_WAIT_MS)
          : true
      )
      .then(() => this.#requestAdmission(receipt));
    this.#admissionPromise.finally(() => {
      this.#admissionPromise = null;
    });
    return this.#admissionPromise;
  }

  // Flood add-writer and wait until admitted, re-flooding every ADMIT_RETRY_MS (each retry gets
  // a fresh flood id via floodGossip, so it re-blankets the mesh rather than being deduped away
  // — the reach a churny post-heal topology needs). The burn (my admission ticket) is pinned
  // into the request now, so a later reset can't blank it mid-wait. Resolves true once
  // writable, false on timeout.
  /**
   * @param {{waveId: string, hopCount: number, chainHash: string, receiptTs: number, receiptSig: string}} receipt
   *   My hop receipt, carried in the add-writer request.
   * @returns {Promise<boolean>} True once writable, false on ADMIT_TIMEOUT_MS timeout.
   */
  #requestAdmission(receipt) {
    return new Promise((resolve) => {
      if (this.#base.writable) {
        resolve(true);
        return;
      }
      const req = {
        kind: 'add-writer',
        key: b4a.toString(this.#base.local.key, 'hex'),
        peerId: this.#me.id,
        waveId: receipt.waveId,
        hopCount: receipt.hopCount,
        chainHash: receipt.chainHash,
        receiptTs: receipt.receiptTs,
        receiptSig: receipt.receiptSig,
        burn: this.#burnProof() || undefined
      };
      const started = Date.now();
      const tick = () => {
        if (this.#base.writable) {
          resolve(true);
          return;
        }
        if (Date.now() - started > ADMIT_TIMEOUT_MS) {
          resolve(false);
          return;
        }
        this.#floodGossip(req); // re-stamps req.mid each tick → floods anew across the mesh
        setTimeout(tick, ADMIT_RETRY_MS);
      };
      tick();
    });
  }

  /**
   * Post my selfie to the gallery (admission first, then append).
   * @param {Object} entry - The staged selfie + my hop receipt.
   * @param {string} entry.waveId - Wave this selfie belongs to.
   * @param {number} entry.hopCount - My hop position.
   * @param {string} entry.receiptSig - My hop receipt signature (the write-gate credential).
   * @param {string} entry.chainHash - Accumulator chain hash at my hop.
   * @param {number} entry.receiptTs - My receipt timestamp.
   * @param {string} [entry.caption] - Optional caption.
   * @param {string} [entry.image] - Inline JPEG data URL.
   * @returns {Promise<void>}
   */
  async postSelfie({ waveId, hopCount, receiptSig, chainHash, receiptTs, caption, image }) {
    if (!this.#base) {
      this.#onEvent({ event: 'gallery-error', reason: 'no-gallery-yet' });
      return;
    }
    // Capture the proof NOW, before the admission await: in a fast (few-peer) wave the race
    // can complete during #ensureWriter, and a new wave's enterLobby→clearBurnProof could drop
    // it before the append — losing our own tip address. (The staged image/receipt are already
    // captured as args.)
    const burnProof = this.#burnProof();
    if (!(await this.#ensureWriter({ waveId, hopCount, chainHash, receiptTs, receiptSig }))) {
      // distinguish the two failure modes so the UI can tell the user what actually went wrong:
      // no burn ticket at all (fee never paid/confirmed) vs. a valid ticket that timed out being
      // admitted (network/mesh). enforcePaid off (headless) → always the timeout case.
      const reason = this.#enforcePaid() && !this.#burnProof() ? 'fee-unpaid' : 'admit-timeout';
      this.#onEvent({ event: 'gallery-error', reason });
      return;
    }
    await this.#base.append({
      type: 'wave-selfie',
      waveId,
      peerId: this.#me.id,
      hopCount,
      receiptSig,
      chainHash,
      receiptTs,
      country: this.#me.country || '',
      caption: caption || '',
      image: image || '',
      address: this.#walletAddress() || '', // my TRX wallet, so viewers can tip this selfie (§WDK)
      // my burn attestation — apply() keeps the tip `address` only if it's the wallet this
      // burn came from, so a tip always reaches the wallet that paid in (§ tip-address gate).
      // It's verified then dropped from the stored entry (kept lean); `tronAddress === address`.
      burn: burnProof || undefined,
      timestamp: Date.now()
    });
    this.#log('posted selfie hop', hopCount);
    this.#emitView();
  }

  /**
   * Clear the per-wave admission state (in-flight request + admitted-writer dedup) when a
   * wave ends or a new one begins.
   * @returns {void}
   */
  resetAdmission() {
    this.#admissionPromise = null;
    this.#admittedKeys.clear();
  }

  /**
   * Periodic maintenance: pull replicated writes for every gallery I hold. For most peers
   * that's just the current wave's; for an initiator it also includes the galleries it
   * retains (so each keeps syncing and stays a live source for latecomers). Then repaint.
   * @returns {void}
   */
  tick() {
    for (const gallery of this.#galleries.values()) {
      gallery.update().catch(() => {});
    }
    this.#emitView();
  }

  /**
   * Close every gallery I hold (current + retained).
   * @returns {Promise<void>}
   */
  async close() {
    for (const gallery of this.#galleries.values()) {
      await gallery.close().catch(() => {});
    }
  }
}

module.exports = { GallerySession };
