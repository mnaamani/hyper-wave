// A USDT (TRC-20) wallet on Tron — an alternative payment mechanism to the native-TRX `TronWallet`.
// It EXTENDS `TronWallet` (reusing the shared WDK account init, the address, dispose, and the burn
// memo), overriding the currency operations to move USDT via the token contract instead of native
// TRX. Its `type` is `tron-usdt-<network>` (e.g. `tron-usdt-nile`), distinct from the native
// `tron-<network>`, so on the wire a USDT wave and a TRX wave are DIFFERENT payment mechanisms — a
// peer only joins a wave whose type its own wallet matches (wave.js join gate). Like the native
// wallet, the network (nile default, mainnet opt-in) is an option (selects the RPC + the wire type).
//
// **USDT is a TRC-20 token, so a transfer costs TRX for GAS** (energy/bandwidth) — this wallet
// pays fees in USDT but must also hold a little TRX to send. (This gas dependency is exactly why
// native TRX is the default; USDT is "on top of" it.) The `fundedForFee` check tests the USDT
// balance vs the fee, not the TRX gas — an under-gassed send surfaces as a `burn-result: failed`
// rather than a fail-fast. USDT is 6-decimal (like TRX↔sun), so toSun/fromSun are reused.
//
// Uses WDK's own TRC-20 token API on the account (`getTokenBalance` for balances, `transfer` for
// sends — both from wdk-wallet-tron, which handle the fee-limit + fee quoting). The BURN is the one
// op WDK's `transfer` can't do: it attaches no on-chain memo, and the burn must commit the wave via
// `hyperwave:<waveId>:<peerId>`. So burn hand-builds the same `transfer(address,uint256)` call (WITH
// a feeLimit) + `addUpdateData(memo)` and lets WDK sign+send it — the same pattern the native
// TronWallet uses for its memo'd burn. `verifyBurnTx`/`transactions` are read/parse paths with no
// WDK equivalent (raw TronWeb).
//
// NOTE: the on-chain paths are **pending Nile verification** — as with the native `TronWallet`, the
// on-chain behaviour is de-risked by the on-chain e2e tier / a spike, not offline unit tests (which
// cover derivation + the interface). Supply the correct Nile USDT contract address via `usdtContract`.
const b4a = require('b4a');
const {
  TronWallet,
  initTronAccount,
  toSun,
  fromSun,
  DEFAULT_TRON_NETWORK,
  BURN_ADDRESS
} = require('./tron-wallet');

/**
 * The USDT wallet's on-the-wire type id for a Tron network — `tron-usdt-<network>` (e.g.
 * `tron-usdt-nile`, `tron-usdt-mainnet`). Distinct from the native `tron-<network>` AND per network.
 * @param {string} network - The Tron network name (e.g. 'nile', 'mainnet').
 * @returns {string} The wallet type id.
 */
const tronUsdtWalletType = (network) => 'tron-usdt-' + network;

// The default-network ('nile') USDT type id — exported for reference; the live value is
// `wallet.type` (network-derived), so a mainnet USDT wallet advertises `tron-usdt-mainnet`.
const TRON_USDT_WALLET_TYPE = tronUsdtWalletType(DEFAULT_TRON_NETWORK);
const FEE_USDT = 1; // participation fee, in USDT
const TRANSFER_SELECTOR = 'a9059cbb'; // keccak256('transfer(address,uint256)')[0:4]
// Fee-limit (energy cap) for a TRC-20 contract call — a token transfer needs one or it fails
// out-of-energy. Matches wdk-wallet-tron's DEFAULT_FEE_LIMIT_SUN (used by account.transfer).
const TRC20_FEE_LIMIT_SUN = 15_000_000; // 15 TRX

/**
 * A self-custodial Tron wallet that pays in **USDT (TRC-20)** rather than native TRX. Constructed
 * by `createTronUsdtWallet`; do not `new` it directly. Keeps its own copies of the WDK handles
 * (ES `#private` fields aren't inherited from `TronWallet`), and overrides every currency op.
 */
class TronUsdtWallet extends TronWallet {
  #account;
  #tronweb;
  #usdtContract;
  #network;
  #log;

  /**
   * @param {Object} deps - The WDK handles (from initTronAccount) + the token contract.
   * @param {Object} deps.wallet - The WDK WalletManagerTron.
   * @param {Object} deps.account - The derived account.
   * @param {Object} deps.tronweb - WDK's TronWeb (Bare-compatible).
   * @param {string} deps.address - The derived Tron address.
   * @param {string} deps.usdtContract - The USDT TRC-20 contract address (base58).
   * @param {string} [deps.network] - The Tron network name (labels the wire type).
   * @param {number} [deps.accountIndex] - The BIP-44 account index (default 0).
   * @param {number} [deps.fee] - Participation fee in whole USDT (default FEE_USDT).
   * @param {(...args: any[]) => void} deps.log - Logger.
   */
  constructor({
    wallet,
    account,
    tronweb,
    address,
    usdtContract,
    network = DEFAULT_TRON_NETWORK,
    accountIndex = 0,
    fee = FEE_USDT,
    log
  }) {
    // parent stores its own copies (dispose, address, network + accountIndex for its getters + the
    // inherited accounts()/`get fee()`, so this wallet only overrides type + the currency ops).
    super({
      wallet,
      account,
      tronweb,
      address,
      network,
      accountIndex,
      fee,
      log
    });
    this.#account = account;
    this.#tronweb = tronweb;
    this.#usdtContract = usdtContract;
    this.#network = network;
    this.#log = log;
  }

  get type() {
    return tronUsdtWalletType(this.#network);
  }

  // The USDT token balance (WDK's TRC-20 balanceOf), in whole USDT.
  async balances() {
    const raw = await this.#account.getTokenBalance(this.#usdtContract);
    return { address: this.address, trx: fromSun(raw) };
  }

  // Send `amount` USDT to a Tron address — WDK's own TRC-20 transfer (handles fee-limit + quoting;
  // gas paid in TRX). No memo needed for a plain send.
  async send(recipient, amount) {
    const res = await this.#account.transfer({
      token: this.#usdtContract,
      recipient,
      amount: toSun(amount)
    });
    this.#log('sent', amount, 'USDT ->', recipient, 'hash', res.hash);
    return { hash: res.hash, fee: res.fee };
  }

  // Burn `amount` USDT (a TRC-20 transfer to the black hole — unspendable), tagging the tx with an
  // on-chain `memo` so the burn is provably tied to its wave. WDK signs+broadcasts.
  async burn(amount, memo) {
    let tx = await this.#buildTransfer(BURN_ADDRESS, amount);
    if (memo) {
      tx = await this.#tronweb.transactionBuilder.addUpdateData(
        tx,
        memo,
        'utf8'
      );
    }
    const res = await this.#account.sendTransaction(tx);
    this.#log(
      'burned',
      amount,
      'USDT 🔥 hash',
      res.hash,
      memo ? `memo=${memo}` : ''
    );
    return { hash: res.hash, fee: res.fee };
  }

  // Build (unsigned) a TRC-20 transfer(recipient, amount) on the USDT contract WITH a feeLimit (a
  // contract call needs one or it fails out-of-energy). Used only by burn(), which then attaches
  // the memo (addUpdateData) — the reason it hand-builds instead of WDK's memo-less transfer().
  async #buildTransfer(recipient, amount) {
    const { transaction } =
      await this.#tronweb.transactionBuilder.triggerSmartContract(
        this.#usdtContract,
        'transfer(address,uint256)',
        { feeLimit: TRC20_FEE_LIMIT_SUN },
        [
          { type: 'address', value: recipient },
          { type: 'uint256', value: toSun(amount).toString() }
        ],
        this.address
      );
    return transaction;
  }

  // Verify (on-chain) that `txHash` is a USDT burn matching expectations — the anti-spam gate. A
  // TRC-20 burn is a TriggerSmartContract calling transfer(black_hole, amount) on the USDT contract;
  // decode the ABI call data (selector + padded recipient + amount) and check the memo. Returns
  // { ok, reason }; missing tx / RPC error → { ok: false } (fail closed).
  async verifyBurnTx(txHash, expect = {}) {
    try {
      const tx = await this.#tronweb.trx.getTransaction(txHash);
      const contract = tx?.raw_data?.contract?.[0];
      if (contract?.type !== 'TriggerSmartContract') {
        return { ok: false, reason: 'not-found-or-not-trigger' };
      }
      const value = contract.parameter.value;
      const usdtHex = this.#tronweb.address
        .toHex(this.#usdtContract)
        .toLowerCase();
      if ((value.contract_address || '').toLowerCase() !== usdtHex) {
        return { ok: false, reason: 'wrong-contract' };
      }
      const data = value.data || '';
      if (data.slice(0, 8).toLowerCase() !== TRANSFER_SELECTOR) {
        return { ok: false, reason: 'not-a-transfer' };
      }
      // transfer(address,uint256): [selector 4B][to 32B (addr in last 20B)][amount 32B]
      const toHex = ('41' + data.slice(32, 72)).toLowerCase(); // 0x41 + 20-byte address
      const burnHex = this.#tronweb.address.toHex(BURN_ADDRESS).toLowerCase();
      if (toHex !== burnHex) {
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
        BigInt('0x' + data.slice(72, 136)) < toSun(expect.minTrx)
      ) {
        return { ok: false, reason: 'amount-too-low' };
      }
      // Memo is `hyperwave:<waveId>:<peerId>` on the tx's raw_data.data (not the contract call data).
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

  // Recent USDT (TRC-20) transfers for this wallet, newest first — reads TronGrid's v1 trc20
  // transactions API scoped to the USDT contract. Normalized like the native path. [] on error.
  async transactions(limit = 10) {
    try {
      const res = await this.#tronweb.fullNode.request(
        `v1/accounts/${this.address}/transactions/trc20?limit=${limit}&contract_address=${this.#usdtContract}&only_confirmed=true`,
        {},
        'get'
      );
      const myAddr = this.address.toLowerCase();
      const out = [];
      for (const tx of (res && res.data) || []) {
        out.push({
          hash: tx.transaction_id,
          direction: (tx.from || '').toLowerCase() === myAddr ? 'out' : 'in',
          amount: fromSun(tx.value || 0),
          from: tx.from || '',
          to: tx.to || '',
          timestamp: tx.block_timestamp || 0,
          memo: '' // the trc20 endpoint doesn't surface the tx memo
        });
      }
      return out;
    } catch (err) {
      this.#log('trc20 transactions fetch failed:', err.message);
      return [];
    }
  }
}

/**
 * Create a self-custodial Tron USDT (TRC-20) wallet — an alternative to the native-TRX default. An
 * app opts into USDT by injecting this into the engine: `createEngine({ deps: { createPayments:
 * (opts) => createTronUsdtWallet({ ...opts, usdtContract }) } })`. Shares the seed/account with the
 * native wallet (same `wallet.seed`), so the same address holds both TRX (gas) and USDT.
 * @param {Object} options - Wallet options.
 * @param {string} options.storageDir - Directory holding the persisted `wallet.seed` file.
 * @param {string} options.usdtContract - The USDT TRC-20 contract address (base58) — REQUIRED (the
 *   Nile testnet USDT you faucet-funded; there is no safe default).
 * @param {string} [options.seed] - Injected seed phrase.
 * @param {string} [options.network] - Tron network name (`nile` default, `mainnet` opt-in) —
 *   selects the RPC provider AND the wire type (`tron-usdt-<network>`). Note the mainnet USDT
 *   contract differs from Nile's — pass the matching `usdtContract`.
 * @param {string} [options.provider] - Tron JSON-RPC provider URL (overrides the network default).
 * @param {number} [options.fee] - Participation fee in whole USDT (default FEE_USDT).
 * @param {(...args: any[]) => void} [options.log] - Logger.
 * @returns {Promise<TronUsdtWallet>} The ready wallet.
 */
async function createTronUsdtWallet({ usdtContract, ...options } = {}) {
  if (!usdtContract) {
    throw new Error('createTronUsdtWallet requires a `usdtContract` address');
  }
  // `fee` is a wallet-construction option (initTronAccount ignores it) — thread it explicitly.
  const deps = await initTronAccount(options);
  return new TronUsdtWallet({ ...deps, usdtContract, fee: options.fee });
}

module.exports = {
  TronUsdtWallet,
  createTronUsdtWallet,
  tronUsdtWalletType,
  TRON_USDT_WALLET_TYPE,
  FEE_USDT
};
