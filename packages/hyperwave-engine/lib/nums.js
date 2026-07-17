// The NUMS ("nothing-up-my-sleeve") burn pubkey — the Cashu analog of Tron's
// black-hole address. A secp256k1 point derived deterministically from a fixed
// domain string by hashing to a candidate x-coordinate and lifting to the curve
// (retrying a counter until a valid point). Because the point comes from a hash
// preimage, no private key is known or derivable, so ecash P2PK-locked to it is
// irrecoverable = burned. Every peer derives the identical key, so an auditor
// checks a burn is "to the black hole" by comparing against this one value.
// De-risked in spike/cashu/. CJS (dynamic import() of ESM @noble); memoized —
// the derivation is fixed, so it's computed once per process.
const b4a = require('b4a');

// The domain the burn key commits to. FROZEN — changing it changes the burn
// address, so every peer must derive the same string. (protocol.md payments §)
const NUMS_DOMAIN = 'hyperwave:burn:v1';

let cached = null;

/**
 * Derive (once) the canonical NUMS burn pubkey: `{ pubkey, counter, domain }`
 * where `pubkey` is the 33-byte compressed secp256k1 point (hex).
 * @returns {Promise<{pubkey: string, counter: number, domain: string}>} The burn key.
 */
async function numsBurnPubkey() {
  if (cached) {
    return cached;
  }
  const { secp256k1 } = await import('@noble/curves/secp256k1.js');
  const { sha256 } = await import('@noble/hashes/sha2.js');
  for (let counter = 0; counter < 1024; counter++) {
    const preimage = new Uint8Array(b4a.from(`${NUMS_DOMAIN}:${counter}`));
    const xBytes = sha256(preimage);
    const hex = liftToCurve(secp256k1, xBytes);
    if (hex) {
      cached = { pubkey: hex, counter, domain: NUMS_DOMAIN };
      return cached;
    }
  }
  throw new Error('no NUMS point found (astronomically unlikely)');
}

// Try both compressed-point prefixes (0x02/0x03) for this x-coordinate; return
// the first that is a valid curve point (hex), or null. fromBytes validates.
function liftToCurve(secp256k1, xBytes) {
  const prefixes = [0x02, 0x03];
  for (const prefix of prefixes) {
    const candidate = new Uint8Array(33);
    candidate[0] = prefix;
    candidate.set(xBytes, 1);
    try {
      secp256k1.Point.fromBytes(candidate);
      return b4a.toString(b4a.from(candidate), 'hex');
    } catch {
      // Not on the curve for this prefix — try the next.
    }
  }
  return null;
}

module.exports = { numsBurnPubkey, NUMS_DOMAIN };
