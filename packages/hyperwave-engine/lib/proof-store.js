// Persistent per-mint store of Cashu proofs — the CashuWallet's balance. Unlike
// a Tron wallet (balance lives on-chain), ecash proofs are BEARER tokens the
// wallet must hold locally; losing them loses funds. Proofs are kept per mint
// (`Map<mintUrl, Proof[]>`) so a peer can carry ecash from several mints (its
// own home mint + tips received from foreign mints). Persisted as JSON to a file
// that MUST live OUTSIDE the per-run `hyperwave` corestore (wave.js wipes that on
// startup); the store survives restarts. Saves are atomic (write-tmp + rename)
// so a crash mid-write can't corrupt the file. `fs` is injected (bare-fs) so the
// roundtrip is unit-testable. (Encryption-at-rest is a desktop concern — the
// desktop can point `file` at a safeStorage-wrapped path; see the plan.)

// Cap the local ledger so the file can't grow without bound; the newest entries
// are kept (a wallet view shows a recent window, full history isn't the store's job).
const MAX_HISTORY = 200;

/**
 * A persistent per-mint proof store backing a CashuWallet.
 */
class ProofStore {
  #file;
  #fs;
  #log;
  #byMint;
  #history;

  /**
   * @param {Object} opts
   * @param {string} opts.file - Absolute path of the JSON store file.
   * @param {Object} opts.fs - A bare-fs-compatible module (readFileSync/writeFileSync/renameSync).
   * @param {(...args: any[]) => void} [opts.log] - Logger.
   */
  constructor({ file, fs, log = () => {} }) {
    this.#file = file;
    this.#fs = fs;
    this.#log = log;
    this.#byMint = new Map();
    this.#history = [];
    this.#load();
  }

  #load() {
    let raw = null;
    try {
      raw = this.#fs.readFileSync(this.#file, 'utf8');
    } catch {
      return; // no store yet — start empty
    }
    try {
      const parsed = JSON.parse(raw);
      for (const [mintUrl, proofs] of Object.entries(parsed.proofs || {})) {
        this.#byMint.set(mintUrl, Array.isArray(proofs) ? proofs : []);
      }
      this.#history = Array.isArray(parsed.history) ? parsed.history : [];
    } catch (err) {
      // Corrupt store: don't crash the wallet, but don't silently drop funds —
      // surface it so a host can react. Start empty rather than throw.
      this.#log('proof store parse failed (starting empty):', err.message);
    }
  }

  #save() {
    const proofs = {};
    for (const [mintUrl, list] of this.#byMint) {
      proofs[mintUrl] = list;
    }
    const body = JSON.stringify({ proofs, history: this.#history });
    const tmp = this.#file + '.tmp';
    this.#fs.writeFileSync(tmp, body);
    this.#fs.renameSync(tmp, this.#file); // atomic replace
  }

  /**
   * The proofs held at `mintUrl` (a copy).
   * @param {string} mintUrl - The mint URL.
   * @returns {Object[]} The proofs (empty array if none).
   */
  get(mintUrl) {
    return (this.#byMint.get(mintUrl) || []).slice();
  }

  /**
   * Replace the proofs held at `mintUrl` (e.g. with the change from a swap) + save.
   * @param {string} mintUrl - The mint URL.
   * @param {Object[]} proofs - The new proof set for that mint.
   * @returns {void}
   */
  set(mintUrl, proofs) {
    if (proofs && proofs.length) {
      this.#byMint.set(mintUrl, proofs.slice());
    } else {
      this.#byMint.delete(mintUrl);
    }
    this.#save();
  }

  /**
   * Append proofs to `mintUrl` (e.g. newly minted / received) + save.
   * @param {string} mintUrl - The mint URL.
   * @param {Object[]} proofs - Proofs to add.
   * @returns {void}
   */
  add(mintUrl, proofs) {
    if (!proofs || !proofs.length) {
      return;
    }
    const existing = this.#byMint.get(mintUrl) || [];
    this.#byMint.set(mintUrl, existing.concat(proofs));
    this.#save();
  }

  /**
   * The mint URLs this store holds proofs for.
   * @returns {string[]} The mint URLs.
   */
  mints() {
    return [...this.#byMint.keys()];
  }

  /**
   * The total amount held across all mints (sum of proof amounts).
   * @returns {number} The total.
   */
  total() {
    let sum = 0;
    for (const list of this.#byMint.values()) {
      for (const proof of list) {
        sum += Number(proof.amount) || 0;
      }
    }
    return sum;
  }

  /**
   * Record a ledger entry (mint/send/burn/receive) + save, newest-capped.
   * @param {Object} entry - The ledger entry.
   * @returns {void}
   */
  addHistory(entry) {
    this.#history.unshift(entry);
    if (this.#history.length > MAX_HISTORY) {
      this.#history.length = MAX_HISTORY;
    }
    this.#save();
  }

  /**
   * Recent ledger entries, newest first.
   * @param {number} [limit] - Max to return.
   * @returns {Object[]} The entries.
   */
  history(limit = MAX_HISTORY) {
    return this.#history.slice(0, limit);
  }
}

module.exports = { ProofStore, MAX_HISTORY };
