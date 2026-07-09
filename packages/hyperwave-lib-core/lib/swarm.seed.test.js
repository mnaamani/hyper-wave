// Swarm identity seed: persisted so a peer keeps the SAME ring seat + signing key across restarts
// (only wallet.seed persisted before). Derivation is offline + deterministic — no swarm is
// constructed here. Runs under Bare:  bare lib/swarm.seed.test.js   (or `npm test`)
const test = require('brittle');
const fs = require('bare-fs');
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const { loadOrCreateSwarmSeed } = require('./wave');

const idOf = (seed) => b4a.toString(crypto.keyPair(seed).publicKey, 'hex');

test('swarm seed persists so the peer id / ring seat is stable across restarts', (t) => {
  const dir = '/tmp/hyperwave-seed-test-' + Date.now();
  const other = '/tmp/hyperwave-seed-other-' + Date.now();
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.teardown(() => fs.rmSync(other, { recursive: true, force: true }));

  const seed1 = loadOrCreateSwarmSeed(dir);
  t.is(seed1.length, 32, '32-byte seed');
  t.ok(fs.existsSync(dir + '/swarm.seed'), 'seed persisted to disk');

  // same storage dir -> same seed -> same keypair (the peer id / ring seat) across restarts
  const seed2 = loadOrCreateSwarmSeed(dir);
  t.ok(b4a.equals(seed1, seed2), 'seed survives a restart');
  t.is(idOf(seed1), idOf(seed2), 'peer id (ring seat) is stable across runs');

  // a separate storage dir gets its own independent identity
  const seedOther = loadOrCreateSwarmSeed(other);
  t.absent(b4a.equals(seed1, seedOther), 'a separate storage dir gets its own identity');
});

test('an injected hex seed is used verbatim and never written to disk', (t) => {
  const dir = '/tmp/hyperwave-seed-inject-' + Date.now();
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  const injected = b4a.toString(crypto.randomBytes(32), 'hex');
  const seed = loadOrCreateSwarmSeed(dir, injected);
  t.is(b4a.toString(seed, 'hex'), injected, 'injected seed used as-is');
  t.absent(fs.existsSync(dir + '/swarm.seed'), 'injected seed not persisted');
});

test('a corrupt seed file is regenerated instead of bricking startup', (t) => {
  const dir = '/tmp/hyperwave-seed-corrupt-' + Date.now();
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + '/swarm.seed', 'not-a-valid-hex-seed');

  const seed = loadOrCreateSwarmSeed(dir);
  t.is(seed.length, 32, 'a fresh 32-byte seed is minted');
  // and the repaired file now round-trips
  t.ok(b4a.equals(seed, loadOrCreateSwarmSeed(dir)), 'repaired seed persists');
});
