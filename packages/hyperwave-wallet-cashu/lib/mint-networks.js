// Mint → settlement-network classification, and the canonical curated mint list.
// Cashu carries no cryptographic network tag (a proof denominated in `sat` looks
// identical whether the mint settles on real Lightning or a free auto-paying TEST
// mint), so whether a wallet holds real money or fake test money is knowable only
// from WHICH mint it is. This module is the SINGLE SOURCE OF TRUTH for the mints
// this package knows and their network. The Bare worker uses it natively (the
// paid-gate cross-network filter). The sandboxed file:// renderer can't require a
// CJS package, so rather than duplicate the list there, the wallet exposes its
// known mints (get knownMints) and the host RELAYS them to the UI (the engine's
// `wallet` message → the renderer's mint picker). One list → the picker's label
// and the filter's classification can never drift.
//
// How the filter uses it: a Cashu burn token carries its own mint URL
// (getTokenMetadata().mint), so the paid-gate verifier classifies the burn's mint
// and refuses a wave settling on a DIFFERENT network than the local wallet's own
// mint — a testnet peer never joins (and burns/tips on) a mainnet wave, or vice
// versa. `walletType` stays the generic `cashu` (any mint on the same network
// still interoperates); the network split is enforced here, from mint identity.
//
// Extensibility: an APP can add its OWN mints via the `extraMints` argument
// (`[{ url, label, network }]`), supplied ONCE at the host as the wallet's
// `knownMints` option — it feeds both the filter (classified against here) and the
// picker (relayed from the wallet's `knownMints`), so an app-added mint is
// consistent in both. Unknown mints (not listed, no `testnut`/`testnet` marker)
// classify as 'unknown' and are treated PERMISSIVELY (never the basis for a
// cross-network rejection), so a custom mint is never wrongly excluded.

/**
 * A curated mint: its URL, a human label (for a picker), and its network.
 * @typedef {Object} KnownMint
 * @property {string} url - The mint URL.
 * @property {string} label - Human-readable label (for the desktop mint picker).
 * @property {'testnet' | 'mainnet'} network - The settlement network.
 */

/**
 * The curated mints this package ships. The DEFAULT (first) is the free `testnut`
 * TEST mint (auto-pays quotes, no real Lightning — play money). The two ⚠ mints
 * are real, reputable, Lightning-connected MAINNET mints (verified via /v1/info:
 * bolt11 mint+melt, NUT-07/11/12); selecting one means REAL sats. They're the
 * only way to actually settle cross-mint tips (`consolidate`), which fake mints
 * can't do — clearly labelled, never the default.
 * @type {KnownMint[]}
 */
const KNOWN_MINTS = [
  {
    url: 'https://testnut.cashu.space',
    label: 'testnut (test · auto-pay)',
    network: 'testnet'
  },
  {
    url: 'https://nofee.testnut.cashu.space',
    label: 'testnut · no fees',
    network: 'testnet'
  },
  {
    url: 'https://mint.minibits.cash/Bitcoin',
    label: '⚠ Minibits — mainnet · REAL sats',
    network: 'mainnet'
  },
  {
    url: 'https://mint.coinos.io',
    label: '⚠ Coinos — mainnet · REAL sats',
    network: 'mainnet'
  }
];

// The host part of a mint URL (scheme + path stripped, lower-cased), or '' if
// unparseable. String-only — no URL parser (unavailable in some Bare hosts).
function hostOf(mintUrl) {
  return String(mintUrl || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0];
}

/**
 * Classify a mint URL's settlement network against the known list (plus any
 * app-supplied `extraMints`), falling back to a `testnut`/`testnet` heuristic.
 * @param {string} mintUrl - The mint URL (as carried in a burn token / config).
 * @param {KnownMint[]} [extraMints] - App-added mints to classify against too.
 * @returns {'testnet' | 'mainnet' | 'unknown'} The network, or 'unknown'.
 */
function networkOfMint(mintUrl, extraMints = []) {
  const host = hostOf(mintUrl);
  if (!host) {
    return 'unknown';
  }
  const all = KNOWN_MINTS.concat(extraMints || []);
  for (const mint of all) {
    if (mint && mint.network && hostOf(mint.url) === host) {
      return mint.network;
    }
  }
  // Heuristic for testnut subdomains / any mint self-labelling as testnet.
  if (host.includes('testnut') || host.includes('testnet')) {
    return 'testnet';
  }
  return 'unknown';
}

/**
 * Are two mints DEFINITIVELY on different networks? True only when BOTH classify
 * to a known-but-different network (test vs main) — an 'unknown' mint is never a
 * cross-network mismatch (permissive: we exclude only networks we can identify).
 * @param {string} mintA - One mint URL.
 * @param {string} mintB - The other mint URL.
 * @param {KnownMint[]} [extraMints] - App-added mints to classify against too.
 * @returns {boolean} Whether the two mints settle on different, known networks.
 */
function crossNetworkMints(mintA, mintB, extraMints = []) {
  const networkA = networkOfMint(mintA, extraMints);
  const networkB = networkOfMint(mintB, extraMints);
  if (networkA === 'unknown' || networkB === 'unknown') {
    return false;
  }
  return networkA !== networkB;
}

module.exports = {
  KNOWN_MINTS,
  networkOfMint,
  crossNetworkMints
};
