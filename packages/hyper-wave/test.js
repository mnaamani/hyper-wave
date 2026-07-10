// Test entrypoint: `npm test` runs this under Bare. brittle collects the tests from
// each required suite, runs them, prints TAP, and exits non-zero on any failure.
require('./lib/wave.logic.test.js');
require('./lib/swarm.seed.test.js');
require('./lib/chord.test.js');
require('./lib/flood.test.js');
require('./lib/wave.token.test.js');
require('./lib/wave.gallery.test.js');
require('./lib/wave.autobase.test.js');
require('./lib/gallery.replication.test.js');
require('./lib/pay.test.js');
require('./lib/engine.test.js');
