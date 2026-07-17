// Public entry for the HyperWave Tron wallet — concrete `Wallet` (hyperwave-engine)
// implementations over WDK: the default self-custodial native-TRX wallet and the TRC-20 USDT
// variant. A host injects one via createEngine `deps.createPayments`:
//   const { createEngine } = require('hyperwave-engine')
//   const { createPayments } = require('hyperwave-wallet-tron')
//   createEngine({ ..., deps: { createPayments } })
module.exports = {
  ...require('./lib/tron-wallet'), // TronWallet, createPayments, initTronAccount, toSun, fromSun, FEE_TRX, tronWalletType, BURN_ADDRESS
  ...require('./lib/tron-usdt-wallet') // TronUsdtWallet, createTronUsdtWallet, tronUsdtWalletType, FEE_USDT
};
