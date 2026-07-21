// The pluggable payment interface. The engine talks to payments ONLY through this abstract
// `Wallet` base class, so any conforming implementation can be injected (createEngine
// `deps.createPayments`) — an app can bring its own payment mechanism (a different chain, a
// custodial service, a mock). Each wallet declares a `type` (e.g. 'tron-nile') that travels on
// the wire (wave-announce/start/sync), so a joiner can decide whether it supports a wave's
// payment mechanism before opting in (wave.js join gate). Amounts are in the wallet's own units.
//
// The default implementation is `TronWallet` (tron-wallet.js); the wallet-agnostic fee flows the
// engine composes over any Wallet are in payments.js.

/**
 * The payment interface the engine depends on. A concrete wallet extends this; the engine and the
 * fee flows (payments.js) call ONLY these members, so any conforming implementation is pluggable.
 * @abstract
 */
class Wallet {
  /**
   * The payment-mechanism type id, put on the wire (wave-announce/start/sync) so peers can decide
   * whether they support a wave's payments before joining. Distinct implementations use distinct
   * types (e.g. 'tron-nile', 'btc'); a peer only joins a wave whose type its own wallet matches.
   * @returns {string} The wallet type id.
   */
  get type() {
    throw new Error('Wallet#type not implemented');
  }

  /**
   * The currency unit label for this wallet's amounts (e.g. 'TRX', 'USDT',
   * 'sat'), so a host can render/annotate amounts without knowing the mechanism.
   * @returns {string} The unit label.
   */
  get unit() {
    return 'native';
  }

  /**
   * The participation fee, in this wallet's native units, burned on start + join.
   * @returns {number} The fee amount.
   */
  get fee() {
    throw new Error('Wallet#fee not implemented');
  }

  /**
   * This wallet's receive address (for feed tips + attestation binding).
   * @returns {string} The address.
   */
  get address() {
    throw new Error('Wallet#address not implemented');
  }

  /**
   * Which account (BIP-44 index) of the shared seed this wallet is. A multi-account wallet derives
   * a distinct address per index; a single-account wallet is always 0. Default 0.
   * @returns {number} The account index.
   */
  get accountIndex() {
    return 0;
  }

  /**
   * Derive the first `count` accounts from the same seed (offline) — `{index, address}` per BIP-44
   * account index — so a host can present an account picker. Default: just this one account (a
   * single-account wallet); a multi-account wallet (e.g. TronWallet) overrides to derive `count`.
   * @param {number} [_count] - How many accounts to derive (ignored by a single-account wallet).
   * @returns {Promise<Array<{index: number, address: string}>>} The accounts.
   */
  async accounts(_count = 1) {
    return [{ index: this.accountIndex, address: this.address }];
  }

  /**
   * Fetch the spendable balance (network call, or a local proof sum for ecash).
   * @returns {Promise<{address: string, amount: number, unit: string}>} The
   *   address + spendable amount + its unit label.
   */
  async balances() {
    throw new Error('Wallet#balances not implemented');
  }

  /**
   * Send `amount` (native units) to an address; resolves the tx hash (+ fee if known).
   * @param {string} recipient - The destination address.
   * @param {number} amount - The amount in native units.
   * @returns {Promise<{hash: string, fee?: number}>} The tx hash.
   */
  async send(recipient, amount) {
    throw new Error('Wallet#send not implemented');
  }

  /**
   * Burn `amount` (an irrecoverable/unspendable payment — the participation fee), tagging the tx
   * with an on-chain `memo` so the burn is provably tied to its wave.
   * @param {number} amount - The amount to burn in native units.
   * @param {string} [memo] - The on-chain memo.
   * @returns {Promise<{hash: string, fee?: number}>} The burn tx hash.
   */
  async burn(amount, memo) {
    throw new Error('Wallet#burn not implemented');
  }

  /**
   * Verify that `burnRef` is a burn matching `expect` (fails closed on missing burn / error).
   * `burnRef` is the mechanism's burn reference — a chain tx hash, an ecash token, etc.
   * Set `transient: true` when the check couldn't be COMPLETED (e.g. the backing mint/chain was
   * unreachable) as opposed to a definitive invalid burn — the engine retries transient failures
   * rather than rejecting the wave. Omit it (definitive) for a structural / spent / mismatch fail.
   * @param {string} burnRef - The burn reference to verify.
   * @param {{waveId?: string, from?: string, minAmount?: number}} [expect] - Expected fields.
   * @returns {Promise<{ok: boolean, reason?: string, transient?: boolean}>} Whether it verifies.
   */
  async verifyBurnTx(burnRef, expect) {
    throw new Error('Wallet#verifyBurnTx not implemented');
  }

  /**
   * Recent transactions, newest first (normalized; [] on error).
   * @param {number} [limit] - Max to return.
   * @returns {Promise<Object[]>} The transactions.
   */
  async transactions(limit) {
    throw new Error('Wallet#transactions not implemented');
  }

  /** Release any underlying resources. Default no-op. */
  dispose() {}
}

module.exports = { Wallet };
