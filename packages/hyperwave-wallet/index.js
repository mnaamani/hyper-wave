// Public entry for the HyperWave wallet interface — the abstract `Wallet` base class. A concrete
// wallet (hyperwave-wallet-tron, hyperwave-wallet-cashu, or your own) extends it; the engine
// (hyperwave-engine) composes its fee flows over ANY conforming implementation, injected via
// createEngine `deps.createPayments`. This package has no dependencies.
//   const { Wallet } = require('hyperwave-wallet')
module.exports = require('./lib/wallet'); // Wallet (the abstract payment interface)
