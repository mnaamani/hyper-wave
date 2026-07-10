// In-process test of the gallery Autobase code path + the receipt write-gate. Runs
// under Bare:  bare workers/lib/wave.autobase.test.js   (or `npm test`)
// Exercises the real galleryConfig() apply/open + readGallery: create base, admit a
// writer, append wave-selfie ops (only receipt-valid ones survive), read them back
// ordered. Multi-writer *replication* across processes is covered by spike/multiwriter.
const test = require('brittle');
const fs = require('bare-fs');
const Corestore = require('corestore');
const Autobase = require('autobase');
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const { galleryConfig, readGallery } = require('./gallery');
const { signReceipt, signBurn } = require('./token');

const WAVE = 'w';
const CHAIN_HASH = b4a.toString(b4a.alloc(32), 'hex'); // some chain hash value
const RECEIPT_TS = 1000; // receipt timestamp

// build a wave-selfie op with a valid receipt signed by keyPair
function selfie(keyPair, hopCount, caption, timestamp) {
  const peerId = b4a.toString(keyPair.publicKey, 'hex');
  const receiptSig = signReceipt(keyPair, {
    waveId: WAVE,
    hopCount,
    prevChainHash: CHAIN_HASH,
    timestamp: RECEIPT_TS
  });
  return {
    type: 'wave-selfie',
    waveId: WAVE,
    peerId,
    hopCount,
    chainHash: CHAIN_HASH,
    receiptTs: RECEIPT_TS,
    receiptSig,
    caption,
    timestamp
  };
}

test('gallery apply() appends valid selfies, rejects unsigned/impersonated', async (t) => {
  const dir = '/tmp/hyperwave-autobase-test-' + Date.now();
  const store = new Corestore(dir);
  const base = new Autobase(store.namespace('wave-gallery'), null, galleryConfig());
  t.teardown(async () => {
    await base.close();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await base.ready();

  t.ok(base.writable, 'creator is writable');
  t.ok(base.key, 'base has a bootstrap key');

  const peer1 = crypto.keyPair();
  const peer2 = crypto.keyPair();

  await base.append(selfie(peer2, 1, 'second', 100));
  await base.append(selfie(peer1, 0, 'first', 100));
  await base.append(selfie(peer1, 0, 'first-dupe', 200)); // a second selfie from peer1 — dropped at write
  await base.update();
  t.alike(
    (await readGallery(base)).map((entry) => entry.caption),
    ['first', 'second'],
    'ordered by hop; one entry per peer — peer1’s second post is dropped at write (#3)'
  );

  // receipt gate: a selfie with a bad signature is dropped by apply()
  const forged = selfie(peer1, 2, 'forged', 300);
  forged.receiptSig = forged.receiptSig.replace(/^../, '00');
  await base.append(forged);
  await base.update();
  t.is((await readGallery(base)).length, 2, 'invalid receipt dropped');

  // receipt gate: impersonation (peerId != signer) is dropped
  const impersonated = selfie(peer1, 3, 'impostor', 400);
  impersonated.peerId = b4a.toString(peer2.publicKey, 'hex'); // claim to be peer2
  await base.append(impersonated);
  await base.update();
  t.is((await readGallery(base)).length, 2, 'impersonated selfie dropped');

  // size cap: an oversized image is dropped (bounds each seat under optimistic admission).
  // Use a fresh peer so it's not blocked by the one-entry-per-peer dedup.
  const big = crypto.keyPair();
  const huge = selfie(big, 4, 'huge', 500);
  huge.image = 'x'.repeat(256 * 1024 + 1);
  await base.append(huge);
  await base.update();
  t.is((await readGallery(base)).length, 2, 'oversized-image selfie dropped');

  // add-writer op is accepted by apply() without throwing
  await base.append({ type: 'add-writer', key: b4a.toString(crypto.keyPair().publicKey, 'hex') });
  await base.update();
  t.pass('add-writer op processed by apply()');
});

// #2: a tip address survives apply() only if a signed burn (by the same peer, for this wave,
// naming that address) backs it — otherwise it's stripped, so tips can't go to a wallet that
// didn't pay in.
test('gallery apply() keeps a tip address only if a matching burn backs it', async (t) => {
  const dir = '/tmp/hyperwave-tipaddr-test-' + Date.now();
  const store = new Corestore(dir);
  const base = new Autobase(store.namespace('wave-gallery'), null, galleryConfig());
  t.teardown(async () => {
    await base.close();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await base.ready();

  const makeBurn = (keyPair, address) => {
    const fields = {
      waveId: WAVE,
      peerId: b4a.toString(keyPair.publicKey, 'hex'),
      reason: 'join',
      amount: 1,
      txHash: 'abc123',
      tronAddress: address,
      burnTs: 1000
    };
    return { ...fields, sig: signBurn(keyPair, fields) };
  };

  const paid = crypto.keyPair(); // burns from TPaid and tips there — legit
  const spoof = crypto.keyPair(); // claims a tip address with no backing burn
  await base.append({
    ...selfie(paid, 0, 'paid', 100),
    address: 'TPaid',
    burn: makeBurn(paid, 'TPaid')
  });
  await base.append({ ...selfie(spoof, 1, 'spoof', 100), address: 'TSpoof' }); // no burn
  // a burn that names a DIFFERENT address than the selfie claims → not honoured
  const mismatched = crypto.keyPair();
  await base.append({
    ...selfie(mismatched, 2, 'mismatch', 100),
    address: 'TClaim',
    burn: makeBurn(mismatched, 'TReal')
  });
  await base.update();

  const byCaption = Object.fromEntries(
    (await readGallery(base)).map((entry) => [entry.caption, entry.address])
  );
  t.is(byCaption.paid, 'TPaid', 'burn-backed address is kept (tippable)');
  t.is(byCaption.spoof, '', 'unbacked address is stripped (not tippable)');
  t.is(byCaption.mismatch, '', 'address not matching the burn wallet is stripped');
  t.absent(
    'burn' in (await base.view.get(0)),
    'the burn attestation is dropped from stored entries'
  );
});
