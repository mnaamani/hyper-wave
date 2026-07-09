// Participation-fee flows shared by the two engine hosts — the GUI worker
// (workers/hyperwave.js) and the headless harness (wave.run.js). One home for the
// fee amount and the on-chain memo format: pay.verifyBurnTx matches the memo against
// the waveId, so a format drift between hosts would silently break verification.
// Hosts compose these and do their own reporting (IPC toast vs console).

const FEE_TRX = 1 // kick-off/join fee, burned to the black hole (pay.BURN_ADDRESS)
// On-chain read-back poll (confirmBurn): getTransaction reflects a broadcast tx within
// seconds on Nile, but allow for lag. Total budget must stay under wave.js PAY_TIMEOUT_MS.
const CONFIRM_ATTEMPTS = 12
const CONFIRM_INTERVAL_MS = 2500

// The memo that provably ties a burn to its wave + payer (protocol.md §9.2).
function burnMemo(waveId, peerId) {
  return `hyperwave:${waveId}:${peerId}`
}

// Burn the participation fee for `waveId` and sign the ring attestation. Returns
// { hash, proof }; throws if the burn fails. `proof` is the kick-off gate credential for the
// initiator (announcePaid); a joiner's burn is its own anti-spam cost and ignores `proof`.
async function payFee(wave, payments, waveId, reason) {
  const { hash } = await payments.burn(FEE_TRX, burnMemo(waveId, wave.me.id))
  // pass waveId so the attestation records even if the (instant) wave already ended — it's the
  // ticket for a late gallery admission into the persisted gallery (wave.js recordBurn).
  const proof = wave.recordBurn({ reason, amount: FEE_TRX, txHash: hash, waveId })
  return { hash, proof }
}

// Wait (bounded) until the burn is readable on-chain, so peers' single verify check
// succeeds the moment the wave is announced. Resolves true when confirmed.
async function confirmBurn(payments, waveId, hash) {
  for (let i = 0; i < CONFIRM_ATTEMPTS; i++) {
    const r = await payments.verifyBurnTx(hash, {
      waveId,
      from: payments.address,
      minTrx: FEE_TRX
    })
    if (r.ok) return true
    await new Promise((res) => setTimeout(res, CONFIRM_INTERVAL_MS))
  }
  return false
}

// Wire a ready wallet into the engine: my address (gallery tips / attestations) and the on-chain
// burn verifier (enables the paid-wave anti-spam gate).
function wireWallet(wave, payments) {
  wave.setWallet(payments.address, (txHash, expect) => payments.verifyBurnTx(txHash, expect))
}

module.exports = { FEE_TRX, payFee, confirmBurn, wireWallet }
