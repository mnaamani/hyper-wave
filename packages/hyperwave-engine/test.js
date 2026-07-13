// Test entrypoint: `npm test` runs this under Bare. brittle collects the tests from
// each required suite, runs them, prints TAP, and exits non-zero on any failure.
require('./lib/wave.logic.test.js');
require('./lib/swarm.seed.test.js');
require('./lib/pins.test.js');
require('./lib/flood.test.js');
require('./lib/peer-table.test.js');
require('./lib/selfie.test.js');
require('./lib/attest.test.js');
require('./lib/sweep.test.js');
require('./lib/wave.gallery.test.js');
require('./lib/wave.autobase.test.js');
require('./lib/gallery.replication.test.js');
require('./lib/gallery.replication.bench.test.js');
require('./lib/gallery-session.test.js');
require('./lib/wallet.test.js');
require('./lib/engine.test.js');
