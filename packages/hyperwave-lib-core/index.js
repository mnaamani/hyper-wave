// Public entry for the reusable HyperWave engine. Host entries import from here:
//   const { init } = require('hyperwave-lib-core')
// The desktop worker (apps/desktop/workers/hyperwave.js) and the mobile bare-kit worklet
// (worklet/app.js) both boot `init`; the lower-level pieces are re-exported for the
// headless harness (bin/wave.run.js) and any other host.
module.exports = {
  ...require('./lib/core'), // init
  ...require('./lib/wave'), // createWave, parseBootstrap
  ...require('./lib/pay'), // createPayments
  ...require('./lib/fees') // FEE_TRX, payFee, confirmBurn, wireWallet
};
