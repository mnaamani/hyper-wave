// seeds.js — the seed / bootstrap helpers. parseBootstrap turns a "host:port" string
// into Hyperswarm's bootstrap option; loadOrCreateSwarmSeed persists the swarm identity
// so a peer keeps the same ring seat across restarts. Run:  bare examples/seeds.js
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const fs = require('bare-fs');
const { parseBootstrap, loadOrCreateSwarmSeed } = require('hyperwave-lib-core');

// "host:port[,host:port…]" → bootstrap array (a local DHT); '' / undefined → null (public DHT).
console.log('parseBootstrap:', parseBootstrap('127.0.0.1:49737'));
console.log('parseBootstrap(empty):', parseBootstrap(''));

const dir = '/tmp/hw-example-seed-' + Date.now();

// First call mints + persists <dir>/swarm.seed; the derived keypair is this peer's identity.
const seed1 = loadOrCreateSwarmSeed(dir);
const id1 = b4a.toString(crypto.keyPair(seed1).publicKey, 'hex');
console.log('seed persisted:', fs.existsSync(dir + '/swarm.seed'), '→ id', id1.slice(0, 8));

// A second call (a "restart") returns the SAME seed → the same seat/id.
const seed2 = loadOrCreateSwarmSeed(dir);
const id2 = b4a.toString(crypto.keyPair(seed2).publicKey, 'hex');
console.log('stable across restart:', id1 === id2);

// An injected hex seed is used verbatim and never written (e.g. mobile secure storage).
const injected = b4a.toString(crypto.randomBytes(32), 'hex');
const injectedSeed = loadOrCreateSwarmSeed('/tmp/hw-example-seed-inject', injected);
console.log('injected seed used as-is:', b4a.toString(injectedSeed, 'hex') === injected);

fs.rmSync(dir, { recursive: true, force: true });
