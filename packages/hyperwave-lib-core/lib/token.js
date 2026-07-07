// Pure token crypto for the wave race. Ed25519 receipts + a constant-size blake2b
// chain accumulator (docs/protocol.md §2.3 — NOT a growing hops[] array). No state,
// no I/O — unit-tested in wave.token.test.js.
const crypto = require('hypercore-crypto')
const b4a = require('b4a')

const ZERO_HASH = b4a.toString(b4a.alloc(32), 'hex') // genesis accumulator

// A receipt binds a peer to a specific hop: sign(H(waveId|hop|prevChainHash|ts)).
function receiptHash(waveId, hopCount, prevChainHash, timestamp) {
  return crypto.hash(b4a.from(`${waveId}|${hopCount}|${prevChainHash}|${timestamp}`))
}

function signReceipt(keyPair, waveId, hopCount, prevChainHash, timestamp) {
  return b4a.toString(
    crypto.sign(receiptHash(waveId, hopCount, prevChainHash, timestamp), keyPair.secretKey),
    'hex'
  )
}

// Verify a receipt is a valid Ed25519 signature by `peerId` over its hop tuple.
// This authenticates a gallery entry to a peer identity (no impersonation, no
// unsigned spam). NOTE: it does NOT prove the peer actually held the token — a
// peer can self-sign a receipt for a hop it never held. Proof of participation
// (cross-checking against the real token chain) is the validator's job.
function verifyReceipt(peerIdHex, waveId, hopCount, chainHash, timestamp, receiptSigHex) {
  try {
    const h = receiptHash(waveId, hopCount, chainHash, timestamp)
    return crypto.verify(h, b4a.from(receiptSigHex, 'hex'), b4a.from(peerIdHex, 'hex'))
  } catch {
    return false
  }
}

// Verify the receipt the *sender* stamped on the token they forwarded.
function verifyToken(token) {
  return verifyReceipt(
    token.senderPeerId,
    token.waveId,
    token.hopCount,
    token.prevChainHash,
    token.timestamp,
    token.senderReceiptSig
  )
}

// Constant-size rolling accumulator: newHash = blake2b(prevHash || receiptSig).
function advanceChain(prevChainHash, receiptSigHex) {
  return b4a.toString(
    crypto.hash(b4a.concat([b4a.from(prevChainHash, 'hex'), b4a.from(receiptSigHex, 'hex')])),
    'hex'
  )
}

// --- burn attestation ------------------------------------------------------
// Bridges the peer's RING identity (Ed25519) to its on-chain burn: the peer signs, with
// its ring key, a statement binding (waveId, peerId, reason, amount, txHash, tronAddress).
// The Tron key that signed the burn is a *different* keypair, so this ring-key signature is
// what ties the burn to the ring participant. Used for the paid-wave anti-spam gate: the
// initiator's kick-off proof rides `wave-announce`, and peers cross-check its txHash on-chain
// (to==black hole, amount, memo commits waveId) before joining. (§ protocol.md §9)
function burnHash({ waveId, peerId, reason, amount, txHash, tronAddress, burnTs }) {
  return crypto.hash(
    b4a.from(`${waveId}|${peerId}|${reason}|${amount}|${txHash}|${tronAddress}|${burnTs}`)
  )
}

function signBurn(keyPair, fields) {
  return b4a.toString(crypto.sign(burnHash(fields), keyPair.secretKey), 'hex')
}

// Verify a burn attestation is a valid Ed25519 signature by `fields.peerId` over the tuple.
// Only the burnHash fields are read — callers may pass a whole proof object (an extra `sig`
// key is ignored).
function verifyBurn(fields, sigHex) {
  try {
    return crypto.verify(burnHash(fields), b4a.from(sigHex, 'hex'), b4a.from(fields.peerId, 'hex'))
  } catch {
    return false
  }
}

// Does this burn attestation authorize `peerId` to write to `waveId`'s gallery? Checks the
// signature and that the burn is bound to this exact peer + wave (so a burn can't be replayed
// for another identity or wave). This is the gallery-admission gate: presence in the gallery
// requires a real fee burn, which makes every tippable selfie one from a peer who paid in.
// The on-chain reality of the txHash is verified separately by the admitter (network I/O).
function burnAuthorizes(burn, peerId, waveId) {
  return !!(burn && burn.peerId === peerId && burn.waveId === waveId && verifyBurn(burn, burn.sig))
}

// --- gallery-key attestation -----------------------------------------------
// The wave's gallery Autobase key is chosen by the originator and then travels on unsigned,
// relayed fields (`wave-start`, the token, `wave-sync`). Without a binding, a malicious relay
// could swap the key and point peers at an attacker-controlled gallery. So the originator
// signs (waveId, autobaseKey) with its ring key; every peer verifies the signature against
// the wave's originator before opening the gallery. (Independent of payments — pure integrity.)
function galleryKeyHash(waveId, autobaseKey) {
  return crypto.hash(b4a.from(`gallery-key|${waveId}|${autobaseKey}`))
}

function signGalleryKey(keyPair, waveId, autobaseKey) {
  return b4a.toString(crypto.sign(galleryKeyHash(waveId, autobaseKey), keyPair.secretKey), 'hex')
}

// Verify the gallery key is the one the wave's `originatorHex` published for `waveId`.
function verifyGalleryKey(originatorHex, waveId, autobaseKey, sigHex) {
  try {
    return crypto.verify(
      galleryKeyHash(waveId, autobaseKey),
      b4a.from(sigHex, 'hex'),
      b4a.from(originatorHex, 'hex')
    )
  } catch {
    return false
  }
}

// --- wave-end completion attestation ---------------------------------------
// A completed wave is announced by its ORIGINATOR flooding a `wave-end`. Because a flood
// message can be forged by any peer, the originator signs the completion with its ring key
// so receivers can't be tricked into ending a wave that didn't really finish. Binds
// (waveId, hops, chainHash) to the originator identity.
function waveEndHash(waveId, hops, chainHash) {
  return crypto.hash(b4a.from(`wave-end|${waveId}|${hops}|${chainHash}`))
}

function signWaveEnd(keyPair, waveId, hops, chainHash) {
  return b4a.toString(crypto.sign(waveEndHash(waveId, hops, chainHash), keyPair.secretKey), 'hex')
}

// Verify a completion is validly signed by `originatorHex` over its (waveId, hops, chainHash).
function verifyWaveEnd(originatorHex, waveId, hops, chainHash, sigHex) {
  try {
    return crypto.verify(
      waveEndHash(waveId, hops, chainHash),
      b4a.from(sigHex, 'hex'),
      b4a.from(originatorHex, 'hex')
    )
  } catch {
    return false
  }
}

// --- raffle: commit-reveal + the draw (docs/raffle.md) --------------------
// A sponsor-funded raffle picks one winner among the wave's (burn-gated) gallery entries.
// Fairness = commit-reveal, using the wave's two phases: each participant COMMITS to a hidden
// secret during the lobby (before anyone reveals), then REVEALS it in its gallery selfie. The
// draw seed folds every revealed secret, so no participant — having committed before seeing
// others — can steer the outcome (the residual is a last-revealer *abort*, bounded by a reveal
// deadline; see the doc). Pure + deterministic here so anyone can recompute and audit the draw.

// The public commitment to a hidden 32-byte secret.
function commitOf(secretHex) {
  return b4a.toString(crypto.hash(b4a.from(secretHex, 'hex')), 'hex')
}

// A participant signs its commitment with its ring key so only it can set its own commit
// (the commit rides flooded gossip where peerId isn't connection-bound).
function commitSigHash(waveId, peerId, commit) {
  return crypto.hash(b4a.from(`raffle-commit|${waveId}|${peerId}|${commit}`))
}
function signCommit(keyPair, waveId, peerId, commit) {
  return b4a.toString(crypto.sign(commitSigHash(waveId, peerId, commit), keyPair.secretKey), 'hex')
}
function verifyCommit(waveId, peerId, commit, sigHex) {
  try {
    return crypto.verify(
      commitSigHash(waveId, peerId, commit),
      b4a.from(sigHex, 'hex'),
      b4a.from(peerId, 'hex')
    )
  } catch {
    return false
  }
}

// The draw. `tickets` = eligible entries [{ peerId, secret, ... }] whose reveal matched their
// commit. Deterministic: fold the secrets (in peerId order) into a `seed`, then produce a
// deterministic RANKING of the tickets — each keyed by H(seed|peerId), sorted ascending. The
// winner is `order[0]`; a payer that must skip an ineligible winner (e.g. its burn doesn't
// verify — admission is optimistic) walks down `order`, and that walk is itself auditable
// (skipping a valid earlier candidate is detectable). Anyone with the same tickets recomputes
// the same seed + order. Returns { seed, order, winner: order[0] | null }.
function raffleDraw(waveId, tickets) {
  const sorted = [...tickets].sort((a, b) =>
    a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0
  )
  const seed = b4a.toString(
    crypto.hash(b4a.from(`raffle|${waveId}|` + sorted.map((t) => t.secret).join('|'))),
    'hex'
  )
  const order = tickets
    .map((t) => ({ t, k: b4a.toString(crypto.hash(b4a.from(`${seed}|${t.peerId}`)), 'hex') }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .map((x) => x.t)
  return { seed, order, winner: order[0] || null }
}

module.exports = {
  ZERO_HASH,
  receiptHash,
  signReceipt,
  verifyReceipt,
  verifyToken,
  advanceChain,
  burnHash,
  signBurn,
  verifyBurn,
  burnAuthorizes,
  signGalleryKey,
  verifyGalleryKey,
  signWaveEnd,
  verifyWaveEnd,
  commitOf,
  signCommit,
  verifyCommit,
  raffleDraw
}
