// Public entry for the reusable HyperWave engine. Host entries import from here:
//   const { createEngine } = require('hyperwave-engine')
// The desktop worker (apps/desktop/workers/hyperwave.js) and the mobile bare-kit worklet
// (worklet/app.js) both boot `createEngine`; the lower-level pieces are re-exported for the
// headless harness (bin/wave.run.js) and any other host.
module.exports = {
  ...require('./lib/engine'), // createEngine
  ...require('./lib/wave'), // createWave, parseBootstrap
  ...require('./lib/wallet'), // Wallet (the payment interface / base class)
  ...require('./lib/tron-wallet'), // TronWallet, createPayments, toSun, fromSun, FEE_TRX
  ...require('./lib/tron-usdt-wallet'), // TronUsdtWallet, createTronUsdtWallet, FEE_USDT
  ...require('./lib/cashu-wallet'), // CashuWallet, createCashuWallet, CASHU_WALLET_TYPE
  ...require('./lib/payments'), // payFee, confirmBurn, wireWallet, burnMemo (fee flows)
  ...require('./lib/rpc') // serveEngine, createRpcClient (the host<->UI IPC seam)
};
