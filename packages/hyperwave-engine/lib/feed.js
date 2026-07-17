// The wave entry feed's pure logic: mergeFeed (the CRDT merge + write-gate —
// feed-crdt.js holds the cores, this holds the math) and buildFeed (the
// deterministic ordering). The single-indexer Autobase baseline (feedConfig/
// readFeed) and its A/B replication benchmark were deleted once the CRDT feed
// was validated — resurrect from git history if a comparison is ever needed again.
const { verifyJoin, burnAuthorizes } = require('./attest');

/**
 * A `wave-entry` op (the shape a participant appends to its core; read back into the feed).
 * @typedef {Object} EntryOp
 * @property {string} type - Op discriminator; a feed entry is `'wave-entry'`.
 * @property {string} waveId - The wave this entry belongs to.
 * @property {string} peerId - Hex id of the peer that posted the entry.
 * @property {number} hopCount - The peer's rank in the sweep schedule (feed ordering key).
 * @property {string} writerKey - The poster's feed writer core key (hex).
 * @property {string} joinSig - Ed25519 join-attestation signature (hex) binding the op to `peerId`.
 * @property {*} payload - Opaque application content (arbitrary JSON the host owns; the
 *   engine only transports + byte-caps it — e.g. the desktop app puts {image, caption} here).
 * @property {string} [tag] - The poster's cosmetic tag (self-reported, read at post time).
 * @property {number} timestamp - Wall-clock time (ms) the entry was created.
 * @property {string} [address] - Tip destination Tron address (kept only if backed by a burn).
 * @property {Object} [burn] - Burn attestation proof (verified then dropped; `burnTx` kept).
 */

// Per-entry write budget (deterministic, enforced identically on every peer). A feed
// seat costs only a signature check, so bound what a seat can write: one entry per peer
// (dedup below) + this size cap on the serialized opaque payload — a modified client
// can't bloat the replicated feed. Oversized entries are dropped (not truncated).
const MAX_PAYLOAD_BYTES = 256 * 1024; // ~256 KB serialized payload (fits a JPEG thumbnail data-URL)

/**
 * A entry enters the feed only if it carries a join attestation validly
 * signed by its own peerId for this wave + writer core — the anti-spam gate
 * ("no signed join = no write"), enforced identically on every peer.
 * (Authenticity, not uniqueness — see verifyJoin.)
 * @param {EntryOp} op - The candidate entry op.
 * @returns {boolean} True if the op carries a valid join signed by its own peerId.
 */
function entryHasValidJoin(op) {
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
 * Is this entry's tip `address` provably the wallet that paid the peer's fee? The op carries
 * the peer's burn attestation; the address is trusted only if it's the `payerAddress` of a
 * validly-signed burn by this peer for this wave. (The burn's real-world settlement is checked
 * where it pays off — tippers/auditors via `burnTx`; here we bind the address to that same
 * burn deterministically.) So a tip always goes to the wallet that burned in, never a
 * self-declared unrelated address.
 * @param {EntryOp} op - The candidate entry op.
 * @returns {boolean} True if `op.address` is backed by a validly-signed burn naming that address.
 */
function tipAddressIsBackedByBurn(op) {
  return !!(
    op.address &&
    op.burn &&
    burnAuthorizes(op.burn, op.peerId, op.waveId) &&
    op.burn.payerAddress === op.address
  );
}

/**
 * Serialized byte length of an opaque payload (the byte-cap measure). A payload that
 * can't be serialized (cycles, etc.) is treated as oversized so it's dropped, never thrown.
 * @param {*} payload - The opaque entry payload.
 * @returns {number} The JSON byte length, or Infinity if it can't be serialized.
 */
function payloadBytes(payload) {
  if (payload === undefined || payload === null) {
    return 0;
  }
  try {
    return JSON.stringify(payload).length;
  } catch {
    return Infinity;
  }
}

/**
 * Deterministic feed: one entry per peer per wave (newest wins), ordered by sweep rank.
 * @param {EntryOp[]} entries - The raw wave-entry entries read from the view.
 * @returns {EntryOp[]} The deduped, hop-ordered feed entries.
 */
function buildFeed(entries) {
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
 * The pure CRDT merge (feed-crdt.js): fold a bag of raw wave-entry ops — collected
 * from every participant's own core — into the ordered feed, applying one
 * deterministic gate over the whole set at once (no linearizer, no indexer). Every peer
 * that has replicated the same set of ops produces a byte-identical result, which is
 * what makes the feed a conflict-free replicated data type. Drops ops without a
 * valid join attestation or whose serialized payload exceeds the byte cap; keeps a
 * tip `address` only if a matching burn backs it (else strips it), verifies-then-drops
 * the bulky `burn` (keeping `burnTx`); one entry per peer + hop order via buildFeed.
 * @param {EntryOp[]} rawEntries - Raw ops read from participant cores.
 * @returns {EntryOp[]} The deduped, hop-ordered feed entries.
 */
function mergeFeed(rawEntries) {
  const valid = [];
  for (const op of rawEntries) {
    if (op?.type !== 'wave-entry' || !entryHasValidJoin(op)) {
      continue;
    }
    if (payloadBytes(op.payload) > MAX_PAYLOAD_BYTES) {
      continue;
    }
    const { burn, ...entry } = op;
    if (!tipAddressIsBackedByBurn(op)) {
      entry.address = ''; // unverified address → not tippable
    }
    if (burn && burn.burnRef) {
      entry.burnTx = burn.burnRef;
    }
    valid.push(entry);
  }
  return buildFeed(valid);
}

module.exports = { buildFeed, mergeFeed };
