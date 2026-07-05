// Payment domain (WDK layer). A self-custodial Tron wallet per instance — used for the
// burned participation fees and gallery tips (no sponsor rewards). WDK is ESM-only, so this
// CJS module bridges to it via dynamic import(); it does real Tron Nile-testnet transfers
// (the spike/wdk de-risk confirmed this runs under Bare). No swarm here — the worker
// (hyperwave.js) / wave.js wire it in, mirroring ring/token/gallery as its own module.
//
// MVP uses **native TRX** as the payment currency (not TRC-20 USDT): no token contract, and
// a TRX transfer pays its own (tiny) fee from the same balance — so a wallet that received
// TRX can immediately send it, no separate gas token to fund.
const fs = require('bare-fs')
const b4a = require('b4a')

const NILE_PROVIDER = 'https://nile.trongrid.io'
const SUN = 1_000_000 // 1 TRX = 1e6 sun
// Tron's black hole (base58check of the all-zero EVM address, 41 + 20×00): no key exists,
// so TRX sent here is provably unspendable — the canonical burn. Used for the initiator's
// kick-off fee. (Zero-amount transfers are rejected by TransferContract, so a burn is a
// real small transfer; Tron also burns tx fees at the protocol level.)
const BURN_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'

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
  // Reuse WDK's own TronWeb (Bare-compatible; a standalone `require('tronweb')` pulls in
  // ethers/http which Bare lacks) to build the memo'd burn tx, which WDK then signs+sends.
  const tronweb = account._tronWeb || wallet._tronWeb
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
    // Burn `amountTrx` (send to the black hole — unspendable by anyone), tagging the tx
    // with an on-chain `memo` so the burn is provably tied to its purpose/wave (readable by
    // anyone via gettransactionbyid). Builds the tx with the memo, then lets WDK sign+send.
    async burn(amountTrx, memo) {
      let tx = await tronweb.transactionBuilder.sendTrx(
        BURN_ADDRESS,
        Number(toSun(amountTrx)),
        address
      )
      if (memo) tx = await tronweb.transactionBuilder.addUpdateData(tx, memo, 'utf8')
      const res = await account.sendTransaction(tx) // prebuilt (has txID) -> WDK signs + broadcasts
      log('burned', amountTrx, 'TRX 🔥 hash', res.hash, memo ? `memo=${memo}` : '')
      return { hash: res.hash, fee: res.fee }
    },
    // Verify (on-chain) that `txHash` is a burn matching expectations — the anti-spam gate a
    // peer runs before joining a wave: the kick-off fee must really be paid. Checks (via
    // `getTransaction`, which reflects a broadcast tx within seconds — `getTransactionInfo`'s
    // block confirmation lags badly on Nile): TransferContract to the black hole, from
    // `expect.from`, amount ≥ `expect.minTrx`, and the memo commits `expect.waveId`. The tx
    // is signed + spends real TRX, so its existence is a sufficient stake for anti-spam.
    // Returns { ok, reason }. Missing tx / RPC error → { ok: false } (fail closed).
    async verifyBurnTx(txHash, expect = {}) {
      try {
        const tx = await tronweb.trx.getTransaction(txHash)
        const c = tx?.raw_data?.contract?.[0]
        if (c?.type !== 'TransferContract') {
          return { ok: false, reason: 'not-found-or-not-transfer' }
        }
        const v = c.parameter.value
        const burnHex = tronweb.address.toHex(BURN_ADDRESS).toLowerCase()
        if ((v.to_address || '').toLowerCase() !== burnHex) {
          return { ok: false, reason: 'not-burned' }
        }
        if (expect.from) {
          const fromHex = tronweb.address.toHex(expect.from).toLowerCase()
          if ((v.owner_address || '').toLowerCase() !== fromHex) {
            return { ok: false, reason: 'wrong-sender' }
          }
        }
        if (expect.minTrx !== undefined && BigInt(v.amount || 0) < toSun(expect.minTrx)) {
          return { ok: false, reason: 'amount-too-low' }
        }
        // Memo is `hyperwave:<waveId>:<peerId>:<commit?>` — check it commits the waveId, and
        // return the (optional) raffle `commit` so the seed can read the ON-CHAIN commitment.
        const memo = tx.raw_data.data ? b4a.from(tx.raw_data.data, 'hex').toString() : ''
        if (expect.waveId && !memo.includes(expect.waveId)) {
          return { ok: false, reason: 'memo-mismatch' }
        }
        return { ok: true, commit: memo.split(':')[3] || '' }
      } catch (e) {
        return { ok: false, reason: e.message }
      }
    },
    dispose() {
      try {
        if (wallet.dispose) wallet.dispose()
      } catch {}
    }
  }
}

module.exports = { createPayments, NILE_PROVIDER, BURN_ADDRESS, SUN, toSun, fromSun }
