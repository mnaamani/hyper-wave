// The participation-fee flows the engine hosts (the GUI worker + the headless harness) compose
// over ANY `Wallet` (wallet.js) — wallet-agnostic: these only call the Wallet interface
// (`fee`/`burn`/`verifyBurnTx`/`address`/`type`) + the wave handle (`recordBurn`/`setWallet`).
// One home for the on-chain memo format + the confirmation poll, so a drift between hosts can't
// silently break verification. Hosts do their own reporting (IPC toast vs console).

// On-chain read-back poll (confirmBurn): getTransaction reflects a broadcast tx within seconds on
// Nile, but allow for lag. Total budget must stay under wave.js PAY_TIMEOUT_MS.
const CONFIRM_ATTEMPTS = 12;
const CONFIRM_INTERVAL_MS = 2500;

/**
 * The memo that provably ties a burn to its wave + payer (protocol.md §9.2).
 * @param {string} waveId - The wave the burn is for.
 * @param {string} peerId - Hex id of the paying peer.
 * @returns {string} The on-chain memo string `hyperwave:<waveId>:<peerId>`.
 */
function burnMemo(waveId, peerId) {
  return `hyperwave:${waveId}:${peerId}`;
}

/**
 * Burn the participation fee for `waveId` and sign the ring attestation. Returns
 * { hash, proof }; throws if the burn fails. `proof` is the start gate credential for the
 * initiator (announcePaid); a joiner's burn is its own anti-spam cost and ignores `proof`.
 * @param {Object} opts The fee to burn.
 * @param {Object} opts.wave - The createWave engine handle (provides `me.id` and `recordBurn`).
 * @param {import('./wallet').Wallet} opts.payments - The wallet (provides `fee` + `burn`).
 * @param {string} opts.waveId - The wave the fee is being burned for.
 * @param {string} opts.reason - Fee reason, e.g. `'start'` or `'join'`.
 * @returns {Promise<{hash: string, proof: Object}>} The burn tx hash and the signed burn proof.
 */
async function payFee({ wave, payments, waveId, reason }) {
  const fee = payments.fee; // the wallet owns its fee amount (not a hardcoded engine constant)
  const { hash } = await payments.burn(fee, burnMemo(waveId, wave.me.id));
  // pass waveId so the attestation records even if the (instant) wave already ended — it's the
  // the entry's tip-address binding even when it confirms late (wave.js recordBurn).
  const proof = wave.recordBurn({
    reason,
    amount: fee,
    txHash: hash,
    waveId
  });
  return { hash, proof };
}

/**
 * Wait (bounded) until the burn is readable on-chain, so peers' single verify check
 * succeeds the moment the wave is announced. Resolves true when confirmed.
 * @param {import('./wallet').Wallet} payments - The wallet (provides `verifyBurnTx`).
 * @param {string} waveId - The wave whose burn memo is expected on-chain.
 * @param {string} hash - The burn tx hash to poll for.
 * @returns {Promise<boolean>} True once the burn is confirmed on-chain, false if it never confirms.
 */
async function confirmBurn(payments, waveId, hash) {
  for (let i = 0; i < CONFIRM_ATTEMPTS; i++) {
    const result = await payments.verifyBurnTx(hash, {
      waveId,
      from: payments.address,
      minTrx: payments.fee
    });
    if (result.ok) {
      return true;
    }
    await new Promise((res) => setTimeout(res, CONFIRM_INTERVAL_MS));
  }
  return false;
}

/**
 * Wire a ready wallet into the engine: my address (feed tips / attestations), the on-chain burn
 * verifier (enables the paid-wave anti-spam gate), and the wallet TYPE (put on the wire so joiners
 * can decide whether they support this wave's payment mechanism).
 * @param {Object} wave - The createWave engine handle (provides `setWallet`).
 * @param {import('./wallet').Wallet} payments - Any Wallet (address + `verifyBurnTx` + `type`).
 * @returns {void}
 */
function wireWallet(wave, payments) {
  wave.setWallet(
    payments.address,
    (txHash, expect) => payments.verifyBurnTx(txHash, expect),
    payments.type
  );
}

module.exports = { burnMemo, payFee, confirmBurn, wireWallet };
