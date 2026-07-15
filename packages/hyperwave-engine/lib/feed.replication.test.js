// Transitive feed replication over a PARTIAL mesh (line topology), no swarm,
// for the multicore CRDT feed (protocol.md §8). Peers are wired
// A<->B and B<->C but NOT A<->C, so A and C are never directly connected. We assert the
// per-participant cores replicate *transitively*: C converges to A's entry purely by
// forwarding through B, and A likewise receives C's — Corestore serves any core it
// replicates, so the middle peer relays blocks it merely holds. Also proves feed
// persistence: a peer that stays online serves the full feed to a latecomer.
// Runs under Bare:  bare lib/feed.replication.test.js   (or `npm test`)
const test = require('brittle');
const fs = require('bare-fs');
const Corestore = require('corestore');
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const { CrdtFeed } = require('./feed-crdt');
const { signJoin } = require('./attest');

const WAVE = 'w';

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
      if (ok || Date.now() - started > timeoutMs) {
        resolve(ok);
        return;
      }
      setTimeout(tick, 120);
    };
    tick();
  });
}

// One CRDT feed peer: its own store + keypair + session, tracking the latest
// merged view (what wave.js's onFeed would push to the renderer).
function makePeer(dir) {
  const peer = {
    dir,
    store: new Corestore(dir),
    keyPair: crypto.keyPair(),
    joinSig: null,
    view: []
  };
  peer.id = b4a.toString(peer.keyPair.publicKey, 'hex');
  peer.session = new CrdtFeed({
    store: peer.store,
    me: { id: peer.id, tag: null },
    onFeed: (items) => {
      peer.view = items;
    },
    walletAddress: () => null,
    burnProof: () => null,
    joinProof: () => peer.joinSig,
    log: () => {}
  });
  return peer;
}

// open the peer's own core for WAVE and sign its join credential over the writer key
// (what floodMyFeedCore does in wave.js)
async function openAndSign(peer) {
  peer.writerKey = await peer.session.open(WAVE);
  peer.joinSig = signJoin(peer.keyPair, {
    waveId: WAVE,
    writerKey: peer.writerKey
  });
}

// every peer ingests every other peer's credential (what the flooded wave-joins do)
function shareWriters(peers) {
  for (const peer of peers) {
    for (const other of peers) {
      if (other !== peer) {
        peer.session.addWriter(WAVE, other.id, other.writerKey);
      }
    }
  }
}

// each entry's opaque payload is just its label ('A'/'B'/'C') in this fixture
function labels(peer) {
  peer.session.tick();
  return peer.view.map((entry) => entry.payload).sort();
}

test('feed replicates transitively across a line A—B—C (no A<->C link)', async (t) => {
  const dirs = ['a', 'b', 'c'].map(
    (name) => `/tmp/hyperwave-repl-${name}-${Date.now()}`
  );
  const peers = dirs.map(makePeer);
  const [peerA, peerB, peerC] = peers;

  // LINE topology: A<->B and B<->C only. B is the sole bridge between A and C.
  const streams = [
    ...link(peerA.store, peerB.store),
    ...link(peerB.store, peerC.store)
  ];

  t.teardown(async () => {
    for (const stream of streams) {
      stream.destroy();
    }
    for (const peer of peers) {
      await peer.session.close();
      await peer.store.close().catch(() => {});
      fs.rmSync(peer.dir, { recursive: true, force: true });
    }
  });

  for (const peer of peers) {
    await openAndSign(peer);
  }
  // credentials reach everyone via the flooded wave-joins (control plane, simulated
  // directly — this test is about the *data* plane)
  shareWriters(peers);

  // each peer posts one entry to its OWN core (no admission, no writable-wait)
  await peerA.session.postEntry({ waveId: WAVE, hopCount: 0, payload: 'A' });
  await peerB.session.postEntry({ waveId: WAVE, hopCount: 1, payload: 'B' });
  await peerC.session.postEntry({ waveId: WAVE, hopCount: 2, payload: 'C' });

  // C must converge to all three — crucially A's, whose blocks reach C only by
  // forwarding through B (A and C share no direct connection).
  t.ok(await until(() => labels(peerC).length === 3), 'C converged to all 3');
  t.alike(
    labels(peerC),
    ['A', 'B', 'C'],
    'C has A (transitive via B), B (direct), C (own)'
  );

  // …and A receives C's entry, which likewise only reaches A through B.
  t.ok(await until(() => labels(peerA).length === 3), 'A converged to all 3');
  t.alike(labels(peerA), ['A', 'B', 'C'], 'A has C (transitive via B)');
});

// Persistence: any peer that stays online can serve the whole feed — with the CRDT
// every participant holds every participant's core, so there is no designated archivist.
// A peer posts and STAYS ONLINE; a latecomer connects to it afterwards (learning the
// credentials from a wave-sync, simulated directly) and converges to the full feed.
test('a peer that stays online serves the feed to a latecomer', async (t) => {
  const dirs = ['orig', 'late'].map(
    (name) => `/tmp/hyperwave-retain-${name}-${Date.now()}`
  );
  const [origin, latecomer] = dirs.map(makePeer);
  const streams = [];

  t.teardown(async () => {
    for (const stream of streams) {
      stream.destroy();
    }
    for (const peer of [origin, latecomer]) {
      await peer.session.close();
      await peer.store.close().catch(() => {});
      fs.rmSync(peer.dir, { recursive: true, force: true });
    }
  });

  await openAndSign(origin);
  await origin.session.postEntry({ waveId: WAVE, hopCount: 0, payload: 'A' });

  // the latecomer shows up AFTER the post and connects only to the online peer
  await openAndSign(latecomer);
  latecomer.session.addWriter(WAVE, origin.id, origin.writerKey);
  streams.push(...link(origin.store, latecomer.store));

  t.ok(
    await until(() => labels(latecomer).length === 1),
    'latecomer converged from the online peer'
  );
  t.alike(labels(latecomer), ['A'], 'the held feed was served');
});
