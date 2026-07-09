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
// `adj` is Map<id, ids[]> (symmetric). The origin stamps one message id and sends to
// its neighbours; each node, on FIRST sight (the exact createFlood rule wave.js uses),
// relays to its other neighbours. Returns reach/dedup/cost/latency stats.
function simulateFlood(adj, origin, opts = {}) {
  const mid = 'm';
  const flood = new Map();
  for (const id of adj.keys()) {
    flood.set(id, createFlood(opts));
  }
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
        for (const neighbour of adj.get(to)) {
          if (neighbour === from) {
            continue; // don't echo straight back to the sender
          }
          next.push({ to: neighbour, from: to });
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
  const graph = new Map();
  for (const id of ids) {
    graph.set(id, []);
  }
  return graph;
}
function link(graph, nodeA, nodeB) {
  graph.get(nodeA).push(nodeB);
  graph.get(nodeB).push(nodeA);
}
function makeIds(n) {
  return [...Array(n)].map((_, i) => 'n' + i);
}
function edgeCount(graph) {
  let degreeSum = 0;
  for (const nbrs of graph.values()) {
    degreeSum += nbrs.length;
  }
  return degreeSum / 2;
}
function lineGraph(n) {
  const ids = makeIds(n);
  const graph = emptyGraph(ids);
  for (let i = 0; i + 1 < n; i++) {
    link(graph, ids[i], ids[i + 1]);
  }
  return { graph, ids };
}
function ringGraph(n) {
  const ids = makeIds(n);
  const graph = emptyGraph(ids);
  for (let i = 0; i < n; i++) {
    link(graph, ids[i], ids[(i + 1) % n]);
  }
  return { graph, ids };
}
function starGraph(n) {
  const ids = makeIds(n);
  const graph = emptyGraph(ids);
  for (let i = 1; i < n; i++) {
    link(graph, ids[0], ids[i]);
  }
  return { graph, ids };
}
// deterministic PRNG (mulberry32) so the random mesh is reproducible
function rngFrom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
// connected random partial mesh: a random spanning tree (guarantees connectivity) plus
// `extra` random chords. Models the real Hyperswarm-past-mesh-limit topology.
function randomMesh(n, extra, seed) {
  const ids = makeIds(n);
  const graph = emptyGraph(ids);
  const rng = rngFrom(seed);
  for (let i = 1; i < n; i++) {
    link(graph, ids[i], ids[Math.floor(rng() * i)]);
  }
  for (let i = 0; i < extra; i++) {
    const idxA = Math.floor(rng() * n);
    const idxB = Math.floor(rng() * n);
    if (idxA !== idxB && !graph.get(ids[idxA]).includes(ids[idxB])) {
      link(graph, ids[idxA], ids[idxB]);
    }
  }
  return { graph, ids };
}

// --- tests ------------------------------------------------------------------

test('line: reaches every node; rounds = diameter (N-1)', (t) => {
  const { graph } = lineGraph(10);
  const stats = simulateFlood(graph, 'n0');
  t.is(stats.processed.size, 10, 'all 10 reached across a chain (worst-case topology)');
  t.is(stats.rounds, 9, 'N-1 relay hops end to end');
  t.ok(stats.sends <= 2 * edgeCount(graph), 'sends bounded by 2·|E|');
});

test('ring: reaches every node from both directions, deduped', (t) => {
  const { graph } = ringGraph(12);
  const stats = simulateFlood(graph, 'n0');
  t.is(stats.processed.size, 12, 'all reached');
  t.ok(stats.rounds <= 7, 'two half-laps meet in the middle (~N/2)');
  // the two directions collide, so at least one node gets a redundant copy it dedups
  const redundant = [...stats.receipts.values()].filter((count) => count > 1).length;
  t.ok(redundant > 0, 'dedup actually suppressed a re-process');
  t.ok(stats.sends <= 2 * edgeCount(graph), 'sends bounded by 2·|E|');
});

test('star: one relay round from the hub reaches all leaves', (t) => {
  const { graph } = starGraph(20);
  const stats = simulateFlood(graph, 'n0');
  t.is(stats.processed.size, 20);
  t.is(stats.rounds, 1, 'hub → all leaves in a single hop');
});

test('random partial mesh (N=200): full reach, small diameter, bounded cost', (t) => {
  const { graph } = randomMesh(200, 400, 1234); // avg degree ~ (199 + 400·2)/200 ≈ 5
  const stats = simulateFlood(graph, 'n0');
  t.is(stats.processed.size, 200, 'every seat reached across the partial mesh');
  t.ok(stats.rounds <= 20, `low diameter (${stats.rounds} rounds) — ~hundreds of ms in practice`);
  t.ok(stats.sends <= 2 * edgeCount(graph), 'each edge traversed at most once per direction');
});

test('low-degree origin still floods the whole mesh', (t) => {
  // origin wired to just one peer — relay must carry it the rest of the way
  const { graph } = randomMesh(120, 240, 77);
  // force n0 down to a single edge
  const only = graph.get('n0')[0];
  for (const neighbour of graph.get('n0')) {
    if (neighbour !== only) {
      graph.set(
        neighbour,
        graph.get(neighbour).filter((neighbourId) => neighbourId !== 'n0')
      );
    }
  }
  graph.set('n0', [only]);
  const stats = simulateFlood(graph, 'n0');
  t.is(stats.processed.size, 120, 'reach does not depend on the origin being well-connected');
});

test('disconnected graph: flood stays inside the origin component', (t) => {
  // two separate 5-node lines, no edge between them
  const graphA = lineGraph(5).graph; // n0..n4
  const lineB = lineGraph(5); // relabel to m0..m4
  const graph = new Map(graphA);
  const relabel = new Map();
  for (const nodeId of lineB.graph.keys()) {
    relabel.set(nodeId, 'm' + nodeId.slice(1));
  }
  for (const [nodeId, nbrs] of lineB.graph) {
    graph.set(
      relabel.get(nodeId),
      nbrs.map((neighbourId) => relabel.get(neighbourId))
    );
  }
  const stats = simulateFlood(graph, 'n0');
  t.is(stats.processed.size, 5, 'only the origin component (n0..n4) is reached');
  t.absent(
    stats.processed.has('m0'),
    'the isolated component gets nothing — reach is real, not assumed'
  );
});
