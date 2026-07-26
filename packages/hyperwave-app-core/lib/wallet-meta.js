// Pure helpers over the active wallet's metadata (unit / mint / settlement network), shared by
// both hosts. They are pure functions of an explicit meta argument — the app core holds the live
// meta in its snapshot, and a host that wants module-global convenience (the desktop renderer's
// wallet-meta.js) wraps these.

/**
 * The active currency unit label. Pass an `amount` for the correctly pluralized form — 'sat'
 * inflects (1 sat / 5 sats).
 * @param {string} unit - The wallet's unit (e.g. 'sat').
 * @param {number} [amount] - Amount, to choose singular vs plural.
 * @returns {string} The unit label.
 */
export function unitLabelFor(unit, amount) {
  if (unit === 'sat' && amount !== undefined && amount !== 1) {
    return 'sats';
  }
  return unit;
}

/**
 * Whether a wave on `waveNetwork` can transact with a wallet on `walletNetwork` — i.e. NOT a known
 * cross-network mismatch. Permissive: an empty/unknown network on either side is allowed (mirroring
 * the wallet's own `crossNetworkMints` rule), so only a known test-vs-main mismatch is excluded.
 * Used to hide cross-network waves and block cross-network tips, which would be meaningless.
 * @param {string} [walletNetwork] - The active wallet's settlement network.
 * @param {string} [waveNetwork] - The wave's settlement network.
 * @returns {boolean} Whether the two can transact.
 */
export function networksMatch(walletNetwork, waveNetwork) {
  if (!walletNetwork || walletNetwork === 'unknown') {
    return true; // my own network unknown (custom mint / chain / none) → never filter
  }
  if (!waveNetwork || waveNetwork === 'unknown') {
    return true; // the wave's network is unknown → permissive
  }
  return waveNetwork === walletNetwork;
}

/**
 * Merge an engine `wallet` message into the held metadata. Only fields the message actually
 * carries overwrite — a balance-only refresh must not blank the mint or network.
 * @param {Object} meta - The current metadata.
 * @param {Object} message - An engine `wallet` message.
 * @returns {Object} The merged metadata (a new object).
 */
export function mergeWalletMeta(meta, message = {}) {
  const merged = { ...meta };
  const fields = [
    'unit',
    'mint',
    'network',
    'address',
    'amount',
    'mints',
    'walletType',
    'accountIndex'
  ];
  for (const field of fields) {
    if (message[field] !== undefined) {
      merged[field] = message[field];
    }
  }
  return merged;
}
