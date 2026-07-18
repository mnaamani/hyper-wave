// The default `Wallet` implementation: a self-custodial Tron wallet over WDK, using native TRX —
// burned participation fees + feed tips (no sponsor rewards). WDK is ESM-only, so this CJS module
// bridges to it via dynamic import(); it does real Tron transfers (the spike/wdk de-risk confirmed
// this runs under Bare). No swarm here — the engine wires it in via the `Wallet` interface
// (wallet.js). Native TRX (not TRC-20 USDT): no token contract, and a TRX transfer pays its own
// tiny fee from the same balance — a wallet that received TRX can send it. The `network` is a
// first-class option (nile testnet by default, mainnet opt-in) — it selects the RPC provider AND
// the on-the-wire wallet `type`, so the same implementation serves testnet and production.
const fs = require('bare-fs');
const b4a = require('b4a');
const { Wallet } = require('hyperwave-wallet');

// Known Tron networks → their default JSON-RPC (TronGrid) endpoint. The network name also forms this
// wallet's on-the-wire TYPE id (`tron-<network>`; `tron-usdt-<network>` for the USDT variant), so a
// testnet wave and a mainnet wave are DISTINCT payment mechanisms — a Nile burn is worthless on
// mainnet, and the join gate (wave.js) keeps a peer off a wave whose network its wallet doesn't
// match. The default is a TESTNET (Nile): mainnet ('real funds') must be opted into explicitly, so a
// misconfiguration never spends real money by default. For any other node, pass an explicit
// `provider` (with a `network` name that labels the wire type).
const TRON_NETWORKS = {
  nile: 'https://nile.trongrid.io', // Nile testnet (default)
  shasta: 'https://api.shasta.trongrid.io', // Shasta testnet
  mainnet: 'https://api.trongrid.io' // Tron mainnet — real funds
};
const DEFAULT_TRON_NETWORK = 'nile';

/**
 * This wallet's on-the-wire payment-mechanism id for a Tron network — `tron-<network>` (e.g.
 * `tron-nile`, `tron-mainnet`). Distinct per network so cross-network waves never mix.
 * @param {string} network - The Tron network name (e.g. 'nile', 'mainnet').
 * @returns {string} The wallet type id.
 */
const tronWalletType = (network) => 'tron-' + network;

// The default-network ('nile') native-TRX type id — exported for reference; the live value comes
// from `wallet.type` (network-derived), so a mainnet wallet advertises `tron-mainnet`.
const TRON_WALLET_TYPE = tronWalletType(DEFAULT_TRON_NETWORK);
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
  #network;
  #accountIndex;
  #fee;
  #log;

  /**
   * @param {Object} deps - The initialized WDK handles (from createPayments).
   * @param {Object} deps.wallet - The WDK WalletManagerTron.
   * @param {Object} deps.account - The derived account.
   * @param {Object} deps.tronweb - WDK's TronWeb (Bare-compatible).
   * @param {string} deps.address - The derived Tron address.
   * @param {string} [deps.network] - The Tron network name (labels the wire type).
   * @param {number} [deps.accountIndex] - The BIP-44 account index this wallet is (default 0).
   * @param {number} [deps.fee] - Participation fee in whole TRX (default FEE_TRX).
   * @param {(...args: any[]) => void} deps.log - Logger.
   */
  constructor({
    wallet,
    account,
    tronweb,
    address,
    network = DEFAULT_TRON_NETWORK,
    accountIndex = 0,
    fee = FEE_TRX,
    log
  }) {
    super();
    // A burn is a real transfer to the black hole (Tron rejects zero-amount transfers), so the fee
    // must be a positive number — fail fast on a misconfigured `{ fee }` rather than at burn time.
    if (!(Number(fee) > 0)) {
      throw new Error('wallet `fee` must be a positive number');
    }
    this.#wallet = wallet;
    this.#account = account;
    this.#tronweb = tronweb;
    this.#address = address;
    this.#network = network;
    this.#accountIndex = accountIndex;
    this.#fee = Number(fee);
    this.#log = log;
  }

  get type() {
    return tronWalletType(this.#network);
  }

  get unit() {
    return 'TRX';
  }

  get fee() {
    return this.#fee;
  }

  get address() {
    return this.#address;
  }

  get accountIndex() {
    return this.#accountIndex;
  }

  // Derive the first `count` accounts from the shared seed (offline — getAddress is derivation only)
  // via BIP-44 (m/44'/195'/0'/0/i), each a distinct address, so a host can offer an account picker.
  // Reuses the one WDK wallet manager; no network call.
  async accounts(count = 5) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const account = await this.#wallet.getAccount(i);
      out.push({ index: i, address: await account.getAddress() });
    }
    return out;
  }

  // { address, amount, unit } in whole TRX. Network call to the provider.
  async balances() {
    const raw = await this.#account.getBalance();
    return { address: this.#address, amount: fromSun(raw), unit: this.unit };
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

  // Verify (on-chain) that `burnRef` (a Tron tx hash) is a burn matching expectations — the
  // anti-spam gate a peer runs before joining a wave: the start fee must really be paid. Checks
  // (via `getTransaction`, which reflects a broadcast tx within seconds — `getTransactionInfo`'s
  // block confirmation lags badly on Nile): TransferContract to the black hole, from `expect.from`,
  // amount ≥ `expect.minAmount`, and the memo commits `expect.waveId`. The tx is signed + spends
  // real TRX, so its existence is a sufficient stake for anti-spam. Returns { ok, reason }. Missing
  // tx / RPC error → { ok: false } (fail closed).
  async verifyBurnTx(burnRef, expect = {}) {
    try {
      const tx = await this.#tronweb.trx.getTransaction(burnRef);
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
        expect.minAmount !== undefined &&
        BigInt(value.amount || 0) < toSun(expect.minAmount)
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
 * Bring up the shared Tron/WDK account (seed → account → address → TronWeb) that both the native
 * `TronWallet` and the TRC-20 `TronUsdtWallet` are constructed from. WDK is ESM-only, so this
 * bridges via dynamic import(). Seed precedence: injected -> file -> generate and persist (a mobile
 * host injects from secure storage; desktop persists to `wallet.seed`).
 * @param {Object} [options] - Init options.
 * @param {string} options.storageDir - Directory holding the persisted `wallet.seed` file.
 * @param {string} [options.seed] - Injected seed phrase (skips the filesystem when provided).
 * @param {string} [options.network] - Tron network name (`nile` default, `mainnet`, `shasta`, …) —
 *   selects the default provider AND the wire type. Mainnet is opt-in (real funds).
 * @param {string} [options.provider] - Tron JSON-RPC provider URL — overrides the network's default
 *   (point a named `network` at a custom node); REQUIRED for a network not in `TRON_NETWORKS`.
 * @param {number} [options.accountIndex] - BIP-44 account index (m/44'/195'/0'/0/i) — a distinct
 *   address per index from the same seed, so a host can offer a multi-account picker. Default 0.
 * @param {(...args: any[]) => void} [options.log] - Logger callback.
 * @returns {Promise<{wallet: Object, account: Object, tronweb: Object, address: string, network: string, accountIndex: number, log: Function}>} The WDK handles.
 */
async function initTronAccount({
  storageDir,
  seed: injectedSeed,
  network = DEFAULT_TRON_NETWORK,
  provider,
  accountIndex = 0,
  log = () => {}
} = {}) {
  const rpc = provider || TRON_NETWORKS[network];
  if (!rpc) {
    throw new Error(
      `unknown Tron network '${network}' — pass a known network (` +
        `${Object.keys(TRON_NETWORKS).join(', ')}) or an explicit \`provider\` URL`
    );
  }
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

  const wallet = new WalletManagerTron(seed, { provider: rpc });
  const account = await wallet.getAccount(accountIndex); // BIP-44 m/44'/195'/0'/0/<accountIndex>
  const address = await account.getAddress(); // offline (derived from the seed)
  // Reuse WDK's own TronWeb (Bare-compatible; a standalone `require('tronweb')` pulls in
  // ethers/http which Bare lacks) to build the memo'd burn tx, which WDK then signs+sends.
  const tronweb = account._tronWeb || wallet._tronWeb;
  log('wallet ready', address, 'account', accountIndex, 'on', network);

  return { wallet, account, tronweb, address, network, accountIndex, log };
}

/**
 * Create the default self-custodial Tron wallet (a `TronWallet`, native TRX). This is the default
 * the engine uses; an app injects its own `Wallet` subclass (e.g. `createTronUsdtWallet`,
 * tron-usdt-wallet.js) via createEngine `deps.createPayments`.
 * @param {Object} [options] - Wallet options (see initTronAccount), plus:
 * @param {number} [options.fee] - Participation fee in whole TRX (default FEE_TRX).
 * @returns {Promise<TronWallet>} The ready wallet.
 */
async function createPayments(options = {}) {
  // `fee` is a wallet-construction option, not an account concern — initTronAccount ignores it.
  return new TronWallet({
    ...(await initTronAccount(options)),
    fee: options.fee
  });
}

module.exports = {
  TronWallet,
  createPayments,
  initTronAccount,
  toSun,
  fromSun,
  FEE_TRX,
  tronWalletType,
  TRON_WALLET_TYPE,
  TRON_NETWORKS,
  DEFAULT_TRON_NETWORK,
  BURN_ADDRESS
};
