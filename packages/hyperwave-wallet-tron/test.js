// Test entrypoint: `npm test` runs this under Bare. brittle collects the tests from each required
// suite, runs them, prints TAP, and exits non-zero on any failure.
require('./lib/tron-wallet.test.js');
require('./lib/tron-usdt-wallet.test.js');
