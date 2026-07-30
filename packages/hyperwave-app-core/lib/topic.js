// App policy, shared by both hosts: which DIRECTORY TOPIC a peer sits on, given its wallet's
// settlement network. The ENGINE is network-agnostic — it exposes a generic `set-topic` command
// and never decides this. We keep mainnet (real sats) and testnet (test ecash) peers in SEPARATE
// directories — a first, coarse separation in front of the per-burn cross-network filter — so they
// never even discover each other. Testnet / unknown / wallet-less stay on the base topic.

/**
 * The directory topic for a wallet network.
 * @param {Object} options - Options.
 * @param {string} options.baseTopic - The app's base topic id.
 * @param {string} [options.network] - The wallet's settlement network.
 * @returns {string} The topic id to sit on.
 */
export function topicForNetwork({ baseTopic, network }) {
  if (network === 'mainnet') {
    return baseTopic + ':mainnet';
  }
  return baseTopic;
}
