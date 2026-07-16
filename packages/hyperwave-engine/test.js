// Test entrypoint: `npm test` runs this under Bare. brittle collects the tests from
// each required suite, runs them, prints TAP, and exits non-zero on any failure.
require('./lib/wave.logic.test.js');
require('./lib/swarm.seed.test.js');
require('./lib/flood.test.js');
require('./lib/peer-table.test.js');
require('./lib/entry.test.js');
require('./lib/attest.test.js');
require('./lib/messages.test.js');
require('./lib/sweep.test.js');
require('./lib/wave.feed.test.js');
require('./lib/feed.replication.test.js');
require('./lib/feed-crdt.test.js');
require('./lib/wallet.test.js');
require('./lib/tron-wallet.test.js');
require('./lib/tron-usdt-wallet.test.js');
require('./lib/engine.test.js');
require('./lib/rpc.test.js');
require('./lib/swarm.share.test.js');
