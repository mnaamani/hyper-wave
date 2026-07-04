// Payment domain (final-idea.md WDK layer). A self-custodial Tron wallet per instance —
// used for the join bond, interlocked payouts, and gallery tips. WDK is ESM-only, so this
// CJS module bridges to it via dynamic import(); it does real Tron Nile-testnet transfers
// (the spike/wdk de-risk confirmed this runs under Bare). No swarm here — the worker
// (hyperwave.js) / wave.js wire it in, mirroring ring/token/gallery as its own module.
//
// MVP uses **native TRX** as the payment currency (not TRC-20 USDT): no token contract, and
// a TRX transfer pays its own (tiny) fee from the same balance — so a wallet that received
// TRX can immediately send it, no separate gas token to fund.
const fs = require('bare-fs')

const NILE_PROVIDER = 'https://nile.trongrid.io'
const SUN = 1_000_000 // 1 TRX = 1e6 sun

const toSun = (trx) => BigInt(Math.round(Number(trx) * SUN))
const fromSun = (raw) => Number(raw) / SUN

async function createPayments({ storageDir, provider = NILE_PROVIDER, log = () => {} } = {}) {
  const { default: WDK } = await import('@tetherto/wdk')
  const { default: WalletManagerTron } = await import('@tetherto/wdk-wallet-tron')

  // Persist the seed alongside (but outside) the per-run hyperwave store that wave.js wipes,
  // so the wallet is self-custodial and survives restarts.
  try {
    fs.mkdirSync(storageDir, { recursive: true })
  } catch {}
  const seedFile = storageDir + '/wallet.seed'
  let seed
  try {
    seed = fs.readFileSync(seedFile, 'utf8').trim()
  } catch {}
  if (!seed) {
    seed = WDK.getRandomSeedPhrase()
    fs.writeFileSync(seedFile, seed)
  }

  const wallet = new WalletManagerTron(seed, { provider })
  const account = await wallet.getAccount(0)
  const address = await account.getAddress() // offline (derived from the seed)
  log('wallet ready', address)

  return {
    address,
    // { address, trx } in whole TRX. Network call to the provider.
    async balances() {
      const raw = await account.getBalance()
      return { address, trx: fromSun(raw) }
    },
    // Send `amountTrx` (whole TRX) to a Tron address; resolves { hash, fee }.
    async send(recipient, amountTrx) {
      const res = await account.sendTransaction({ to: recipient, value: toSun(amountTrx) })
      log('sent', amountTrx, 'TRX ->', recipient, 'hash', res.hash)
      return { hash: res.hash, fee: res.fee }
    },
    dispose() {
      try {
        if (wallet.dispose) wallet.dispose()
      } catch {}
    }
  }
}

module.exports = { createPayments, NILE_PROVIDER, SUN, toSun, fromSun }
