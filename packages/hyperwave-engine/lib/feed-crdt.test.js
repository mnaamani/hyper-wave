// CrdtFeed (feed-crdt.js) + the pure mergeFeed gate: the multicore CRDT feed
// that replaces the single-indexer Autobase. Tests (1) the pure merge's write-gate +
// tip-address binding + one-per-peer, and (2) real convergence — PEERS sessions, each with
// its own core, wired over a mesh, every peer learning every core (as the flooded
// wave-joins would), all merging to the identical feed. Uses real Corestore/Hypercore
// on disk, no swarm. Runs under Bare:  bare lib/feed-crdt.test.js  (or `npm test`)
const test = require('brittle');
const fs = require('bare-fs');
const Corestore = require('corestore');
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const { mergeFeed } = require('./feed');
const { CrdtFeed } = require('./feed-crdt');
const { signJoin, signBurn } = require('./attest');

const WAVE = 'w';

// The opaque payload doubles as the entry's discriminator in these fixtures ('c<hop>').
function entry(keyPair, hopCount, extra = {}) {
  const writerKey = b4a.toString(crypto.keyPair().publicKey, 'hex');
  const peerId = b4a.toString(keyPair.publicKey, 'hex');
  return {
    type: 'wave-entry',
    waveId: WAVE,
    peerId,
    hopCount,
    writerKey,
    joinSig: signJoin(keyPair, { waveId: WAVE, writerKey }),
    payload: 'c' + hopCount,
    timestamp: hopCount,
    ...extra
  };
}

// --- the pure merge gate -----------------------------------------------------
test('mergeFeed keeps join-attested ops, hop-ordered; drops the rest', (t) => {
  const p1 = crypto.keyPair();
  const p2 = crypto.keyPair();
  const forged = entry(crypto.keyPair(), 3);
  forged.joinSig = forged.joinSig.replace(/^../, '00');
  const oversized = entry(crypto.keyPair(), 4);
  oversized.payload = 'x'.repeat(256 * 1024 + 1);
  const merged = mergeFeed([entry(p2, 1), entry(p1, 0), forged, oversized]);
  t.alike(
    merged.map((entry) => entry.payload),
    ['c0', 'c1'],
    'valid ops kept in hop order; forged + oversized dropped'
  );
});

test('mergeFeed keeps a tip address only if a matching burn backs it', (t) => {
  const paid = crypto.keyPair();
  const paidId = b4a.toString(paid.publicKey, 'hex');
  const burnFields = {
    waveId: WAVE,
    peerId: paidId,
    reason: 'join',
    amount: 1,
    txHash: 'deadbeef',
    tronAddress: 'TPaid',
    burnTs: 1000
  };
  const backed = entry(paid, 0, {
    address: 'TPaid',
    burn: { ...burnFields, sig: signBurn(paid, burnFields) }
  });
  const unbacked = entry(crypto.keyPair(), 1, { address: 'TSpoof' });
  const merged = mergeFeed([backed, unbacked]);
  const byPayload = Object.fromEntries(
    merged.map((entry) => [entry.payload, entry])
  );
  t.is(byPayload.c0.address, 'TPaid', 'burn-backed address kept');
  t.is(byPayload.c0.burnTx, 'deadbeef', 'burnTx kept for auditors');
  t.absent('burn' in byPayload.c0, 'the bulky burn is dropped');
  t.is(byPayload.c1.address, '', 'unbacked address stripped');
});

test('mergeFeed keeps one entry per peer (newest wins)', (t) => {
  const peer = crypto.keyPair();
  const first = entry(peer, 0, { payload: 'first', timestamp: 100 });
  const second = { ...first, payload: 'second', timestamp: 200 };
  const merged = mergeFeed([first, second]);
  t.is(merged.length, 1, 'one entry per peer');
  t.is(merged[0].payload, 'second', 'newest wins');
});

// --- the real class: convergence over a mesh ---------------------------------
function keepAlive(t) {
  let alive = true;
  const tick = () => {
    if (alive) {
      setTimeout(tick, 500);
    }
  };
  tick();
  t.teardown(() => {
    alive = false;
  });
}

function link(store1, store2) {
  const stream1 = store1.replicate(true);
  const stream2 = store2.replicate(false);
  stream1.pipe(stream2).pipe(stream1);
  stream1.on('error', () => {});
  stream2.on('error', () => {});
  return [stream1, stream2];
}

function until(pred, timeoutMs = 30000) {
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
      setTimeout(tick, 60);
    };
    tick();
  });
}

test('CrdtFeed: PEERS peers each with their own core converge to one feed', async (t) => {
  keepAlive(t);
  const PEERS = 6;
  const dirs = [];
  const stores = [];
  const keyPairs = [];
  const holders = []; // per-peer { joinSig } (set after open — the wave-join credential)
  const views = []; // per-peer latest onFeed output
  const sessions = [];
  for (let i = 0; i < PEERS; i++) {
    const dir = `/tmp/hw-crdt-${Date.now()}-${i}-${Math.floor(Math.random() * 1e6)}`;
    dirs.push(dir);
    stores.push(new Corestore(dir));
    keyPairs.push(crypto.keyPair());
    holders.push({ joinSig: null });
    views.push([]);
  }
  t.teardown(async () => {
    for (const session of sessions) {
      await session.close();
    }
    for (const store of stores) {
      await store.close().catch(() => {});
    }
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  for (let i = 0; i < PEERS; i++) {
    sessions.push(
      new CrdtFeed({
        store: stores[i],
        me: { id: b4a.toString(keyPairs[i].publicKey, 'hex'), tag: 'BR' },
        onFeed: (_waveId, items) => {
          views[i] = items;
        },
        walletAddress: () => null,
        burnProof: () => null,
        joinProof: () => holders[i].joinSig,
        log: () => {}
      })
    );
  }

  // each peer opens its own core → its writer key
  const writerKeys = [];
  for (let i = 0; i < PEERS; i++) {
    writerKeys.push(await sessions[i].open(WAVE));
    holders[i].joinSig = signJoin(keyPairs[i], {
      waveId: WAVE,
      writerKey: writerKeys[i]
    });
  }

  // full mesh (small PEERS) — the flooded wave-joins reach everyone: every peer learns
  // every OTHER peer's core key
  const streams = [];
  for (let a = 0; a < PEERS; a++) {
    for (let b = a + 1; b < PEERS; b++) {
      streams.push(...link(stores[a], stores[b]));
    }
  }
  t.teardown(() => {
    for (const stream of streams) {
      stream.destroy();
    }
  });
  for (let i = 0; i < PEERS; i++) {
    for (let j = 0; j < PEERS; j++) {
      if (i !== j) {
        sessions[i].addWriter(
          WAVE,
          b4a.toString(keyPairs[j].publicKey, 'hex'),
          writerKeys[j]
        );
      }
    }
  }

  // everyone posts their one entry (no admission, no writable-wait)
  for (let i = 0; i < PEERS; i++) {
    await sessions[i].postEntry({
      waveId: WAVE,
      hopCount: i,
      payload: { label: 'peer' + i }
    });
  }

  const converged = await until(() => {
    for (const session of sessions) {
      session.tick();
    }
    return views.every((view) => view.length === PEERS);
  });
  t.ok(converged, 'every peer converged to all PEERS entries');
  t.alike(
    views[0].map((entry) => entry.payload.label).sort(),
    [...Array(PEERS)].map((_, i) => 'peer' + i).sort(),
    'the merged feed holds every peer’s entry'
  );
});

test('CrdtFeed: writerKey is null before open, set after', async (t) => {
  const dir = `/tmp/hw-crdt-wk-${Date.now()}`;
  const store = new Corestore(dir);
  const keyPair = crypto.keyPair();
  const session = new CrdtFeed({
    store,
    me: { id: b4a.toString(keyPair.publicKey, 'hex'), tag: null },
    onFeed: () => {},
    walletAddress: () => null,
    burnProof: () => null,
    joinProof: () => null,
    log: () => {}
  });
  t.teardown(async () => {
    await session.close();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  t.is(session.writerKeyFor(WAVE), null, 'no writer key before open');
  const key = await session.open(WAVE);
  t.is(session.writerKeyFor(WAVE), key, 'writer key available after open');
  t.is(key.length, 64, 'a 32-byte core key in hex');
});

// Concurrent waves (scaling.md Phase 1): opening a second wave must NOT close the first, and
// each wave's feed must emit tagged with its own waveId — the two never bleed into each other.
test('CrdtFeed: concurrent waves stay independent (open one never closes another)', async (t) => {
  const dir = `/tmp/hw-crdt-multi-${Date.now()}`;
  const store = new Corestore(dir);
  const keyPair = crypto.keyPair();
  const feeds = new Map(); // waveId -> latest items
  const session = new CrdtFeed({
    store,
    me: { id: b4a.toString(keyPair.publicKey, 'hex'), tag: null },
    onFeed: (waveId, items) => {
      feeds.set(waveId, items);
    },
    walletAddress: () => null,
    burnProof: () => null,
    joinProof: (waveId) =>
      signJoin(keyPair, { waveId, writerKey: session.writerKeyFor(waveId) }),
    log: () => {}
  });
  t.teardown(async () => {
    await session.close();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const keyA = await session.open('wave-A');
  const keyB = await session.open('wave-B'); // opening B must not close A
  t.ok(keyA && keyB && keyA !== keyB, 'each wave gets its own writer core');
  t.is(
    session.writerKeyFor('wave-A'),
    keyA,
    'wave-A core still open after B opened'
  );

  await session.postEntry({ waveId: 'wave-A', hopCount: 0, payload: 'a' });
  await session.postEntry({ waveId: 'wave-B', hopCount: 0, payload: 'b' });

  t.alike(
    feeds.get('wave-A').map((entry) => entry.payload),
    ['a'],
    'wave-A feed holds only its own entry'
  );
  t.alike(
    feeds.get('wave-B').map((entry) => entry.payload),
    ['b'],
    'wave-B feed holds only its own entry'
  );

  // closing one wave leaves the other intact
  await session.closeWave('wave-A');
  t.is(session.writerKeyFor('wave-A'), null, 'wave-A closed');
  t.is(
    session.writerKeyFor('wave-B'),
    keyB,
    'wave-B untouched by closing wave-A'
  );
});
