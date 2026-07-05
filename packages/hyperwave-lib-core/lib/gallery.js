// The wave selfie gallery: an Autobase multi-writer log merged into one ordered
// view. Config + read/ordering helpers live here (pure/Autobase, no swarm); the
// orchestrator in wave.js owns the live base instance. Unit-tested in
// wave.gallery.test.js and wave.autobase.test.js.
const b4a = require('b4a')
const { verifyReceipt, burnAuthorizes } = require('./token')

// Per-entry write budget (deterministic, enforced in apply on every peer). With OPTIMISTIC
// admission a gallery seat no longer costs a verified on-chain burn, so bound what a seat can
// write: one entry per peer (dedup below) + these size caps. Keeps a modified client from
// bloating the replicated/retained gallery. The inline selfie image (a JPEG data URL) is the
// dominant field; caption is short. Oversized entries are dropped (not truncated).
const MAX_IMAGE_BYTES = 256 * 1024 // ~256 KB data-URL string (≈190 KB image after base64)
const MAX_CAPTION_BYTES = 512

// A selfie is admitted to the gallery only if it carries a receipt validly signed
// by its own peerId for its hop — the anti-spam gate ("no receipt = no write").
// Runs in apply() so every peer enforces it identically. (Authenticity, not proof
// of token-holding — see verifyReceipt.)
function selfieHasValidReceipt(op) {
  return (
    op.peerId &&
    op.receiptSig &&
    verifyReceipt(op.peerId, op.waveId, op.hopCount, op.chainHash, op.receiptTs, op.receiptSig)
  )
}

// Is this selfie's tip `address` provably the wallet that paid the peer's fee? The op carries
// the peer's burn attestation; the address is trusted only if it's the `tronAddress` of a
// validly-signed burn by this peer for this wave. (The burn's on-chain reality is checked at
// admission, §8.2 — here we bind the address to that same burn deterministically.) So a tip
// always goes to the wallet that burned in, never a self-declared unrelated address.
function tipAddressIsBackedByBurn(op) {
  return !!(
    op.address &&
    op.burn &&
    burnAuthorizes(op.burn, op.peerId, op.waveId) &&
    op.burn.tronAddress === op.address
  )
}

// Autobase config shared by the engine and tests so apply/view is exercised identically.
// apply() admits writers and appends receipt-valid wave-selfie ops into one ordered view,
// enforcing two rules deterministically on every peer:
//   - one entry per peer per wave (first write wins) — bounds the log so a paid seat can't be
//     used to append unbounded entries (only the display was deduped before);
//   - the tip `address` survives only if a signed burn backs it, else it's stripped (the
//     selfie still shows, but isn't tippable to an unverified wallet).
// The bulky `burn` attestation is verified then dropped, so stored entries stay lean.
function galleryConfig() {
  return {
    valueEncoding: 'json',
    open: (s) => s.get('gallery', { valueEncoding: 'json' }),
    async apply(nodes, view, host) {
      let seen = null // lazily-built set of peerIds already in the view (per-peer dedup)
      for (const node of nodes) {
        const op = node.value
        if (op?.type === 'add-writer') {
          try {
            await host.addWriter(b4a.from(op.key, 'hex'), { indexer: true })
          } catch {}
          continue
        }
        if (op?.type !== 'wave-selfie' || !selfieHasValidReceipt(op)) continue
        // size cap (optimistic admission → bound each seat's write); drop oversized entries
        if ((op.image || '').length > MAX_IMAGE_BYTES) continue
        if ((op.caption || '').length > MAX_CAPTION_BYTES) continue
        if (seen === null) {
          seen = new Set()
          for (let i = 0; i < view.length; i++) {
            const e = await view.get(i)
            if (e?.type === 'wave-selfie') seen.add(e.peerId)
          }
        }
        if (seen.has(op.peerId)) continue // one selfie per peer per wave — drop extras
        seen.add(op.peerId)
        const { burn, ...entry } = op
        if (!tipAddressIsBackedByBurn(op)) entry.address = '' // unverified address → not tippable
        // Keep the burn txHash (the rest of the bulky attestation is dropped): it lets the seed
        // and any auditor fetch the tx and read the on-chain raffle commit (ideas/raffle.md).
        if (burn && burn.txHash) entry.burnTx = burn.txHash
        await view.append(entry)
      }
    }
  }
}

// Deterministic gallery: one entry per peer per wave (newest wins), ordered by hop.
function buildGallery(entries) {
  const byKey = new Map()
  for (const e of entries) {
    const k = e.waveId + '|' + e.peerId
    const prev = byKey.get(k)
    if (!prev || e.timestamp > prev.timestamp) byKey.set(k, e)
  }
  return [...byKey.values()].sort((a, b) => a.hopCount - b.hopCount || a.timestamp - b.timestamp)
}

// Read all wave-selfie entries out of an Autobase view into an ordered gallery.
async function readGallery(base) {
  const view = base.view
  const items = []
  for (let i = 0; i < view.length; i++) {
    const e = await view.get(i)
    if (e?.type === 'wave-selfie') items.push(e)
  }
  return buildGallery(items)
}

module.exports = { galleryConfig, buildGallery, readGallery }
