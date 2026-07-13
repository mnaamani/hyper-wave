// Gallery replication A/B benchmark — the instrument for the CRDT-gallery decision
// (TODO "Gallery-as-CRDT"). It runs the CURRENT single-indexer Autobase gallery and a
// prototype multicore CRDT gallery over the SAME synthetic partial mesh, asserts BOTH
// converge fully (the regression guard), and reports convergence time for each (the
// measurement). Running both over one identical graph is why this is a controlled
// in-process harness (real Corestore/Autobase/Hypercore, explicit replicate-streams —
// the technique gallery.replication.test.js uses) rather than real Hyperswarm: a live
// swarm would hand the two strategies DIFFERENT random meshes and confound the compare.
//
// WHAT IT MEASURES (faithfully): reach — does every node converge to all N *entries*
// (block data, not just the log length — Path B must actively download() each core; a
// length-only check is over-optimistic) — and the STRUCTURE of convergence: Path A
// funnels every op through one indexer (create → admit → each writer replicates the
// indexer's output); Path B spreads N independent cores epidemically, no indexer, no
// admission, no consensus. WHAT IT DOESN'T measure: real WAN latency (streams are
// in-process pipes) — the real-swarm variant (HYPERWAVE_MAX_PEERS-limited e2e) is the
// absolute-latency complement.
//
// Measured N=64, degree=16 (identical mesh, both paths): A 64/64 in ~18.4s (incl. ~1s
// admission), B 64/64 in ~13.3s — B converges fully AND ~28% faster, with no SPOF.
//
// Defaults are CI-safe (small N; asserts correctness only, not timing — timing is noisy).
// The real experiment runs bigger; BENCH_DEGREE models Hyperswarm's maxPeers (per-node
// connection cap):
//   BENCH_N=64 BENCH_DEGREE=16 bare lib/gallery.replication.bench.test.js
const test = require('brittle');
const fs = require('bare-fs');
const env = require('bare-env');
const Corestore = require('corestore');
const Autobase = require('autobase');
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const { galleryConfig, readGallery, buildGallery } = require('./gallery');
const { signJoin, verifyJoin } = require('./attest');

const WAVE = 'bench';
const N = Number(env.BENCH_N || 10);
const DEGREE = Number(env.BENCH_DEGREE || 4); // per-node connection cap (models maxPeers)
const CONVERGE_TIMEOUT_MS = 120000;

/**
 * Bare/brittle keep-alive: RocksDB storage I/O doesn't ref the libuv loop, so during a
 * quiet await the loop can drain and brittle mis-fires a "did not end" deadlock. A
 * self-rescheduling timer keeps one handle pending until teardown. (A test-harness
 * detail, not production behaviour.)
 * @param {Object} t The brittle test handle.
 */
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

/** Poll `pred` until true or timeout; returns ms elapsed, or -1 on timeout. */
async function timeUntil(pred, timeoutMs = CONVERGE_TIMEOUT_MS) {
  const started = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = await pred();
    } catch {}
    if (ok) {
      return Date.now() - started;
    }
    if (Date.now() - started > timeoutMs) {
      return -1;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

/** Wire two corestores with one replication stream pair (one undirected mesh edge). */
function link(store1, store2) {
  const stream1 = store1.replicate(true);
  const stream2 = store2.replicate(false);
  stream1.pipe(stream2).pipe(stream1);
  stream1.on('error', () => {});
  stream2.on('error', () => {});
  return [stream1, stream2];
}

/**
 * A CONNECTED random partial mesh over `n` nodes with per-node degree capped at `degree`.
 * A random Hamiltonian cycle guarantees connectivity (so the A/B isn't decided by a split
 * neither strategy can cross); random extra edges up to the cap add realism.
 * @param {number} n Node count.
 * @param {number} degree Per-node degree cap (models maxPeers).
 * @returns {Array<[number, number]>} Undirected edges as index pairs.
 */
function partialMesh(n, degree) {
  const order = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const deg = new Array(n).fill(0);
  const has = new Set();
  const edges = [];
  const addEdge = (a, b) => {
    const key = a < b ? a + ':' + b : b + ':' + a;
    if (a === b || has.has(key) || deg[a] >= degree || deg[b] >= degree) {
      return;
    }
    has.add(key);
    edges.push([a, b]);
    deg[a]++;
    deg[b]++;
  };
  for (let i = 0; i < n; i++) {
    addEdge(order[i], order[(i + 1) % n]); // the cycle: connectivity floor
  }
  const targetEdges = Math.floor((n * degree) / 2);
  let attempts = 0;
  while (edges.length < targetEdges && attempts < n * degree * 4) {
    attempts++;
    addEdge(Math.floor(Math.random() * n), Math.floor(Math.random() * n));
  }
  return edges;
}

/** A join-attested wave-selfie op posted by keyPair from writer core `writerKey`. */
function selfieOp(keyPair, writerKey, rank) {
  return {
    type: 'wave-selfie',
    waveId: WAVE,
    peerId: b4a.toString(keyPair.publicKey, 'hex'),
    hopCount: rank,
    writerKey,
    joinSig: signJoin(keyPair, { waveId: WAVE, writerKey }),
    caption: 'c' + rank,
    timestamp: rank
  };
}

/** Valid, converged entry count a node holds (mirrors the gallery write-gate + dedup). */
function mergedCount(entries) {
  const valid = entries.filter(
    (op) =>
      op &&
      op.type === 'wave-selfie' &&
      verifyJoin(
        { waveId: op.waveId, peerId: op.peerId, writerKey: op.writerKey },
        op.joinSig
      )
  );
  return buildGallery(valid).length;
}

function makeStores(tag) {
  const dirs = [];
  const stores = [];
  for (let i = 0; i < N; i++) {
    const rand = Math.floor(Math.random() * 1e6);
    const dir = `/tmp/hw-bench-${tag}-${Date.now()}-${i}-${rand}`;
    dirs.push(dir);
    stores.push(new Corestore(dir));
  }
  return { dirs, stores };
}

async function cleanup(streams, closables, dirs) {
  for (const stream of streams) {
    stream.destroy();
  }
  await Promise.all(closables.map((item) => item.close().catch(() => {})));
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- Path A: the current single-indexer Autobase gallery ---------------------
async function benchAutobase(edges, keyPairs) {
  const { dirs, stores } = makeStores('ab');
  const base0 = new Autobase(stores[0].namespace(WAVE), null, galleryConfig());
  await base0.ready();
  const bases = [base0];
  for (let i = 1; i < N; i++) {
    const base = new Autobase(
      stores[i].namespace(WAVE),
      base0.key,
      galleryConfig()
    );
    await base.ready();
    bases.push(base);
  }
  const streams = [];
  for (const [u, v] of edges) {
    streams.push(...link(stores[u], stores[v]));
  }
  const start = Date.now();
  // admission: the sole indexer (node 0) batch-appends add-writer for every joiner
  const addWriters = [];
  for (let i = 1; i < N; i++) {
    addWriters.push({
      type: 'add-writer',
      key: b4a.toString(bases[i].local.key, 'hex')
    });
  }
  await base0.append(addWriters);
  // wait for every joiner to become writable (admission replicated back through the mesh)
  const writableMs = await timeUntil(async () => {
    for (const base of bases) {
      await base.update().catch(() => {});
      if (!base.writable) {
        return false;
      }
    }
    return true;
  });
  for (let i = 0; i < N; i++) {
    await bases[i].append(
      selfieOp(keyPairs[i], b4a.toString(bases[i].local.key, 'hex'), i)
    );
  }
  const convergeMs = await timeUntil(async () => {
    for (const base of bases) {
      await base.update().catch(() => {});
      if ((await readGallery(base)).length < N) {
        return false;
      }
    }
    return true;
  });
  let reached = 0;
  for (const base of bases) {
    if ((await readGallery(base)).length === N) {
      reached++;
    }
  }
  const totalMs = writableMs < 0 || convergeMs < 0 ? -1 : Date.now() - start;
  await cleanup(streams, [...bases, ...stores], dirs);
  return { reached, writableMs, totalMs };
}

// --- Path B: prototype multicore CRDT gallery (one core per participant) ------
async function benchMulticore(edges, keyPairs) {
  const { dirs, stores } = makeStores('mc');
  const mine = stores.map((store) =>
    store.get({ name: 'gallery', valueEncoding: 'json' })
  );
  await Promise.all(mine.map((core) => core.ready()));
  const keys = mine.map((core) => core.key);
  // every node opens (get) every core by key, so it WANTS + relays all of them
  const views = stores.map((store, i) =>
    keys.map((key, j) =>
      i === j ? mine[i] : store.get({ key, valueEncoding: 'json' })
    )
  );
  await Promise.all(views.flat().map((core) => core.ready()));
  // actively download every gallery core — length propagates without this, but the block
  // DATA only arrives when a node requests it (the real design must drive this)
  for (const row of views) {
    for (const core of row) {
      core.download({ start: 0, end: -1 });
    }
  }
  const streams = [];
  for (const [u, v] of edges) {
    streams.push(...link(stores[u], stores[v]));
  }
  const start = Date.now();
  // every peer posts its one selfie to its OWN core — no admission, no indexer
  for (let i = 0; i < N; i++) {
    await mine[i].append(
      selfieOp(keyPairs[i], b4a.toString(mine[i].key, 'hex'), i)
    );
  }
  const convergeMs = await timeUntil(async () => {
    for (let i = 0; i < N; i++) {
      let downloaded = 0;
      for (const core of views[i]) {
        await core.update().catch(() => {});
        if (core.has(0)) {
          downloaded++;
        }
      }
      if (downloaded < N) {
        return false;
      }
    }
    return true;
  });
  let reached = 0;
  for (let i = 0; i < N; i++) {
    const entries = [];
    for (const core of views[i]) {
      if (core.has(0)) {
        entries.push(await core.get(0));
      }
    }
    if (mergedCount(entries) === N) {
      reached++;
    }
  }
  const totalMs = convergeMs < 0 ? -1 : Date.now() - start;
  await cleanup(streams, [...views.flat(), ...stores], dirs);
  return { reached, totalMs };
}

test(`gallery replication A/B over a partial mesh (N=${N}, degree=${DEGREE})`, async (t) => {
  keepAlive(t);
  const edges = partialMesh(N, DEGREE);
  const avgDegree = ((2 * edges.length) / N).toFixed(1);
  const keyPairs = [...Array(N)].map(() => crypto.keyPair());

  const resultA = await benchAutobase(edges, keyPairs);
  const resultB = await benchMulticore(edges, keyPairs);

  console.log(
    `\n  mesh: N=${N} avg-degree=${avgDegree} edges=${edges.length}` +
      `\n  A single-indexer Autobase: reach ${resultA.reached}/${N}` +
      ` total ${resultA.totalMs}ms (admission/writable ${resultA.writableMs}ms)` +
      `\n  B multicore CRDT:          reach ${resultB.reached}/${N}` +
      ` total ${resultB.totalMs}ms\n`
  );

  // Correctness (the regression guard) — both strategies must fully converge over a
  // genuine partial mesh. Timing is reported above but NOT asserted (in-process, noisy).
  t.is(resultA.reached, N, 'A: every node converges to all N entries');
  t.is(resultB.reached, N, 'B: every node converges to all N entries');
});
