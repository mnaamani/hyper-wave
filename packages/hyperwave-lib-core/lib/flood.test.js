// Partial-topology harness for gossip flooding (protocol.md §3.1). Hyperswarm
// full-meshes small swarms, so we can't force a partial mesh through the real
// transport — instead we drive the *real* per-node flood decision (createFlood) over
// synthetic graphs (line, ring, star, random partial mesh, disconnected) and assert:
//   1. reach — every node in the origin's connected component processes the message;
//   2. dedup — each node processes exactly once, even with many redundant copies;
//   3. bounded cost — total sends ≤ 2·|E| (no exponential blow-up / loops);
//   4. latency — rounds ≈ graph diameter (a few hops on a well-connected mesh).
// Runs under Bare:  bare workers/lib/flood.test.js   (or `npm test`)
const test = require('brittle');
const { createFlood } = require('./flood');

// --- flood simulation over an undirected graph ------------------------------
// `adj` is Map<id, id[]> (symmetric). The origin stamps one message id and sends to
// its neighbours; each node, on FIRST sight (the exact createFlood rule wave.js uses),
// relays to its other neighbours. Returns reach/dedup/cost/latency stats.
function simulateFlood(adj, origin, opts = {}) {
  const mid = 'm';
  const flood = new Map();
  for (const id of adj.keys()) flood.set(id, createFlood(opts));
  const receipts = new Map(); // id -> raw copies received (before dedup)
  const processed = new Set(); // nodes that accepted + relayed it (firstSight true)
  let sends = 0;
  let rounds = 0;

  flood.get(origin).firstSight(mid); // origin marks its own id so relays can't loop back
  processed.add(origin);
  let frontier = adj.get(origin).map((to) => ({ to, from: origin }));
  sends += frontier.length;

  while (frontier.length) {
    rounds++;
    const next = [];
    for (const { to, from } of frontier) {
      receipts.set(to, (receipts.get(to) || 0) + 1);
      if (flood.get(to).firstSight(mid)) {
        processed.add(to);
        for (const nb of adj.get(to)) {
          if (nb === from) continue; // don't echo straight back to the sender
          next.push({ to: nb, from: to });
          sends++;
        }
      }
    }
    frontier = next;
  }
  return { processed, receipts, sends, rounds };
}

// --- graph builders (symmetric adjacency) -----------------------------------
function emptyGraph(ids) {
  const g = new Map();
  for (const id of ids) g.set(id, []);
  return g;
}
function link(g, a, b) {
  g.get(a).push(b);
  g.get(b).push(a);
}
function ids(n) {
  return [...Array(n)].map((_, i) => 'n' + i);
}
function edgeCount(g) {
  let d = 0;
  for (const nbrs of g.values()) d += nbrs.length;
  return d / 2;
}
function lineGraph(n) {
  const id = ids(n);
  const g = emptyGraph(id);
  for (let i = 0; i + 1 < n; i++) link(g, id[i], id[i + 1]);
  return { g, id };
}
function ringGraph(n) {
  const id = ids(n);
  const g = emptyGraph(id);
  for (let i = 0; i < n; i++) link(g, id[i], id[(i + 1) % n]);
  return { g, id };
}
function starGraph(n) {
  const id = ids(n);
  const g = emptyGraph(id);
  for (let i = 1; i < n; i++) link(g, id[0], id[i]);
  return { g, id };
}
// deterministic PRNG (mulberry32) so the random mesh is reproducible
function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// connected random partial mesh: a random spanning tree (guarantees connectivity) plus
// `extra` random chords. Models the real Hyperswarm-past-mesh-limit topology.
function randomMesh(n, extra, seed) {
  const id = ids(n);
  const g = emptyGraph(id);
  const rng = rngFrom(seed);
  for (let i = 1; i < n; i++) link(g, id[i], id[Math.floor(rng() * i)]);
  for (let e = 0; e < extra; e++) {
    const a = Math.floor(rng() * n);
    const b = Math.floor(rng() * n);
    if (a !== b && !g.get(id[a]).includes(id[b])) link(g, id[a], id[b]);
  }
  return { g, id };
}

// --- tests ------------------------------------------------------------------

test('line: reaches every node; rounds = diameter (N-1)', (t) => {
  const { g } = lineGraph(10);
  const r = simulateFlood(g, 'n0');
  t.is(r.processed.size, 10, 'all 10 reached across a chain (worst-case topology)');
  t.is(r.rounds, 9, 'N-1 relay hops end to end');
  t.ok(r.sends <= 2 * edgeCount(g), 'sends bounded by 2·|E|');
});

test('ring: reaches every node from both directions, deduped', (t) => {
  const { g } = ringGraph(12);
  const r = simulateFlood(g, 'n0');
  t.is(r.processed.size, 12, 'all reached');
  t.ok(r.rounds <= 7, 'two half-laps meet in the middle (~N/2)');
  // the two directions collide, so at least one node gets a redundant copy it dedups
  const redundant = [...r.receipts.values()].filter((c) => c > 1).length;
  t.ok(redundant > 0, 'dedup actually suppressed a re-process');
  t.ok(r.sends <= 2 * edgeCount(g), 'sends bounded by 2·|E|');
});

test('star: one relay round from the hub reaches all leaves', (t) => {
  const { g } = starGraph(20);
  const r = simulateFlood(g, 'n0');
  t.is(r.processed.size, 20);
  t.is(r.rounds, 1, 'hub → all leaves in a single hop');
});

test('random partial mesh (N=200): full reach, small diameter, bounded cost', (t) => {
  const { g } = randomMesh(200, 400, 1234); // avg degree ~ (199 + 400·2)/200 ≈ 5
  const r = simulateFlood(g, 'n0');
  t.is(r.processed.size, 200, 'every seat reached across the partial mesh');
  t.ok(r.rounds <= 20, `low diameter (${r.rounds} rounds) — ~hundreds of ms in practice`);
  t.ok(r.sends <= 2 * edgeCount(g), 'each edge traversed at most once per direction');
});

test('low-degree origin still floods the whole mesh', (t) => {
  // origin wired to just one peer — relay must carry it the rest of the way
  const { g } = randomMesh(120, 240, 77);
  // force n0 down to a single edge
  const only = g.get('n0')[0];
  for (const nb of g.get('n0')) {
    if (nb !== only) {
      g.set(
        nb,
        g.get(nb).filter((x) => x !== 'n0')
      );
    }
  }
  g.set('n0', [only]);
  const r = simulateFlood(g, 'n0');
  t.is(r.processed.size, 120, 'reach does not depend on the origin being well-connected');
});

test('disconnected graph: flood stays inside the origin component', (t) => {
  // two separate 5-node lines, no edge between them
  const a = lineGraph(5).g; // n0..n4
  const b = lineGraph(5); // relabel to m0..m4
  const g = new Map(a);
  const relabel = new Map();
  for (const k of b.g.keys()) relabel.set(k, 'm' + k.slice(1));
  for (const [k, nbrs] of b.g) {
    g.set(
      relabel.get(k),
      nbrs.map((x) => relabel.get(x))
    );
  }
  const r = simulateFlood(g, 'n0');
  t.is(r.processed.size, 5, 'only the origin component (n0..n4) is reached');
  t.absent(
    r.processed.has('m0'),
    'the isolated component gets nothing — reach is real, not assumed'
  );
});
