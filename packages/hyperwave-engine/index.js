// Public entry for the reusable HyperWave engine. Host entries import from here:
//   const { createEngine } = require('hyperwave-engine')
// The desktop worker (workers/hyperwave.js) and the mobile bare-kit worklet
// (worklet/app.js) both boot `createEngine`; the lower-level pieces are re-exported for the
// headless harness (bin/wave.run.js) and any other host.
// NOTE: the engine ships NO concrete wallet — payments are pluggable. The abstract `Wallet`
// interface lives in its own package (`hyperwave-wallet`); the engine exports only the
// wallet-agnostic fee flows (payments.js). A host adds a payment mechanism from a separate package
// (`hyperwave-wallet-cashu`, `hyperwave-wallet-tron`) and injects its factory via createEngine
// `deps.createPayments`.
module.exports = {
  ...require('./lib/engine'), // createEngine
  ...require('./lib/wave'), // createWave, parseBootstrap
  ...require('./lib/payments'), // payFee, confirmBurn, wireWallet, burnMemo (fee flows)
  ...require('./lib/rpc') // serveEngine, createRpcClient (the host<->UI IPC seam)
};
