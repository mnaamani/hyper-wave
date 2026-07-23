// Public entry for the HyperWave Cashu wallet — a concrete `Wallet` (hyperwave-engine)
// implementation over Chaumian ecash on a Lightning-connected mint. Fees are burned as ecash
// P2PK-locked to a NUMS pubkey (the black-hole analog) tagged with the seat memo; tips are bearer
// tokens the recipient redeems. A host injects it via createEngine `deps.createPayments`:
//   const { createEngine } = require('hyperwave-engine')
//   const { createCashuWallet } = require('hyperwave-wallet-cashu')
//   createEngine({ ..., deps: { createPayments: createCashuWallet } })
module.exports = {
  ...require('./lib/cashu-wallet'), // CashuWallet, createCashuWallet, CASHU_WALLET_TYPE, CASHU_UNIT, DEFAULT_MINT
  ...require('./lib/cashu-burn'), // verifyBurnProofs, burnTags, p2pkLockPubkey, MEMO_TAG_KEY
  ...require('./lib/mint-networks'), // KNOWN_MINTS, networkOfMint, crossNetworkMints
  ...require('./lib/nums'), // numsBurnPubkey, NUMS_DOMAIN
  ...require('./lib/proof-store'), // ProofStore, MAX_HISTORY
  ...require('./lib/bare-web-shims') // installBareWebShims
};
