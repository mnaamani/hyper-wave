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
 * @param {Object} opts.wave - The createWave engine handle (`me.id`, `recordBurn`, `feeFor`).
 * @param {import('./wallet').Wallet} opts.payments - The wallet (provides `fee` + `burn`).
 * @param {string} opts.waveId - The wave the fee is being burned for.
 * @param {string} opts.reason - Fee reason, e.g. `'start'` or `'join'`.
 * @returns {Promise<{hash: string, proof: Object, fee: number}>} The burn tx hash, the signed burn
 *   proof, and the amount actually burned.
 */
async function payFee({ wave, payments, waveId, reason }) {
  // Burn the wave's ANNOUNCED fee (set by its initiator) so every participant pays the same amount.
  // For a wave I initiate, feeFor returns my own wallet fee (I set it); fall back to the wallet fee
  // when a wave carries no announced fee (wallet-less/unpaid shape).
  const fee = wave.feeFor(waveId) ?? payments.fee;
  const { hash } = await payments.burn(fee, burnMemo(waveId, wave.me.id));
  // pass waveId so the attestation records even if the (instant) wave already ended — it's the
  // the entry's tip-address binding even when it confirms late (wave.js recordBurn).
  const proof = wave.recordBurn({
    reason,
    amount: fee,
    burnRef: hash,
    waveId
  });
  return { hash, proof, fee };
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
      minAmount: payments.fee
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
 * verifier (enables the paid-wave anti-spam gate), the wallet TYPE (put on the wire so joiners can
 * decide whether they support this wave's payment mechanism), and my FEE (the amount I set on the
 * waves I initiate — rides their announces so every joiner burns the same).
 * @param {Object} wave - The createWave engine handle (provides `setWallet`).
 * @param {import('./wallet').Wallet} payments - Any Wallet (address + `verifyBurnTx` + `type` + `fee`).
 * @returns {void}
 */
function wireWallet(wave, payments) {
  wave.setWallet(
    payments.address,
    (burnRef, expect) => payments.verifyBurnTx(burnRef, expect),
    payments.type,
    payments.fee // the fee I SET on the waves I initiate (rides their announces)
  );
}

module.exports = { burnMemo, payFee, confirmBurn, wireWallet };
