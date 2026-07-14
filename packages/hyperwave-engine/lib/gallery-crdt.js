// The per-wave gallery, rebuilt as a conflict-free replicated data type (TODO
// "Gallery-as-CRDT"; validated by gallery.replication.bench.test.js). Replaces the
// single-indexer Autobase GallerySession — which was the O(N) fan-in/out bottleneck and
// a live SPOF (the sole indexer produced a total order the gallery never used, since
// buildGallery re-derives order from entry fields).
//
// The model: each participant owns ONE Hypercore in the per-wave namespace
// (wave-gallery:<waveId>) and appends its single selfie op at block 0. Writer keys ride
// the flooded wave-join, so every peer learns every participant's core key; a peer opens
// (get by key) + download()s block 0 of each and merges the bag with mergeGallery. No
// indexer, no admission, no consensus, no shared "gallery key" — each entry is
// self-authenticating (its join attestation binds peerId → writerKey), so a relay can't
// forge or substitute one. Convergence is epidemic (have I replicated core X), and every
// peer that has the same set of cores computes a byte-identical gallery.
//
// Spam is bounded by construction: exactly block 0 of each core is downloaded/read (one
// entry per peer — extra blocks a malicious peer appends are never fetched), plus the
// per-entry byte caps in mergeGallery.
//
// Pure gallery logic — no swarm. wave.js supplies the store + live accessors
// (walletAddress/burnProof/joinProof) and floods the writer keys; addWriter is driven by
// every wave-join seen. Unit-tested in gallery-crdt.test.js.
const b4a = require('b4a');
const { mergeGallery } = require('./gallery');

/**
 * Shorten a hex id for logs.
 * @param {string} hex - Full hex id.
 * @returns {string} The first 8 chars.
 */
function shortId(hex) {
  return hex.slice(0, 8);
}

/**
 * The context wave.js hands the gallery (store + host callbacks + live accessors).
 * @typedef {Object} CrdtGalleryCtx
 * @property {Object} store - The Corestore all wave cores namespace from.
 * @property {{id: string, country: (string|null)}} me - My identity (country read at post time).
 * @property {function(Object[]): void} onGallery - Push the ordered gallery view to the host.
 * @property {function(): (string|null)} walletAddress - My TRX address, for the tip field.
 * @property {function(): (Object|null)} burnProof - My signed fee-burn attestation.
 * @property {function(): (string|null)} joinProof - My signed join attestation for the
 *   current wave (attest.js signJoin over waveId|peerId|writerKey) — every gallery entry
 *   carries it (mergeGallery's write-gate).
 * @property {function(...*): void} log - Diagnostic logger.
 */

/**
 * One wave's held cores: my writable core + the foreign cores I've opened by key.
 * @typedef {Object} WaveCores
 * @property {Object} own - My writable Hypercore for this wave.
 * @property {Map<string, Object>} foreign - peerId → read-only Hypercore (opened by key).
 * @property {boolean} posted - Whether I've appended my one selfie op yet.
 */

/**
 * The per-wave CRDT gallery: my core + the participants' cores, merged locally.
 */
class CrdtGallery {
  #store;
  #me;
  #onGallery;
  #walletAddress;
  #burnProof;
  #joinProof;
  #log;
  #waveId = null; // the CURRENT wave
  #waves = new Map(); // waveId -> WaveCores

  /**
   * @param {CrdtGalleryCtx} ctx - Store + host callbacks + live accessors.
   */
  constructor({
    store,
    me,
    onGallery,
    walletAddress,
    burnProof,
    joinProof,
    log
  }) {
    this.#store = store;
    this.#me = me;
    this.#onGallery = onGallery;
    this.#walletAddress = walletAddress;
    this.#burnProof = burnProof;
    this.#joinProof = joinProof;
    this.#log = log;
  }

  /**
   * The wave the current gallery belongs to, or null when none is open.
   * @returns {(string|null)} The current wave id.
   */
  get waveId() {
    return this.#waveId;
  }

  /**
   * My writer core key for the current wave (hex) — the credential a wave-join carries
   * (a join attestation signs it), or null before the core is ready / no wave open.
   * @returns {(string|null)} My writer core key (hex).
   */
  get writerKey() {
    const wave = this.#waves.get(this.#waveId);
    if (!wave || !wave.own.key) {
      return null;
    }
    return b4a.toString(wave.own.key, 'hex');
  }

  /**
   * Open (create) MY writable core for `waveId` and make it current, closing the previous
   * wave's cores (the gallery is ephemeral — nothing to keep once a new wave supersedes
   * it; a departing peer's selfie is already replicated into everyone's view). Awaits my
   * core's readiness so writerKey is available.
   * @param {string} waveId - The wave whose gallery to open.
   * @returns {Promise<string>} My writer core key (hex) for this wave.
   */
  open(waveId) {
    // Set the current wave + its record SYNCHRONOUSLY, so addWriter/emitView work
    // immediately; only my core's readiness (for the writer key) is awaited.
    if (this.#waveId !== waveId && this.#waveId !== null) {
      this.#closeWave(this.#waveId).catch(() => {}); // background-close the previous wave
    }
    this.#waveId = waveId;
    let wave = this.#waves.get(waveId);
    if (!wave) {
      const own = this.#store.get({
        name: 'wave-gallery:' + waveId,
        valueEncoding: 'json'
      });
      wave = { own, foreign: new Map(), posted: false };
      this.#waves.set(waveId, wave);
      own.on('append', () => {
        if (this.#waveId === waveId) {
          this.#emitView();
        }
      });
    }
    return wave.own.ready().then(() => b4a.toString(wave.own.key, 'hex'));
  }

  /**
   * Learn a participant's gallery core (from its flooded wave-join): open it by key,
   * download its one entry (block 0), and track it under `peerId`. Idempotent. Every
   * peer calls this for every wave-join it sees — this replaces the old admission.
   * @param {string} waveId - The wave the participant joined.
   * @param {string} peerId - The participant's ring id.
   * @param {string} writerKey - The participant's gallery core key (hex).
   * @returns {void}
   */
  addWriter(waveId, peerId, writerKey) {
    const wave = this.#waves.get(waveId);
    if (!wave || !peerId || !writerKey || wave.foreign.has(peerId)) {
      return;
    }
    if (peerId === this.#me.id) {
      return; // my own core is `own`, not a foreign one
    }
    let core;
    try {
      core = this.#store.get({
        key: b4a.from(writerKey, 'hex'),
        valueEncoding: 'json'
      });
    } catch {
      return; // malformed key
    }
    wave.foreign.set(peerId, core);
    core.ready().then(() => {
      // one entry per peer by construction: only block 0 is ever fetched, so a
      // malicious peer's extra appends are never downloaded
      core.download({ start: 0, end: 1 });
      core.on('append', () => {
        if (this.#waveId === waveId) {
          this.#emitView();
        }
      });
      if (this.#waveId === waveId) {
        this.#emitView();
      }
    });
    this.#log('gallery: learned writer', shortId(peerId));
  }

  /**
   * Post my selfie: append my one op (block 0) to my own core. No admission, no
   * writable-wait — I own my core. Guarded to post exactly once per wave.
   * @param {Object} entry - The staged selfie.
   * @param {string} entry.waveId - The wave this belongs to.
   * @param {number} entry.hopCount - My rank in the sweep (gallery ordering key).
   * @param {string} [entry.caption] - Optional caption.
   * @param {string} [entry.image] - Inline JPEG data URL.
   * @returns {Promise<void>}
   */
  async postSelfie({ waveId, hopCount, caption, image }) {
    const wave = this.#waves.get(waveId);
    if (!wave) {
      return;
    }
    if (wave.posted) {
      return;
    }
    // capture the proofs NOW, before the await: a fast wave can end mid-append and a new
    // wave would blank them, stripping our own tip address / write credential
    const burnProof = this.#burnProof();
    const joinSig = this.#joinProof();
    await wave.own.ready();
    wave.posted = true;
    await wave.own.append({
      type: 'wave-selfie',
      waveId,
      peerId: this.#me.id,
      hopCount,
      writerKey: b4a.toString(wave.own.key, 'hex'),
      joinSig,
      country: this.#me.country || '',
      caption: caption || '',
      image: image || '',
      address: this.#walletAddress() || '',
      burn: burnProof || undefined,
      timestamp: Date.now()
    });
    this.#log('posted selfie hop', hopCount);
    this.#emitView();
  }

  /**
   * Pull replicated entries for every held wave, then repaint the
   * current one. Called periodically by wave.js so a gallery keeps converging even when
   * no `append` event fires locally.
   * @returns {void}
   */
  tick() {
    for (const wave of this.#waves.values()) {
      for (const core of [wave.own, ...wave.foreign.values()]) {
        core.update().catch(() => {});
      }
    }
    this.#emitView();
  }

  /**
   * Read block 0 of every current-wave core that has it, merge, and push to the host.
   * @returns {Promise<void>}
   */
  async #emitView() {
    const wave = this.#waves.get(this.#waveId);
    if (!wave) {
      return;
    }
    const raw = [];
    for (const core of [wave.own, ...wave.foreign.values()]) {
      if (core.length >= 1 && core.has(0)) {
        try {
          raw.push(await core.get(0));
        } catch {}
      }
    }
    if (this.#waves.get(this.#waveId) !== wave) {
      return; // moved on while reading
    }
    this.#onGallery(mergeGallery(raw));
  }

  /**
   * Close every core of a wave and forget it.
   * @param {(string|null)} waveId - The wave to close.
   * @returns {Promise<void>}
   */
  async #closeWave(waveId) {
    const wave = this.#waves.get(waveId);
    if (!wave) {
      return;
    }
    this.#waves.delete(waveId);
    for (const core of [wave.own, ...wave.foreign.values()]) {
      await core.close().catch(() => {});
    }
  }

  /**
   * Close every core of every held wave.
   * @returns {Promise<void>}
   */
  async close() {
    for (const wave of this.#waves.values()) {
      for (const core of [wave.own, ...wave.foreign.values()]) {
        await core.close().catch(() => {});
      }
    }
    this.#waves.clear();
  }
}

module.exports = { CrdtGallery };
