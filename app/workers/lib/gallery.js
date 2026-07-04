// The wave selfie gallery: an Autobase multi-writer log merged into one ordered
// view. Config + read/ordering helpers live here (pure/Autobase, no swarm); the
// orchestrator in wave.js owns the live base instance. Unit-tested in
// wave.gallery.test.js and wave.autobase.test.js.
const b4a = require('b4a')
const { verifyReceipt, verifyBurn } = require('./token')

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

// A burn-proof (the participation-fee attestation) is admitted only if its Ed25519 `sig`
// validly binds the ring `peerId` to the on-chain burn (txHash + tronAddress). The
// validator additionally cross-checks txHash on the chain before crediting it.
function burnProofValid(op) {
  return !!(op.peerId && op.sig && verifyBurn(op, op.sig))
}

// Autobase config shared by the engine and tests so apply/view is exercised
// identically. apply() admits writers and appends only receipt-valid wave-selfie
// ops into a single ordered view.
function galleryConfig() {
  return {
    valueEncoding: 'json',
    open: (s) => s.get('gallery', { valueEncoding: 'json' }),
    async apply(nodes, view, host) {
      for (const node of nodes) {
        const op = node.value
        if (op?.type === 'add-writer') {
          try {
            await host.addWriter(b4a.from(op.key, 'hex'), { indexer: true })
          } catch {}
          continue
        }
        if (op?.type === 'wave-selfie' && selfieHasValidReceipt(op)) await view.append(op)
        if (op?.type === 'burn-proof' && burnProofValid(op)) await view.append(op)
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

// Read the burn-proofs (participation-fee attestations) out of the view — the validator's
// record of who paid, deduped by (peerId, reason) with newest first. apply() already
// admitted only signature-valid ones; the validator still cross-checks each txHash on-chain.
async function readBurns(base) {
  const view = base.view
  const byKey = new Map()
  for (let i = 0; i < view.length; i++) {
    const e = await view.get(i)
    if (e?.type !== 'burn-proof') continue
    byKey.set(e.peerId + '|' + e.reason, e) // last write wins per (peer, reason)
  }
  return [...byKey.values()]
}

module.exports = { galleryConfig, buildGallery, readGallery, readBurns }
