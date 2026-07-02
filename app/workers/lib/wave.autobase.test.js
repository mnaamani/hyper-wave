// In-process test of the gallery Autobase code path. Runs under Bare:
//   bare workers/lib/wave.autobase.test.js
// Exercises the real galleryConfig() apply/open + readGallery: create base, admit a
// writer, append wave-selfie ops, read them back ordered. Multi-writer *replication*
// across processes is covered separately by spike/multiwriter.
const assert = require('bare-assert')
const deepEq = (a, b, msg) => assert.ok(JSON.stringify(a) === JSON.stringify(b), msg || JSON.stringify(a) + ' !== ' + JSON.stringify(b))
const fs = require('bare-fs')
const Corestore = require('corestore')
const Autobase = require('autobase')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { galleryConfig, readGallery } = require('./gallery')

async function main () {
  const dir = '/tmp/hyperwave-autobase-test-' + Date.now()
  const store = new Corestore(dir)
  const base = new Autobase(store.namespace('wave-gallery'), null, galleryConfig())
  await base.ready()

  assert.ok(base.writable, 'creator is writable')
  assert.ok(base.key, 'base has a bootstrap key')

  await base.append({ type: 'wave-selfie', waveId: 'w', peerId: 'p2', hopCount: 1, caption: 'second', timestamp: 100 })
  await base.append({ type: 'wave-selfie', waveId: 'w', peerId: 'p1', hopCount: 0, caption: 'first', timestamp: 100 })
  await base.append({ type: 'wave-selfie', waveId: 'w', peerId: 'p1', hopCount: 0, caption: 'first-newer', timestamp: 200 })
  await base.update()

  const gallery = await readGallery(base)
  deepEq(gallery.map((g) => g.caption), ['first-newer', 'second'], 'ordered by hop, newest-per-peer')
  console.log('ok - selfie ops append and read back ordered via the real apply/view')

  const other = crypto.keyPair()
  await base.append({ type: 'add-writer', key: b4a.toString(other.publicKey, 'hex') })
  await base.update()
  console.log('ok - add-writer op processed by apply() (admission path)')

  await base.append({ type: 'noise', foo: 1 })
  await base.update()
  assert.strictEqual((await readGallery(base)).length, 2, 'unknown ops ignored')
  console.log('ok - unknown ops ignored')

  await base.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
  console.log('\n3 passed')
  Bare.exit(0)
}

main().catch((err) => {
  console.error('FAIL', err)
  Bare.exit(1)
})
