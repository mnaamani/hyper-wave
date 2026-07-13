// The per-wave gallery session: which Autobase is CURRENT, which retired galleries I
// retain (waves I initiated — I'm their archivist), and the writer-admission flow.
// Extracted from wave.js so the gallery lifecycle rules live in one place:
//   - galleries are PER-WAVE (namespace keyed by the random waveId), so each wave — and
//     each fresh run — starts empty instead of accumulating old selfies;
//   - moving on closes the previous wave's gallery UNLESS I initiated it (retain());
//     a retained gallery stays open + syncing so it survives for latecomers;
//   - admission is BATCHED at lobby close (§8.2): each wave-join carries the joiner's
//     writer key + signed join attestation (+ burn attestation when paid); the wave's
//     ORIGINATOR validates the collected credentials and appends every add-writer op in
//     one batch (admitRoster) before wave-start — signature checks only, no on-chain
//     call on the write path; the burn is verified where it pays off (tippers/auditors
//     via the entry's burnTx). A joiner becomes writable when the originator's core
//     (which everyone replicates anyway — it's the Autobase bootstrap) syncs back.
// Pure gallery/admission logic — payments arrive via accessors
// (enforcePaid/walletAddress/burnProof/joinProof read live wave.js state).
const Autobase = require('autobase');
const b4a = require('b4a');
const { galleryConfig, readGallery } = require('./gallery');
const { verifyJoin, burnAuthorizes } = require('./attest');

// How long postSelfie waits for MY batch admission to replicate back (originator core →
// me) before giving up. One small-core sync, not an RPC round-trip — but it can lag on a
// loaded mesh; the gallery persists after the wave, so a slow admission still converges.
const ADMIT_TIMEOUT_MS = 25000;
// How long credentials() waits for the wave's gallery to be opened by the announce/sync
// handler — covers a host that calls join() synchronously on the announce event.
const CREDENTIALS_WAIT_MS = 5000;

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
 * @property {function(Object[]): void} onGallery - Push the ordered gallery view to the host.
 * @property {function(Object): void} onEvent - Push a lifecycle/error event to the host.
 * @property {function(): boolean} enforcePaid - Is the paid-wave gate on (wallet present)?
 * @property {function(): (string|null)} walletAddress - My TRX address, for the tip field.
 * @property {function(): (Object|null)} burnProof - My signed fee-burn attestation.
 * @property {function(): (string|null)} joinProof - My signed join attestation for the
 *   current wave (attest.js signJoin over waveId|peerId|writerKey) — every gallery entry
 *   carries it (apply()'s write-gate).
 * @property {number} [admitTimeoutMs] - How long postSelfie waits for my batch admission
 *   to replicate back before giving up (one small-core sync from the originator).
 * @property {function(...*): void} log - Diagnostic logger.
 */

/**
 * The per-wave gallery session: current Autobase, retained (initiated) galleries, and
 * the optimistic writer-admission flow.
 */
class GallerySession {
  #store;
  #me;
  #onGallery;
  #onEvent;
  #enforcePaid;
  #walletAddress;
  #burnProof;
  #joinProof;
  #admitTimeoutMs; // how long postSelfie waits for my admission to replicate back
  #log;
  #base = null; // the CURRENT wave's gallery Autobase (created by originator, opened by others)
  #key = null; // hex bootstrap key of #base, shared via gossip + token
  #waveId = null; // which wave #base belongs to (galleries are per-wave)
  #galleries = new Map(); // waveId -> Autobase (every gallery I currently hold open)
  #retained = new Set(); // waveIds I initiated — I keep their galleries open (archivist)
  #admittedKeys = new Set(); // (originator) writer core keys I've already admitted this wave

  /**
   * @param {GallerySessionCtx} ctx - Host callbacks + live accessors.
   */
  constructor({
    store,
    me,
    onGallery,
    onEvent,
    enforcePaid,
    walletAddress,
    burnProof,
    joinProof,
    admitTimeoutMs = ADMIT_TIMEOUT_MS,
    log
  }) {
    this.#store = store;
    this.#me = me;
    this.#onGallery = onGallery;
    this.#onEvent = onEvent;
    this.#enforcePaid = enforcePaid;
    this.#walletAddress = walletAddress;
    this.#burnProof = burnProof;
    this.#joinProof = joinProof;
    this.#admitTimeoutMs = admitTimeoutMs;
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
   * My gallery writer core key for the current wave (hex), or null before the
   * base is ready. This is the key a join attestation signs and admitRoster admits.
   * @returns {(string|null)} My local writer key (hex).
   */
  get writerKey() {
    if (!this.#base || !this.#base.local) {
      return null;
    }
    return b4a.toString(this.#base.local.key, 'hex');
  }

  /**
   * Wait for `waveId`'s gallery to be ready and return my writer key for it —
   * the credential a wave-join carries. A host can call join() on the very
   * announce event that carries the gallery key, BEFORE the handler has opened
   * the gallery — so tolerate that ordering by waiting briefly for the gallery
   * to appear. Null if it never does (or the wave is superseded while waiting).
   * @param {string} waveId - The wave whose gallery writer key to resolve.
   * @param {number} [waitMs] - How long to wait for the gallery (defaults to
   *   CREDENTIALS_WAIT_MS; callers with a lobby deadline pass the time left).
   * @returns {Promise<string|null>} My writer core key (hex), or null.
   */
  async credentials(waveId, waitMs = CREDENTIALS_WAIT_MS) {
    if (!this.#galleries.has(waveId)) {
      await waitFor(() => this.#galleries.has(waveId), waitMs);
    }
    const base = this.#galleries.get(waveId);
    if (!base) {
      return null;
    }
    await base.ready();
    if (this.#galleries.get(waveId) !== base) {
      return null; // superseded while waiting
    }
    return b4a.toString(base.local.key, 'hex');
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

  // (Originator side) Batch admission at lobby close. Each collected wave-join
  // credential is admitted only if:
  //   1. its join attestation verifies (the signature binds peerId to THIS wave and THAT
  //      writer key, so a relayed/flooded join stays sound and nobody can substitute
  //      their own writer key under someone else's peerId), and
  //   2. when enforcing, its fee-burn attestation SIGNATURE verifies (burnAuthorizes) —
  //      NOT verified on-chain here: that would be O(N) REST calls concentrated on the
  //      originator. The burn is verified where it pays off — tippers/auditors via the
  //      entry's burnTx.
  // Spam is bounded locally: one entry per peer + a byte-size cap (gallery.js apply).
  // Only the wave's ORIGINATOR admits (it retains this gallery and is the Autobase
  // bootstrap): funnelling every admission through its own core keeps its writer set
  // complete, and a joiner becomes writable via the same core sync it needs anyway.
  /**
   * @param {Array<{peerId: string, writerKey: string, joinSig: string, burn?: Object}>}
   *   creds The join credentials collected from the lobby's wave-joins.
   * @returns {Promise<number>} How many writers were admitted.
   */
  async admitRoster(creds) {
    if (!this.#base || !this.#base.writable) {
      return 0;
    }
    if (!this.#retained.has(this.#waveId)) {
      return 0;
    }
    const ops = [];
    for (const cred of creds) {
      if (!cred || !cred.writerKey || !cred.peerId) {
        continue;
      }
      if (this.#admittedKeys.has(cred.writerKey)) {
        continue;
      }
      const fields = {
        waveId: this.#waveId,
        peerId: cred.peerId,
        writerKey: cred.writerKey
      };
      if (!verifyJoin(fields, cred.joinSig)) {
        continue;
      }
      if (
        this.#enforcePaid() &&
        !burnAuthorizes(cred.burn, cred.peerId, this.#waveId)
      ) {
        continue; // needs a signed burn attestation
      }
      this.#admittedKeys.add(cred.writerKey);
      ops.push({ type: 'add-writer', key: cred.writerKey });
      this.#log('admitting gallery writer', shortId(cred.peerId));
    }
    if (ops.length > 0) {
      // ONE batched append for the whole roster: Autobase.append accepts an array, so
      // the linearizer processes the batch in a single pass. Appending one-at-a-time
      // was O(roster) awaited linearizer round-trips — measured at 128 peers: ~2.2s
      // EACH (277s total, starving every poster's writable-wait); the batch is one.
      await this.#base.append(ops);
    }
    return ops.length;
  }

  /**
   * Post my selfie to the gallery. Admission already happened in batch at lobby close
   * (admitRoster on the originator); here we only wait for that admission to replicate
   * back (the originator's core sync makes this base writable), then append.
   * @param {Object} entry - The staged selfie.
   * @param {string} entry.waveId - Wave this selfie belongs to.
   * @param {number} entry.hopCount - My hop position (gallery ordering key).
   * @param {string} [entry.caption] - Optional caption.
   * @param {string} [entry.image] - Inline JPEG data URL.
   * @returns {Promise<void>}
   */
  async postSelfie({ waveId, hopCount, caption, image }) {
    const base = this.#galleries.get(waveId);
    if (!base) {
      this.#onEvent({ event: 'gallery-error', reason: 'no-gallery-yet' });
      return;
    }
    // Capture the proofs NOW, before the writable await: in a fast (few-peer) wave the
    // race can complete during the wait, and a new wave's enterLobby→clearBurnProof could
    // drop them before the append — losing our own tip address / write credential.
    const burnProof = this.#burnProof();
    const joinSig = this.#joinProof();
    await base.ready();
    if (!(await waitFor(() => base.writable, this.#admitTimeoutMs))) {
      // distinguish the two failure modes so the UI can tell the user what actually went
      // wrong: no burn ticket at all (fee never paid/confirmed → never admitted) vs. an
      // admission that hasn't replicated back in time (network/mesh). enforcePaid off
      // (headless) → always the timeout case.
      const reason =
        this.#enforcePaid() && !burnProof ? 'fee-unpaid' : 'admit-timeout';
      this.#onEvent({ event: 'gallery-error', reason });
      return;
    }
    await base.append({
      type: 'wave-selfie',
      waveId,
      peerId: this.#me.id,
      hopCount,
      // my join attestation + the writer key it signs — apply()'s write-gate credential
      writerKey: b4a.toString(base.local.key, 'hex'),
      joinSig,
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
   * Clear the per-wave admission state (admitted-writer dedup) when a wave ends or a
   * new one begins.
   * @returns {void}
   */
  resetAdmission() {
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
