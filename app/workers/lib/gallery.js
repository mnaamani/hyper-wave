// The wave selfie gallery: an Autobase multi-writer log merged into one ordered
// view. Config + read/ordering helpers live here (pure/Autobase, no swarm); the
// orchestrator in wave.js owns the live base instance. Unit-tested in
// wave.gallery.test.js and wave.autobase.test.js.
const b4a = require('b4a')

// Autobase config shared by the engine and tests so apply/view is exercised
// identically. apply() admits writers (the anti-spam gate) and appends wave-selfie
// ops into a single ordered view.
function galleryConfig () {
  return {
    valueEncoding: 'json',
    open: (s) => s.get('gallery', { valueEncoding: 'json' }),
    async apply (nodes, view, host) {
      for (const node of nodes) {
        const op = node.value
        if (op?.type === 'add-writer') {
          try {
            await host.addWriter(b4a.from(op.key, 'hex'), { indexer: true })
          } catch {}
          continue
        }
        if (op?.type === 'wave-selfie') await view.append(op)
      }
    }
  }
}

// Deterministic gallery: one entry per peer per wave (newest wins), ordered by hop.
function buildGallery (entries) {
  const byKey = new Map()
  for (const e of entries) {
    const k = e.waveId + '|' + e.peerId
    const prev = byKey.get(k)
    if (!prev || e.timestamp > prev.timestamp) byKey.set(k, e)
  }
  return [...byKey.values()].sort((a, b) => a.hopCount - b.hopCount || a.timestamp - b.timestamp)
}

// Read all wave-selfie entries out of an Autobase view into an ordered gallery.
async function readGallery (base) {
  const view = base.view
  const items = []
  for (let i = 0; i < view.length; i++) {
    const e = await view.get(i)
    if (e?.type === 'wave-selfie') items.push(e)
  }
  return buildGallery(items)
}

module.exports = { galleryConfig, buildGallery, readGallery }
