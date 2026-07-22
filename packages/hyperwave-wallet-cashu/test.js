// Test entrypoint: `npm test` runs this under Bare. brittle collects the tests from each required
// suite, runs them, prints TAP, and exits non-zero on any failure.
require('./lib/nums.test.js');
require('./lib/proof-store.test.js');
require('./lib/cashu-burn.test.js');
require('./lib/mint-networks.test.js');
require('./lib/cashu-wallet.test.js');
