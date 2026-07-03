// Test entrypoint: `npm test` runs this under Bare. brittle collects the tests from
// each required suite, runs them, prints TAP, and exits non-zero on any failure.
require('./workers/lib/wave.logic.test.js')
require('./workers/lib/chord.test.js')
require('./workers/lib/flood.test.js')
require('./workers/lib/wave.token.test.js')
require('./workers/lib/wave.gallery.test.js')
require('./workers/lib/wave.autobase.test.js')
require('./workers/lib/gallery.replication.test.js')
require('./workers/lib/pay.test.js')
