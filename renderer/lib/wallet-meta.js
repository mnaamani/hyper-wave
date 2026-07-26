// Module-global convenience for the renderer's views: the active Cashu wallet's unit, mint, and
// settlement network, set from each worker `wallet` message and read across the UI (toasts, the tip
// button, the lobby fee, the same-network filter). The desktop's only payment mechanism is Cashu
// (unit `sat`).
//
// The RULES live in hyperwave-app-core (shared with the mobile host); this file is only the
// renderer's ambient holder of the current values, so a view can read them without threading a
// snapshot through every call.
import {
  unitLabelFor,
  networksMatch
} from '../../node_modules/hyperwave-app-core/lib/wallet-meta.js';

let unit = 'sat';
let mint = '';
let network = ''; // the active wallet's settlement network ('testnet'/'mainnet'), '' if unknown/none

/**
 * Update the active wallet metadata from a worker `wallet` message.
 * @param {{unit?: string, mint?: string, network?: string}} meta - The message.
 * @returns {void}
 */
export function setWalletMeta(meta = {}) {
  if (meta.unit) {
    unit = meta.unit;
  }
  if (typeof meta.mint === 'string') {
    mint = meta.mint;
  }
  if (typeof meta.network === 'string') {
    network = meta.network;
  }
}

/**
 * The active currency unit label. Pass an `amount` to get the correctly
 * pluralized form — 'sat' inflects (1 sat / 5 sats).
 * @param {number} [amount] - Amount, to choose singular vs plural.
 * @returns {string} The unit label (e.g. 'sat', 'sats').
 */
export function unitLabel(amount) {
  return unitLabelFor(unit, amount);
}

/** @returns {string} The active mint URL. */
export function activeMint() {
  return mint;
}

/**
 * @returns {string} The active wallet's settlement network ('testnet'/'mainnet'),
 * or '' if it isn't known yet.
 */
export function activeNetwork() {
  return network;
}

/**
 * Whether a wave on `waveNetwork` can transact with the active wallet — i.e. NOT
 * a known cross-network mismatch. Permissive: an empty/unknown network on either
 * side is allowed (mirrors the worker's `crossNetworkMints`), so only a known
 * test-vs-main mismatch is excluded. Used to hide cross-network waves + block
 * cross-network tips (which would be meaningless).
 * @param {string} [waveNetwork] - The wave's settlement network.
 * @returns {boolean} Whether the wave matches the active wallet's network.
 */
export function networkMatches(waveNetwork) {
  return networksMatch(network, waveNetwork);
}
