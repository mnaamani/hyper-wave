// The wave selfie gallery's pure logic: mergeGallery (the CRDT merge + write-gate —
// gallery-crdt.js holds the cores, this holds the math) and buildGallery (the
// deterministic ordering). The single-indexer Autobase baseline (galleryConfig/
// readGallery) and its A/B replication benchmark were deleted once the CRDT gallery
// was validated — resurrect from git history if a comparison is ever needed again.
const { verifyJoin, burnAuthorizes } = require('./attest');

/**
 * A `wave-selfie` op (the shape a participant appends to its core; read back into the gallery).
 * @typedef {Object} SelfieOp
 * @property {string} type - Op discriminator; a gallery selfie is `'wave-selfie'`.
 * @property {string} waveId - The wave this selfie belongs to.
 * @property {string} peerId - Hex id of the peer that posted the selfie.
 * @property {number} hopCount - The peer's rank in the sweep schedule (gallery ordering key).
 * @property {string} writerKey - The poster's gallery writer core key (hex).
 * @property {string} joinSig - Ed25519 join-attestation signature (hex) binding the op to `peerId`.
 * @property {string} image - Inline selfie image as a JPEG data URL.
 * @property {string} caption - Short caption text.
 * @property {number} timestamp - Wall-clock time (ms) the entry was created.
 * @property {string} [address] - Tip destination Tron address (kept only if backed by a burn).
 * @property {Object} [burn] - Burn attestation proof (verified then dropped; `burnTx` kept).
 */

// Per-entry write budget (deterministic, enforced identically on every peer). A gallery
// seat costs only a signature check, so bound what a seat can write: one entry per peer
// (dedup below) + these size caps — a modified client can't bloat the replicated gallery.
// The inline selfie image (a JPEG data URL) is the dominant field; caption is short.
// Oversized entries are dropped (not truncated).
const MAX_IMAGE_BYTES = 256 * 1024; // ~256 KB data-URL string (≈190 KB image after base64)
const MAX_CAPTION_BYTES = 512;

/**
 * A selfie enters the gallery only if it carries a join attestation validly
 * signed by its own peerId for this wave + writer core — the anti-spam gate
 * ("no signed join = no write"), enforced identically on every peer.
 * (Authenticity, not uniqueness — see verifyJoin.)
 * @param {SelfieOp} op - The candidate selfie op.
 * @returns {boolean} True if the op carries a valid join signed by its own peerId.
 */
function selfieHasValidJoin(op) {
  return !!(
    op.peerId &&
    op.writerKey &&
    op.joinSig &&
    verifyJoin(
      { waveId: op.waveId, peerId: op.peerId, writerKey: op.writerKey },
      op.joinSig
    )
  );
}

/**
 * Is this selfie's tip `address` provably the wallet that paid the peer's fee? The op carries
 * the peer's burn attestation; the address is trusted only if it's the `tronAddress` of a
 * validly-signed burn by this peer for this wave. (The burn's on-chain reality is checked
 * where it pays off — tippers/auditors via `burnTx`; here we bind the address to that same
 * burn deterministically.) So a tip always goes to the wallet that burned in, never a
 * self-declared unrelated address.
 * @param {SelfieOp} op - The candidate selfie op.
 * @returns {boolean} True if `op.address` is backed by a validly-signed burn naming that address.
 */
function tipAddressIsBackedByBurn(op) {
  return !!(
    op.address &&
    op.burn &&
    burnAuthorizes(op.burn, op.peerId, op.waveId) &&
    op.burn.tronAddress === op.address
  );
}

/**
 * Deterministic gallery: one entry per peer per wave (newest wins), ordered by sweep rank.
 * @param {SelfieOp[]} entries - The raw wave-selfie entries read from the view.
 * @returns {SelfieOp[]} The deduped, hop-ordered gallery entries.
 */
function buildGallery(entries) {
  const byKey = new Map();
  for (const entry of entries) {
    const key = entry.waveId + '|' + entry.peerId;
    const prev = byKey.get(key);
    if (!prev || entry.timestamp > prev.timestamp) {
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].sort(
    (a, b) => a.hopCount - b.hopCount || a.timestamp - b.timestamp
  );
}

/**
 * The pure CRDT merge (gallery-crdt.js): fold a bag of raw wave-selfie ops — collected
 * from every participant's own core — into the ordered gallery, applying one
 * deterministic gate over the whole set at once (no linearizer, no indexer). Every peer
 * that has replicated the same set of ops produces a byte-identical result, which is
 * what makes the gallery a conflict-free replicated data type. Drops ops without a
 * valid join attestation or over the byte caps; keeps a
 * tip `address` only if a matching burn backs it (else strips it), verifies-then-drops
 * the bulky `burn` (keeping `burnTx`); one entry per peer + hop order via buildGallery.
 * @param {SelfieOp[]} rawEntries - Raw ops read from participant cores.
 * @returns {SelfieOp[]} The deduped, hop-ordered gallery entries.
 */
function mergeGallery(rawEntries) {
  const valid = [];
  for (const op of rawEntries) {
    if (op?.type !== 'wave-selfie' || !selfieHasValidJoin(op)) {
      continue;
    }
    if ((op.image || '').length > MAX_IMAGE_BYTES) {
      continue;
    }
    if ((op.caption || '').length > MAX_CAPTION_BYTES) {
      continue;
    }
    const { burn, ...entry } = op;
    if (!tipAddressIsBackedByBurn(op)) {
      entry.address = ''; // unverified address → not tippable
    }
    if (burn && burn.txHash) {
      entry.burnTx = burn.txHash;
    }
    valid.push(entry);
  }
  return buildGallery(valid);
}

module.exports = { buildGallery, mergeGallery };
