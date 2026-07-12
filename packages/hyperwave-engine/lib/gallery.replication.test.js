// Transitive gallery replication over a PARTIAL mesh (line topology), no swarm —
// answers scalable-topology.md §4.7. Peers are wired A<->B and B<->C but NOT A<->C, so
// A and C are never directly connected. We assert the selfie-gallery Autobase replicates
// *transitively*: C learns it's a writer and converges to A's writes purely by forwarding
// through B, and A likewise receives C's write through B. This is the exact case the
// full-mesh spike (spike/multiwriter) never exercised.
// Runs under Bare:  bare workers/lib/gallery.replication.test.js   (or `npm test`)
const test = require('brittle');
const fs = require('bare-fs');
const Corestore = require('corestore');
const Autobase = require('autobase');
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const { galleryConfig, readGallery } = require('./gallery');
const { signReceipt } = require('./token');

const WAVE = 'w';
const CHAIN_HASH = b4a.toString(b4a.alloc(32), 'hex');
const RECEIPT_TS = 1000;

// a wave-selfie op with a valid receipt signed by keyPair (apply() drops invalid ones)
function selfie(keyPair, hopCount, caption) {
  return {
    type: 'wave-selfie',
    waveId: WAVE,
    peerId: b4a.toString(keyPair.publicKey, 'hex'),
    hopCount,
    chainHash: CHAIN_HASH,
    receiptTs: RECEIPT_TS,
    receiptSig: signReceipt(keyPair, {
      waveId: WAVE,
      hopCount,
      prevChainHash: CHAIN_HASH,
      timestamp: RECEIPT_TS
    }),
    caption,
    timestamp: hopCount
  };
}

// wire two stores together with a single replication stream pair (one direct edge)
function link(store1, store2) {
  const stream1 = store1.replicate(true);
  const stream2 = store2.replicate(false);
  stream1.pipe(stream2).pipe(stream1);
  stream1.on('error', () => {});
  stream2.on('error', () => {});
  return [stream1, stream2];
}

function until(pred, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = async () => {
      let ok = false;
      try {
        ok = await pred();
      } catch {}
      if (ok) {
        resolve(true);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(tick, 120);
    };
    tick();
  });
}

async function captions(base) {
  await base.update();
  const entries = await readGallery(base);
  return entries.map((entry) => entry.caption).sort();
}

test('gallery replicates transitively across a line A—B—C (no A<->C link)', async (t) => {
  const dirs = ['a', 'b', 'c'].map(
    (name) => `/tmp/hyperwave-repl-${name}-${Date.now()}`
  );
  const [storeA, storeB, storeC] = dirs.map((dir) => new Corestore(dir));

  // A creates the gallery; B and C open it from A's bootstrap key.
  const baseA = new Autobase(
    storeA.namespace('wave-gallery:' + WAVE),
    null,
    galleryConfig()
  );
  await baseA.ready();
  const key = baseA.key;
  const baseB = new Autobase(
    storeB.namespace('wave-gallery:' + WAVE),
    key,
    galleryConfig()
  );
  const baseC = new Autobase(
    storeC.namespace('wave-gallery:' + WAVE),
    key,
    galleryConfig()
  );
  await baseB.ready();
  await baseC.ready();

  // LINE topology: A<->B and B<->C only. B is the sole bridge between A and C.
  const streams = [...link(storeA, storeB), ...link(storeB, storeC)];

  t.teardown(async () => {
    for (const stream of streams) {
      stream.destroy();
    }
    await baseA.close();
    await baseB.close();
    await baseC.close();
    await storeA.close();
    await storeB.close();
    await storeC.close();
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const keyPairA = crypto.keyPair();
  const keyPairB = crypto.keyPair();
  const keyPairC = crypto.keyPair();

  // A admits B and C as writers (in the app this is the add-writer gossip; applied
  // directly here — this test is about the *data* plane, not the control plane).
  await baseA.append({
    type: 'add-writer',
    key: b4a.toString(baseB.local.key, 'hex')
  });
  await baseA.append({
    type: 'add-writer',
    key: b4a.toString(baseC.local.key, 'hex')
  });

  // C becoming writable already proves A's membership/system core reached it THROUGH B.
  t.ok(
    await until(async () => {
      await baseB.update();
      return baseB.writable;
    }),
    'B admitted as writer (A<->B direct)'
  );
  t.ok(
    await until(async () => {
      await baseC.update();
      return baseC.writable;
    }),
    'C admitted as writer — system core forwarded A→B→C'
  );

  // each peer writes one selfie into its own input core
  await baseA.append(selfie(keyPairA, 0, 'A'));
  await baseB.append(selfie(keyPairB, 1, 'B'));
  await baseC.append(selfie(keyPairC, 2, 'C'));

  // C must converge to all three — crucially A's, which reaches C only by forwarding
  // through B (A and C share no direct connection).
  t.ok(
    await until(async () => (await captions(baseC)).length === 3),
    'C converged to all 3'
  );
  t.alike(
    await captions(baseC),
    ['A', 'B', 'C'],
    'C has A (transitive via B), B (direct), C (own)'
  );

  // …and A receives C's selfie, which likewise only reaches A through B.
  t.ok(
    await until(async () => (await captions(baseA)).length === 3),
    'A converged to all 3'
  );
  t.alike(await captions(baseA), ['A', 'B', 'C'], 'A has C (transitive via B)');
});

// No roles: a wave's INITIATOR is its own gallery archivist — it retains the gallery it created
// so a peer that shows up later still gets it. The originator creates the gallery and posts; it
// STAYS ONLINE (the retained source); a latecomer connects to it afterwards and converges to the
// full gallery. (If the initiator itself goes offline, the gallery isn't archived by anyone
// else — the accepted simplification of dropping the standalone seed role.)
test('the initiator retains its gallery and serves a latecomer', async (t) => {
  const dirs = ['orig', 'late'].map(
    (name) => `/tmp/hyperwave-retain-${name}-${Date.now()}`
  );
  const [storeA, storeC] = dirs.map((dir) => new Corestore(dir));
  const streams = [];
  const closed = new Set();
  const shut = async (resource) => {
    if (resource && !closed.has(resource)) {
      closed.add(resource);
      await resource.close().catch(() => {});
    }
  };

  // the initiator creates the gallery and keeps it open (it's the archivist for its own wave)
  const baseA = new Autobase(
    storeA.namespace('wave-gallery:' + WAVE),
    null,
    galleryConfig()
  );
  await baseA.ready();
  const key = baseA.key;
  let baseC = null;

  t.teardown(async () => {
    for (const stream of streams) {
      try {
        stream.destroy();
      } catch {}
    }
    await shut(baseA);
    await shut(baseC);
    await shut(storeA);
    await shut(storeC);
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await baseA.append(selfie(crypto.keyPair(), 0, 'A'));

  // a latecomer shows up AFTER the post and connects only to the retained initiator
  baseC = new Autobase(
    storeC.namespace('wave-gallery:' + WAVE),
    key,
    galleryConfig()
  );
  await baseC.ready();
  streams.push(...link(storeA, storeC));

  t.ok(
    await until(async () => (await captions(baseC)).length === 1),
    'latecomer got the gallery from the initiator that retained it'
  );
  t.alike(
    await captions(baseC),
    ['A'],
    'the initiator served its retained gallery'
  );
});
