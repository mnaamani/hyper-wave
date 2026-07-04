// In-process test of the gallery Autobase code path + the receipt write-gate. Runs
// under Bare:  bare workers/lib/wave.autobase.test.js   (or `npm test`)
// Exercises the real galleryConfig() apply/open + readGallery: create base, admit a
// writer, append wave-selfie ops (only receipt-valid ones survive), read them back
// ordered. Multi-writer *replication* across processes is covered by spike/multiwriter.
const test = require('brittle')
const fs = require('bare-fs')
const Corestore = require('corestore')
const Autobase = require('autobase')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { galleryConfig, readGallery, readBurns } = require('./gallery')
const { signReceipt, signBurn } = require('./token')

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

test('gallery apply() appends valid selfies, rejects unsigned/impersonated', async (t) => {
  const dir = '/tmp/hyperwave-autobase-test-' + Date.now()
  const store = new Corestore(dir)
  const base = new Autobase(store.namespace('wave-gallery'), null, galleryConfig())
  t.teardown(async () => {
    await base.close()
    await store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await base.ready()

  t.ok(base.writable, 'creator is writable')
  t.ok(base.key, 'base has a bootstrap key')

  const p1 = crypto.keyPair()
  const p2 = crypto.keyPair()

  await base.append(selfie(p2, 1, 'second', 100))
  await base.append(selfie(p1, 0, 'first', 100))
  await base.append(selfie(p1, 0, 'first-newer', 200)) // newer selfie from p1, same hop
  await base.update()
  t.alike(
    (await readGallery(base)).map((g) => g.caption),
    ['first-newer', 'second'],
    'ordered by hop, newest-per-peer'
  )

  // receipt gate: a selfie with a bad signature is dropped by apply()
  const forged = selfie(p1, 2, 'forged', 300)
  forged.receiptSig = forged.receiptSig.replace(/^../, '00')
  await base.append(forged)
  await base.update()
  t.is((await readGallery(base)).length, 2, 'invalid receipt dropped')

  // receipt gate: impersonation (peerId != signer) is dropped
  const impersonated = selfie(p1, 3, 'impostor', 400)
  impersonated.peerId = b4a.toString(p2.publicKey, 'hex') // claim to be p2
  await base.append(impersonated)
  await base.update()
  t.is((await readGallery(base)).length, 2, 'impersonated selfie dropped')

  // add-writer op is accepted by apply() without throwing
  await base.append({ type: 'add-writer', key: b4a.toString(crypto.keyPair().publicKey, 'hex') })
  await base.update()
  t.pass('add-writer op processed by apply()')
})

test('gallery apply() admits valid burn-proofs, rejects forged ones', async (t) => {
  const dir = '/tmp/hyperwave-burn-test-' + Date.now()
  const store = new Corestore(dir)
  const base = new Autobase(store.namespace('wave-gallery'), null, galleryConfig())
  t.teardown(async () => {
    await base.close()
    await store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await base.ready()

  const kp = crypto.keyPair()
  const peerId = b4a.toString(kp.publicKey, 'hex')
  const f = {
    waveId: WAVE,
    peerId,
    reason: 'join',
    amount: 1,
    txHash: 'abc123',
    tronAddress: 'TJbnv',
    burnTs: 1000
  }
  await base.append({ type: 'burn-proof', ...f, sig: signBurn(kp, f) })
  // forged: someone else re-signs claiming to be peerId (sig won't verify by peerId)
  const other = crypto.keyPair()
  await base.append({ type: 'burn-proof', ...f, sig: signBurn(other, f) })
  await base.update()

  const burns = await readBurns(base)
  t.is(burns.length, 1, 'only the validly-signed burn-proof admitted')
  t.is(burns[0].txHash, 'abc123')
  t.is((await readGallery(base)).length, 0, 'burn-proofs do not appear in the selfie gallery')
})
