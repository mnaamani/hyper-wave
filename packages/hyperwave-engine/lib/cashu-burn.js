// Pure structural verification of a Cashu burn — the offline half of
// CashuWallet.verifyBurnTx (the network half is decode-via-mint + NUT-07
// checkstate, in cashu-wallet.js). Separated out so the structural gate is
// unit-testable without a mint (mirrors feed.js/sweep.js: pure logic, no I/O).
// A "burn" is ecash P2PK-locked to the canonical NUMS pubkey (nums.js), tagged
// with the seat memo `hyperwave:<waveId>:<peerId>` (payments.js burnMemo).
//
// Note on `from`: ecash is anonymous — a burn token does NOT record who created
// it, so (unlike Tron's owner_address) the payer can't be checked here. The
// payer binding comes from the memo (which commits the ring peerId) plus the
// ring-key burn attestation (attest.js), which a relay can't forge. So this
// verifier ignores `expect.from` and binds the burn to its wave via the memo.

// The NUT-11 tag key carrying the seat memo inside the locking secret.
const MEMO_TAG_KEY = 'hyperwave';

/**
 * Structurally verify decoded burn proofs (no network). Every proof must be
 * P2PK-locked to `numsPubkey` and tagged with a memo committing `expect.waveId`,
 * and the total must be ≥ `expect.minAmount`.
 * @param {Object} opts
 * @param {Array<{amount: number, secret: string}>} opts.proofs - Decoded proofs.
 * @param {string} opts.numsPubkey - The canonical NUMS burn pubkey (hex).
 * @param {{waveId?: string, minAmount?: number}} [opts.expect] - Expected fields.
 * @param {Object} opts.cashu - The cashu-ts module (pure helpers: sumProofs,
 *   getSecretKind, parseP2PKSecret, getSecretData).
 * @returns {{ok: boolean, reason?: string}} Whether the proofs are a valid burn.
 */
function verifyBurnProofs({ proofs, numsPubkey, expect = {}, cashu }) {
  if (!Array.isArray(proofs) || proofs.length === 0) {
    return { ok: false, reason: 'no-proofs' };
  }
  const total = Number(cashu.sumProofs(proofs));
  if (expect.minAmount !== undefined && total < expect.minAmount) {
    return { ok: false, reason: 'amount-too-low' };
  }
  for (const proof of proofs) {
    if (cashu.getSecretKind(proof.secret) !== 'P2PK') {
      return { ok: false, reason: 'not-p2pk' };
    }
    const data = cashu.getSecretData(cashu.parseP2PKSecret(proof.secret));
    if (data.data !== numsPubkey) {
      return { ok: false, reason: 'not-burned' };
    }
    const memoTag = (data.tags || []).find((tag) => tag[0] === MEMO_TAG_KEY);
    const memo = memoTag && memoTag[1];
    if (expect.waveId && (!memo || !memo.includes(expect.waveId))) {
      return { ok: false, reason: 'memo-mismatch' };
    }
  }
  return { ok: true };
}

/**
 * The NUT-11 additionalTags array that carries a seat memo into a locking secret.
 * @param {string} memo - The seat memo (`hyperwave:<waveId>:<peerId>`).
 * @returns {string[][]} The tags array for cashu-ts asP2PK({ additionalTags }).
 */
function burnTags(memo) {
  return [[MEMO_TAG_KEY, memo]];
}

module.exports = { verifyBurnProofs, burnTags, MEMO_TAG_KEY };
