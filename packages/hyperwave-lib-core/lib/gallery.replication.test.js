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
const CH = b4a.toString(b4a.alloc(32), 'hex');
const RT = 1000;

// a wave-selfie op with a valid receipt signed by kp (apply() drops invalid ones)
function selfie(kp, hopCount, caption) {
  return {
    type: 'wave-selfie',
    waveId: WAVE,
    peerId: b4a.toString(kp.publicKey, 'hex'),
    hopCount,
    chainHash: CH,
    receiptTs: RT,
    receiptSig: signReceipt(kp, WAVE, hopCount, CH, RT),
    caption,
    timestamp: hopCount
  };
}

// wire two stores together with a single replication stream pair (one direct edge)
function link(s1, s2) {
  const a = s1.replicate(true);
  const b = s2.replicate(false);
  a.pipe(b).pipe(a);
  a.on('error', () => {});
  b.on('error', () => {});
  return [a, b];
}

function until(pred, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = async () => {
      let ok = false;
      try {
        ok = await pred();
      } catch {}
      if (ok) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 120);
    };
    tick();
  });
}

async function captions(base) {
  await base.update();
  return (await readGallery(base)).map((g) => g.caption).sort();
}

test('gallery replicates transitively across a line A—B—C (no A<->C link)', async (t) => {
  const dirs = ['a', 'b', 'c'].map((n) => `/tmp/hyperwave-repl-${n}-${Date.now()}`);
  const [storeA, storeB, storeC] = dirs.map((d) => new Corestore(d));

  // A creates the gallery; B and C open it from A's bootstrap key.
  const baseA = new Autobase(storeA.namespace('wave-gallery:' + WAVE), null, galleryConfig());
  await baseA.ready();
  const key = baseA.key;
  const baseB = new Autobase(storeB.namespace('wave-gallery:' + WAVE), key, galleryConfig());
  const baseC = new Autobase(storeC.namespace('wave-gallery:' + WAVE), key, galleryConfig());
  await baseB.ready();
  await baseC.ready();

  // LINE topology: A<->B and B<->C only. B is the sole bridge between A and C.
  const streams = [...link(storeA, storeB), ...link(storeB, storeC)];

  t.teardown(async () => {
    for (const s of streams) s.destroy();
    await baseA.close();
    await baseB.close();
    await baseC.close();
    await storeA.close();
    await storeB.close();
    await storeC.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  const kpA = crypto.keyPair();
  const kpB = crypto.keyPair();
  const kpC = crypto.keyPair();

  // A admits B and C as writers (in the app this is the add-writer gossip; applied
  // directly here — this test is about the *data* plane, not the control plane).
  await baseA.append({ type: 'add-writer', key: b4a.toString(baseB.local.key, 'hex') });
  await baseA.append({ type: 'add-writer', key: b4a.toString(baseC.local.key, 'hex') });

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
  await baseA.append(selfie(kpA, 0, 'A'));
  await baseB.append(selfie(kpB, 1, 'B'));
  await baseC.append(selfie(kpC, 2, 'C'));

  // C must converge to all three — crucially A's, which reaches C only by forwarding
  // through B (A and C share no direct connection).
  t.ok(await until(async () => (await captions(baseC)).length === 3), 'C converged to all 3');
  t.alike(
    await captions(baseC),
    ['A', 'B', 'C'],
    'C has A (transitive via B), B (direct), C (own)'
  );

  // …and A receives C's selfie, which likewise only reaches A through B.
  t.ok(await until(async () => (await captions(baseA)).length === 3), 'A converged to all 3');
  t.alike(await captions(baseA), ['A', 'B', 'C'], 'A has C (transitive via B)');
});

// No roles: a wave's INITIATOR is its own gallery archivist — it retains the gallery it created
// so a peer that shows up later still gets it. The originator creates the gallery and posts; it
// STAYS ONLINE (the retained source); a latecomer connects to it afterwards and converges to the
// full gallery. (If the initiator itself goes offline, the gallery isn't archived by anyone
// else — the accepted simplification of dropping the standalone seed role.)
test('the initiator retains its gallery and serves a latecomer', async (t) => {
  const dirs = ['orig', 'late'].map((n) => `/tmp/hyperwave-retain-${n}-${Date.now()}`);
  const [storeA, storeC] = dirs.map((d) => new Corestore(d));
  const streams = [];
  const closed = new Set();
  const shut = async (x) => {
    if (x && !closed.has(x)) {
      closed.add(x);
      await x.close().catch(() => {});
    }
  };

  // the initiator creates the gallery and keeps it open (it's the archivist for its own wave)
  const baseA = new Autobase(storeA.namespace('wave-gallery:' + WAVE), null, galleryConfig());
  await baseA.ready();
  const key = baseA.key;
  let baseC = null;

  t.teardown(async () => {
    for (const s of streams) {
      try {
        s.destroy();
      } catch {}
    }
    await shut(baseA);
    await shut(baseC);
    await shut(storeA);
    await shut(storeC);
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  await baseA.append(selfie(crypto.keyPair(), 0, 'A'));

  // a latecomer shows up AFTER the post and connects only to the retained initiator
  baseC = new Autobase(storeC.namespace('wave-gallery:' + WAVE), key, galleryConfig());
  await baseC.ready();
  streams.push(...link(storeA, storeC));

  t.ok(
    await until(async () => (await captions(baseC)).length === 1),
    'latecomer got the gallery from the initiator that retained it'
  );
  t.alike(await captions(baseC), ['A'], 'the initiator served its retained gallery');
});
