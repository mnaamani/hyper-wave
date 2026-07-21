// Shared, tiny source of truth for the active wallet's mechanism + unit, set
// from each worker `wallet` message and read across the UI (toasts, the tip
// button, the lobby fee) so amounts are labelled in the wallet's real unit
// (sat for Cashu, TRX/USDT for Tron) instead of a hardcoded currency. The
// desktop default is Cashu; a Tron build (or a live switch) updates these.
let unit = 'sat';
let walletType = 'cashu';
let mint = '';

/**
 * Update the active wallet metadata from a worker `wallet` message.
 * @param {{unit?: string, walletType?: string, mint?: string}} meta - The message.
 * @returns {void}
 */
export function setWalletMeta(meta = {}) {
  if (meta.unit) {
    unit = meta.unit;
  }
  if (meta.walletType) {
    walletType = meta.walletType;
  }
  if (typeof meta.mint === 'string') {
    mint = meta.mint;
  }
}

/**
 * The active currency unit label. Pass an `amount` to get the correctly
 * pluralized form — only 'sat' inflects (1 sat / 5 sats); TRX/USDT don't.
 * @param {number} [amount] - Amount, to choose singular vs plural.
 * @returns {string} The unit label (e.g. 'sat', 'sats', 'TRX').
 */
export function unitLabel(amount) {
  if (unit === 'sat' && amount !== undefined && amount !== 1) {
    return 'sats';
  }
  return unit;
}

/** @returns {boolean} Whether the active wallet is a Cashu (ecash) wallet. */
export function isCashu() {
  return walletType === 'cashu';
}

/** @returns {string} The active mint URL (Cashu), or '' for a chain wallet. */
export function activeMint() {
  return mint;
}
