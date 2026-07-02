// In-process test of the gallery Autobase code path + the receipt gate. Runs under
// Bare:  bare workers/lib/wave.autobase.test.js
// Exercises the real galleryConfig() apply/open + readGallery: create base, admit a
// writer, append wave-selfie ops (only receipt-valid ones survive), read them back
// ordered. Multi-writer *replication* across processes is covered by spike/multiwriter.
const assert = require('bare-assert')
const deepEq = (a, b, msg) =>
  assert.ok(
    JSON.stringify(a) === JSON.stringify(b),
    msg || JSON.stringify(a) + ' !== ' + JSON.stringify(b)
  )
const fs = require('bare-fs')
const Corestore = require('corestore')
const Autobase = require('autobase')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { galleryConfig, readGallery } = require('./gallery')
const { signReceipt } = require('./token')

const WAVE = 'w'
const CH = b4a.toString(b4a.alloc(32), 'hex') // some chain hash value
const RT = 1000 // receipt timestamp

// build a wave-selfie op with a valid receipt signed by kp
function selfie(kp, hopCount, caption, timestamp) {
  const peerId = b4a.toString(kp.publicKey, 'hex')
  const receiptSig = signReceipt(kp, WAVE, hopCount, CH, RT)
  return {
    type: 'wave-selfie',
    waveId: WAVE,
    peerId,
    hopCount,
    chainHash: CH,
    receiptTs: RT,
    receiptSig,
    caption,
    timestamp
  }
}

async function main() {
  const dir = '/tmp/hyperwave-autobase-test-' + Date.now()
  const store = new Corestore(dir)
  const base = new Autobase(store.namespace('wave-gallery'), null, galleryConfig())
  await base.ready()

  assert.ok(base.writable, 'creator is writable')
  assert.ok(base.key, 'base has a bootstrap key')

  const p1 = crypto.keyPair()
  const p2 = crypto.keyPair()

  await base.append(selfie(p2, 1, 'second', 100))
  await base.append(selfie(p1, 0, 'first', 100))
  await base.append(selfie(p1, 0, 'first-newer', 200)) // newer selfie from p1, same hop
  await base.update()

  const gallery = await readGallery(base)
  deepEq(
    gallery.map((g) => g.caption),
    ['first-newer', 'second'],
    'ordered by hop, newest-per-peer'
  )
  console.log('ok - valid selfies append and read back ordered via the real apply/view')

  // receipt gate: a selfie with a bad signature is dropped by apply()
  const forged = selfie(p1, 2, 'forged', 300)
  forged.receiptSig = forged.receiptSig.replace(/^../, '00')
  await base.append(forged)
  await base.update()
  assert.strictEqual((await readGallery(base)).length, 2, 'invalid receipt dropped')
  console.log('ok - selfie with an invalid receipt is rejected by apply()')

  // receipt gate: impersonation (peerId != signer) is dropped
  const impersonated = selfie(p1, 3, 'impostor', 400)
  impersonated.peerId = b4a.toString(p2.publicKey, 'hex') // claim to be p2
  await base.append(impersonated)
  await base.update()
  assert.strictEqual((await readGallery(base)).length, 2, 'impersonated selfie dropped')
  console.log('ok - impersonated selfie (peerId != signer) is rejected')

  // add-writer op is accepted by apply() without throwing
  const other = crypto.keyPair()
  await base.append({ type: 'add-writer', key: b4a.toString(other.publicKey, 'hex') })
  await base.update()
  console.log('ok - add-writer op processed by apply()')

  await base.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
  console.log('\n4 passed')
  Bare.exit(0)
}

main().catch((err) => {
  console.error('FAIL', err)
  Bare.exit(1)
})
