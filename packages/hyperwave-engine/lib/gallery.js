// The wave selfie gallery: an Autobase multi-writer log merged into one ordered
// view. Config + read/ordering helpers live here (pure/Autobase, no swarm); the
// orchestrator in wave.js owns the live base instance. Unit-tested in
// wave.gallery.test.js and wave.autobase.test.js.
const b4a = require('b4a');
const { verifyJoin, burnAuthorizes } = require('./attest');

/**
 * A `wave-selfie` op (the shape appended to the Autobase log and read back into the gallery).
 * @typedef {Object} SelfieOp
 * @property {string} type - Op discriminator; a gallery selfie is `'wave-selfie'`.
 * @property {string} waveId - The wave this selfie belongs to.
 * @property {string} peerId - Hex id of the peer that posted the selfie.
 * @property {number} hopCount - The peer's hop index in the token lap (gallery ordering key).
 * @property {string} writerKey - The poster's gallery writer core key (hex).
 * @property {string} joinSig - Ed25519 join-attestation signature (hex) binding the op to `peerId`.
 * @property {string} image - Inline selfie image as a JPEG data URL.
 * @property {string} caption - Short caption text.
 * @property {number} timestamp - Wall-clock time (ms) the entry was created.
 * @property {string} [address] - Tip destination Tron address (kept only if backed by a burn).
 * @property {Object} [burn] - Burn attestation proof (verified then dropped; `burnTx` kept).
 */

// Per-entry write budget (deterministic, enforced in apply on every peer). With OPTIMISTIC
// admission a gallery seat no longer costs a verified on-chain burn, so bound what a seat can
// write: one entry per peer (dedup below) + these size caps. Keeps a modified client from
// bloating the replicated/retained gallery. The inline selfie image (a JPEG data URL) is the
// dominant field; caption is short. Oversized entries are dropped (not truncated).
const MAX_IMAGE_BYTES = 256 * 1024; // ~256 KB data-URL string (≈190 KB image after base64)
const MAX_CAPTION_BYTES = 512;

/**
 * A selfie is admitted to the gallery only if it carries a join attestation
 * validly signed by its own peerId for this wave + writer core — the anti-spam
 * gate ("no signed join = no write"). Runs in apply() so every peer enforces
 * it identically. (Authenticity, not uniqueness — see verifyJoin.)
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
 * validly-signed burn by this peer for this wave. (The burn's on-chain reality is checked at
 * admission, §8.2 — here we bind the address to that same burn deterministically.) So a tip
 * always goes to the wallet that burned in, never a self-declared unrelated address.
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
 * Autobase config shared by the engine and tests so apply/view is exercised identically.
 * apply() admits writers and appends join-attested wave-selfie ops into one ordered view,
 * enforcing two rules deterministically on every peer:
 *   - one entry per peer per wave (first write wins) — bounds the log so a paid seat can't be
 *     used to append unbounded entries (only the display was deduped before);
 *   - the tip `address` survives only if a signed burn backs it, else it's stripped (the
 *     selfie still shows, but isn't tippable to an unverified wallet).
 * The bulky `burn` attestation is verified then dropped, so stored entries stay lean.
 * @returns {{valueEncoding: string, open: (store: Object) => Object, apply: (nodes: Object[], view: Object, host: Object) => Promise<void>}}
 *   An Autobase config: `valueEncoding` (`'json'`), `open(store)` (opens the `gallery` view core),
 *   and the async `apply(nodes, view, host)` reducer described above.
 */
function galleryConfig() {
  return {
    valueEncoding: 'json',
    open: (store) => store.get('gallery', { valueEncoding: 'json' }),
    async apply(nodes, view, host) {
      let seen = null; // lazily-built set of peerIds already in the view (per-peer dedup)
      for (const node of nodes) {
        const op = node.value;
        if (op?.type === 'add-writer') {
          try {
            // Add as a NON-indexer. Making every gallery writer an indexer means Autobase needs an
            // indexer quorum to advance the indexed log — and in a churny mesh that quorum stalls,
            // freezing indexing (seen as indexed ≪ length). A stalled index leaves later add-writer
            // ops unprocessed, so `system` never learns the last writer(s) and their selfies never
            // linearize — the originator (and others) settle short of the roster. Only the bootstrap
            // writer (the wave initiator, who archives this gallery) indexes; every joiner is a plain
            // writer whose entries still linearize under that single indexer. No quorum, no stall.
            await host.addWriter(b4a.from(op.key, 'hex'), { indexer: false });
          } catch {}
          continue;
        }
        if (op?.type !== 'wave-selfie' || !selfieHasValidJoin(op)) {
          continue;
        }
        // size cap (optimistic admission → bound each seat's write); drop oversized entries
        if ((op.image || '').length > MAX_IMAGE_BYTES) {
          continue;
        }
        if ((op.caption || '').length > MAX_CAPTION_BYTES) {
          continue;
        }
        if (seen === null) {
          seen = new Set();
          for (let i = 0; i < view.length; i++) {
            const existing = await view.get(i);
            if (existing?.type === 'wave-selfie') {
              seen.add(existing.peerId);
            }
          }
        }
        if (seen.has(op.peerId)) {
          continue; // one selfie per peer per wave — drop extras
        }
        seen.add(op.peerId);
        const { burn, ...entry } = op;
        if (!tipAddressIsBackedByBurn(op)) {
          entry.address = ''; // unverified address → not tippable
        }
        // Keep the burn txHash (the rest of the bulky attestation is dropped): it lets tippers
        // and any auditor fetch the tx and verify the fee burn on-chain.
        if (burn && burn.txHash) {
          entry.burnTx = burn.txHash;
        }
        await view.append(entry);
      }
    }
  };
}

/**
 * Deterministic gallery: one entry per peer per wave (newest wins), ordered by hop.
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
 * Read all wave-selfie entries out of an Autobase view into an ordered gallery.
 * @param {Object} base - A live Autobase instance (its `.view` is iterated).
 * @returns {Promise<SelfieOp[]>} The deduped, hop-ordered gallery entries.
 */
async function readGallery(base) {
  const view = base.view;
  const items = [];
  for (let i = 0; i < view.length; i++) {
    const entry = await view.get(i);
    if (entry?.type === 'wave-selfie') {
      items.push(entry);
    }
  }
  return buildGallery(items);
}

module.exports = { galleryConfig, buildGallery, readGallery };
