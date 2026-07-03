// Payment domain (final-idea.md WDK layer). A self-custodial Tron wallet per instance —
// used for the join bond, interlocked payouts, and gallery tips. WDK is ESM-only, so this
// CJS module bridges to it via dynamic import(); it does real Tron Nile-testnet USDT
// transfers (the spike/wdk de-risk confirmed this runs under Bare). No swarm here — the
// worker (hyperwave.js) / wave.js wire it in, mirroring ring/token/gallery as its own module.
const fs = require('bare-fs')

const NILE_PROVIDER = 'https://nile.trongrid.io'
const NILE_USDT = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf' // TRC-20 USDT the nileex faucet dispenses
const USDT_UNIT = 1_000_000 // 6 decimals

const toUnits = (usdt) => BigInt(Math.round(Number(usdt) * USDT_UNIT))
const fromUnits = (raw) => Number(raw) / USDT_UNIT

async function createPayments({
  storageDir,
  provider = NILE_PROVIDER,
  usdt = NILE_USDT,
  log = () => {}
} = {}) {
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
    usdt,
    // { address, trx, usdt } in human units. Network call to the provider.
    async balances() {
      const [trx, bal] = await Promise.all([account.getBalance(), account.getTokenBalance(usdt)])
      return { address, trx: Number(trx) / 1e6, usdt: fromUnits(bal) }
    },
    // Send `amountUsdt` (human units) to a Tron address; resolves { hash, fee }.
    async send(recipient, amountUsdt) {
      const res = await account.transfer({ token: usdt, recipient, amount: toUnits(amountUsdt) })
      log('sent', amountUsdt, 'USDT ->', recipient, 'hash', res.hash)
      return { hash: res.hash, fee: res.fee }
    },
    dispose() {
      try {
        if (wallet.dispose) wallet.dispose()
      } catch {}
    }
  }
}

module.exports = { createPayments, NILE_PROVIDER, NILE_USDT, USDT_UNIT, toUnits, fromUnits }
