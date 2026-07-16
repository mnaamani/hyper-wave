// The default `Wallet` implementation: a self-custodial Tron (Nile testnet) wallet over WDK,
// using native TRX — burned participation fees + feed tips (no sponsor rewards). WDK is ESM-only,
// so this CJS module bridges to it via dynamic import(); it does real Tron transfers (the
// spike/wdk de-risk confirmed this runs under Bare). No swarm here — the engine wires it in via
// the `Wallet` interface (wallet.js). Native TRX (not TRC-20 USDT): no token contract, and a TRX
// transfer pays its own tiny fee from the same balance — a wallet that received TRX can send it.
const fs = require('bare-fs');
const b4a = require('b4a');
const { Wallet } = require('./wallet');

const NILE_PROVIDER = 'https://nile.trongrid.io';
const TRON_WALLET_TYPE = 'tron-nile'; // this wallet's on-the-wire payment-mechanism id
const SUN = 1_000_000; // 1 TRX = 1e6 sun
// Tron's black hole (base58check of the all-zero EVM address, 41 + 20×00): no key exists,
// so TRX sent here is provably unspendable — the canonical burn. Used for the initiator's
// start fee. (Zero-amount transfers are rejected by TransferContract, so a burn is a
// real small transfer; Tron also burns tx fees at the protocol level.)
const BURN_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

/** @type {number} Start/join fee in whole TRX, burned to the black hole (BURN_ADDRESS). */
const FEE_TRX = 1;

/**
 * Convert whole TRX to sun (1 TRX = 1e6 sun).
 * @param {number} trx - Amount in whole TRX.
 * @returns {bigint} The amount in sun.
 */
const toSun = (trx) => BigInt(Math.round(Number(trx) * SUN));
/**
 * Convert sun to whole TRX (1 TRX = 1e6 sun).
 * @param {number|bigint|string} raw - Amount in sun.
 * @returns {number} The amount in whole TRX.
 */
const fromSun = (raw) => Number(raw) / SUN;

/**
 * The default `Wallet`: a self-custodial Tron (Nile testnet) wallet over WDK, using native TRX.
 * Constructed by `createPayments` (which does the async WDK init); do not `new` it directly.
 */
class TronWallet extends Wallet {
  #wallet;
  #account;
  #tronweb;
  #address;
  #log;

  /**
   * @param {Object} deps - The initialized WDK handles (from createPayments).
   * @param {Object} deps.wallet - The WDK WalletManagerTron.
   * @param {Object} deps.account - The derived account.
   * @param {Object} deps.tronweb - WDK's TronWeb (Bare-compatible).
   * @param {string} deps.address - The derived Tron address.
   * @param {(...args: any[]) => void} deps.log - Logger.
   */
  constructor({ wallet, account, tronweb, address, log }) {
    super();
    this.#wallet = wallet;
    this.#account = account;
    this.#tronweb = tronweb;
    this.#address = address;
    this.#log = log;
  }

  get type() {
    return TRON_WALLET_TYPE;
  }

  get fee() {
    return FEE_TRX;
  }

  get address() {
    return this.#address;
  }

  // { address, trx } in whole TRX. Network call to the provider.
  async balances() {
    const raw = await this.#account.getBalance();
    return { address: this.#address, trx: fromSun(raw) };
  }

  // Send `amountTrx` (whole TRX) to a Tron address; resolves { hash, fee }.
  async send(recipient, amountTrx) {
    const res = await this.#account.sendTransaction({
      to: recipient,
      value: toSun(amountTrx)
    });
    this.#log('sent', amountTrx, 'TRX ->', recipient, 'hash', res.hash);
    return { hash: res.hash, fee: res.fee };
  }

  // Burn `amountTrx` (send to the black hole — unspendable by anyone), tagging the tx with an
  // on-chain `memo` so the burn is provably tied to its purpose/wave (readable by anyone via
  // gettransactionbyid). Builds the tx with the memo, then lets WDK sign+send.
  async burn(amountTrx, memo) {
    let tx = await this.#tronweb.transactionBuilder.sendTrx(
      BURN_ADDRESS,
      Number(toSun(amountTrx)),
      this.#address
    );
    if (memo) {
      tx = await this.#tronweb.transactionBuilder.addUpdateData(
        tx,
        memo,
        'utf8'
      );
    }
    const res = await this.#account.sendTransaction(tx); // prebuilt (has txID) -> WDK signs + broadcasts
    this.#log(
      'burned',
      amountTrx,
      'TRX 🔥 hash',
      res.hash,
      memo ? `memo=${memo}` : ''
    );
    return { hash: res.hash, fee: res.fee };
  }

  // Verify (on-chain) that `txHash` is a burn matching expectations — the anti-spam gate a peer
  // runs before joining a wave: the start fee must really be paid. Checks (via `getTransaction`,
  // which reflects a broadcast tx within seconds — `getTransactionInfo`'s block confirmation lags
  // badly on Nile): TransferContract to the black hole, from `expect.from`, amount ≥
  // `expect.minTrx`, and the memo commits `expect.waveId`. The tx is signed + spends real TRX, so
  // its existence is a sufficient stake for anti-spam. Returns { ok, reason }. Missing tx / RPC
  // error → { ok: false } (fail closed).
  async verifyBurnTx(txHash, expect = {}) {
    try {
      const tx = await this.#tronweb.trx.getTransaction(txHash);
      const contract = tx?.raw_data?.contract?.[0];
      if (contract?.type !== 'TransferContract') {
        return { ok: false, reason: 'not-found-or-not-transfer' };
      }
      const value = contract.parameter.value;
      const burnHex = this.#tronweb.address.toHex(BURN_ADDRESS).toLowerCase();
      if ((value.to_address || '').toLowerCase() !== burnHex) {
        return { ok: false, reason: 'not-burned' };
      }
      if (expect.from) {
        const fromHex = this.#tronweb.address.toHex(expect.from).toLowerCase();
        if ((value.owner_address || '').toLowerCase() !== fromHex) {
          return { ok: false, reason: 'wrong-sender' };
        }
      }
      if (
        expect.minTrx !== undefined &&
        BigInt(value.amount || 0) < toSun(expect.minTrx)
      ) {
        return { ok: false, reason: 'amount-too-low' };
      }
      // Memo is `hyperwave:<waveId>:<peerId>` — check it commits the waveId.
      const memo = tx.raw_data.data
        ? b4a.from(tx.raw_data.data, 'hex').toString()
        : '';
      if (expect.waveId && !memo.includes(expect.waveId)) {
        return { ok: false, reason: 'memo-mismatch' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  // Recent native-TRX transfers for this wallet, newest first — reads TronGrid's v1
  // account-transactions API through WDK's (Bare-compatible) TronWeb HTTP client, so it surfaces
  // funds/tips RECEIVED as well as the sends/burns we made (which the app already logs from its
  // own events). Native TransferContract only (no TRC-20). Normalized to { hash, direction:
  // 'in'|'out', amount (TRX), from, to, timestamp (ms), memo }. Returns [] on any error — the UI
  // falls back to the session log + the "full history" Tronscan link. Capped at 10 (the UI shows 10).
  async transactions(limit = 10) {
    try {
      const res = await this.#tronweb.fullNode.request(
        `v1/accounts/${this.#address}/transactions?limit=${limit}&only_confirmed=true&order_by=block_timestamp,desc`,
        {},
        'get'
      );
      const myHex = this.#tronweb.address.toHex(this.#address).toLowerCase();
      const out = [];
      for (const tx of (res && res.data) || []) {
        const contract =
          tx.raw_data && tx.raw_data.contract && tx.raw_data.contract[0];
        if (!contract || contract.type !== 'TransferContract') {
          continue; // native TRX transfers only
        }
        const value = (contract.parameter && contract.parameter.value) || {};
        const memo = tx.raw_data.data
          ? b4a.from(tx.raw_data.data, 'hex').toString()
          : '';
        out.push({
          hash: tx.txID,
          direction:
            (value.owner_address || '').toLowerCase() === myHex ? 'out' : 'in',
          amount: fromSun(value.amount || 0),
          from: value.owner_address
            ? this.#tronweb.address.fromHex(value.owner_address)
            : '',
          to: value.to_address
            ? this.#tronweb.address.fromHex(value.to_address)
            : '',
          timestamp: tx.block_timestamp || 0,
          memo
        });
      }
      return out;
    } catch (err) {
      this.#log('transactions fetch failed:', err.message);
      return [];
    }
  }

  dispose() {
    try {
      if (this.#wallet.dispose) {
        this.#wallet.dispose();
      }
    } catch {}
  }
}

/**
 * Create the default self-custodial Tron wallet (a `TronWallet`, WDK layer) for burned fees and
 * feed tips. WDK is ESM-only, so this bridges via dynamic import(). Seed precedence: injected ->
 * file -> generate and persist (a mobile host injects from secure storage; desktop persists to
 * `wallet.seed`). This is the default the engine uses; an app injects its own `Wallet` subclass
 * via createEngine `deps.createPayments`.
 * @param {Object} [options] - Wallet options.
 * @param {string} options.storageDir - Directory holding the persisted `wallet.seed` file.
 * @param {string} [options.seed] - Injected seed phrase (skips the filesystem when provided).
 * @param {string} [options.provider] - Tron JSON-RPC provider URL (defaults to Nile testnet).
 * @param {(...args: any[]) => void} [options.log] - Logger callback.
 * @returns {Promise<TronWallet>} The ready wallet.
 */
async function createPayments({
  storageDir,
  seed: injectedSeed,
  provider = NILE_PROVIDER,
  log = () => {}
} = {}) {
  const { default: WDK } = await import('@tetherto/wdk');
  const { default: WalletManagerTron } =
    await import('@tetherto/wdk-wallet-tron');

  // Seed precedence: injected -> file -> generate+persist. A mobile host injects the seed from
  // secure storage (Keychain/Keystore) and never touches the filesystem; desktop persists it in
  // a file alongside (but outside) the per-run hyperwave store that wave.js wipes, so the wallet
  // is self-custodial and survives restarts.
  try {
    fs.mkdirSync(storageDir, { recursive: true });
  } catch {}
  const seedFile = storageDir + '/wallet.seed';
  let seed = injectedSeed && injectedSeed.trim();
  if (!seed) {
    try {
      seed = fs.readFileSync(seedFile, 'utf8').trim();
    } catch {}
  }
  if (!seed) {
    seed = WDK.getRandomSeedPhrase();
    fs.writeFileSync(seedFile, seed);
  }

  const wallet = new WalletManagerTron(seed, { provider });
  const account = await wallet.getAccount(0);
  const address = await account.getAddress(); // offline (derived from the seed)
  // Reuse WDK's own TronWeb (Bare-compatible; a standalone `require('tronweb')` pulls in
  // ethers/http which Bare lacks) to build the memo'd burn tx, which WDK then signs+sends.
  const tronweb = account._tronWeb || wallet._tronWeb;
  log('wallet ready', address);

  return new TronWallet({ wallet, account, tronweb, address, log });
}

module.exports = {
  TronWallet,
  createPayments,
  toSun,
  fromSun,
  FEE_TRX,
  TRON_WALLET_TYPE
};
