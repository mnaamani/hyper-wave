// The per-wave sponsor raffle (commit-reveal draw + payout), extracted from wave.js so the wave
// engine stays focused on the ring/token/gallery. No roles: a wave's INITIATOR runs its raffle —
// it records participants' hidden commits during the lobby, then after the wave folds the revealed
// secrets into a deterministic draw and pays the prize FROM ITS OWN WALLET. It never pays itself
// (skipped in the winner walk; the prize goes to the next eligible participant). Fairness =
// commit-reveal: a peer commits H(secret) before anyone reveals, so it can't steer the outcome.
//
// wave.js wires this via createRaffle(ctx) and drives it through the returned methods; all the
// raffle state (my secret/commit, the recorded commits, the drawn-once set) lives in here.
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { signCommit, verifyCommit, commitOf, raffleDraw } = require('./token')
const { readGallery } = require('./gallery')

// After a wave ends the initiator waits an initial settle, then draws. Because the initiator is a
// normal ring peer (no dedicated hub), distant selfie reveals can take a few update cycles to
// replicate into its retained gallery — so before drawing it POLLS (every RAFFLE_POLL_MS, up to
// RAFFLE_CONVERGE_MS) until every recorded commit has a matching revealed secret, then draws. A
// committed peer that never selfied just won't produce a ticket.
const RAFFLE_DELAY_MS = 3000
const RAFFLE_POLL_MS = 1000
const RAFFLE_CONVERGE_MS = 20000

const shortId = (hex) => (hex ? hex.slice(0, 8) : '?')

// ctx: {
//   keyPair,              // my Ed25519 key pair (ring-signs my commit)
//   me,                   // { id, ... }
//   raffleTrx,            // prize size in TRX; <= 0 disables the raffle entirely
//   galleries,            // Map(waveId -> Autobase) — I read the retained gallery I archived
//   getWave,              // () => the current wave state (or null)
//   iInitiated,           // (waveId) => did I initiate this wave?
//   getVerifyBurnOnChain, // () => on-chain burn verifier (or null) — set later via setWallet
//   getPayReward,         // () => TRX sender (or null) — set later via setWallet
//   onToken, log
// }
function createRaffle(ctx) {
  const { keyPair, me, raffleTrx, galleries, getWave, iInitiated, onToken, log } = ctx
  const raffleCommits = new Map() // (initiator) waveId -> Map(peerId -> commit), from lobby gossip
  const paidRaffles = new Set() // waves already drawn — draw exactly once
  let myRaffleSecret = null // 32 random bytes (hex); revealed in my gallery entry
  let myRaffleCommit = null // H(secret); published in the lobby, before anyone reveals
  let myRaffleCommitSig = null // ring signature so only I can set my commit

  // My commitment for the current wave (generated once): a hidden secret + its commit H(secret) +
  // a ring signature so only I can set it. Returns { commit, commitSig } to publish in the lobby
  // (before anyone reveals); the secret is revealed later in my selfie.
  function optIn() {
    const wave = getWave()
    if (!wave) return null
    if (!myRaffleSecret) {
      myRaffleSecret = b4a.toString(crypto.randomBytes(32), 'hex')
      myRaffleCommit = commitOf(myRaffleSecret)
      myRaffleCommitSig = signCommit(keyPair, wave.id, me.id, myRaffleCommit)
    }
    return { commit: myRaffleCommit, commitSig: myRaffleCommitSig }
  }

  // The reveal (my secret) to embed in my selfie; cleared between waves by reset().
  const currentReveal = () => myRaffleSecret
  function reset() {
    myRaffleSecret = null
    myRaffleCommit = null
    myRaffleCommitSig = null
  }

  // (Initiator only) Record a participant's commitment, seen in lobby gossip (wave-join). Only for
  // a wave I started, only while it's in its lobby (before any reveal), only a validly-signed
  // commit by that peer, first-write-wins. I adopt my own wave before anyone can join it, so no
  // pre-adoption buffering is needed.
  function recordCommit(waveId, peerId, commit, commitSig) {
    if (raffleTrx <= 0 || !commit || !peerId) return
    const wave = getWave()
    if (!wave || wave.id !== waveId || wave.by !== me.id) return // only for a wave I initiated
    if (wave.phase !== 'lobby') return // reveals happen in racing — too late for a new commit
    if (!verifyCommit(waveId, peerId, commit, commitSig)) return
    store(waveId, peerId, commit)
  }

  // I'm the initiator, so I collect commits for my wave — record my own now (I won't receive my
  // own announce back). Called from doAnnounce with the commit optIn() produced.
  function recordOwn(waveId, commit) {
    if (raffleTrx > 0 && commit) store(waveId, me.id, commit)
  }

  // Insert a verified commit into the draw set. First commit per peer wins (can't be changed).
  function store(waveId, peerId, commit) {
    let byPeer = raffleCommits.get(waveId)
    if (!byPeer) raffleCommits.set(waveId, (byPeer = new Map()))
    if (!byPeer.has(peerId)) byPeer.set(peerId, commit)
  }

  // After my wave settles, draw it (only if I funded + initiated it). goIdle clearing `wave` is
  // fine: the draw reads the retained gallery + recorded commits by waveId.
  function scheduleDraw(waveId) {
    if (raffleTrx <= 0 || !iInitiated(waveId)) return
    setTimeout(() => run(waveId).catch(() => {}), RAFFLE_DELAY_MS)
  }

  // Draw + pay the raffle for a wave I ran. Eligible tickets = gallery entries whose revealed
  // secret matches a commit I recorded. raffleDraw folds the reveals into a seed + deterministic
  // ranking; I walk it and pay the FIRST candidate whose burn verifies ON-CHAIN — because
  // admission was optimistic (no burn check at write time), the burn is verified here, only for
  // the winner (+ any fake-burn entries ranked above it), so on-chain reads are O(1)-ish per wave.
  // Fully auditable: anyone recomputes the seed + ranking from the reveals.
  async function run(waveId) {
    if (paidRaffles.has(waveId)) return
    paidRaffles.add(waveId)
    const commits = raffleCommits.get(waveId) || new Map()
    raffleCommits.delete(waveId)
    const g = galleries.get(waveId)
    if (!g) return
    // Gather tickets, polling until every recorded commit has a matching reveal (all committed
    // participants posted + replicated to me) or RAFFLE_CONVERGE_MS elapses — so a distant reveal
    // that's slow to reach this (non-hub) initiator isn't silently dropped from the draw.
    const ticketsFrom = (entries) => {
      const t = []
      for (const e of entries) {
        const commit = commits.get(e.peerId)
        if (!commit || !e.raffleSecret || commitOf(e.raffleSecret) !== commit) continue
        t.push({
          peerId: e.peerId,
          secret: e.raffleSecret,
          address: e.address || '',
          burnTx: e.burnTx || ''
        })
      }
      return t
    }
    let tickets = []
    for (let waited = 0; ; waited += RAFFLE_POLL_MS) {
      await g.update().catch(() => {})
      tickets = ticketsFrom(await readGallery(g))
      if (tickets.length >= commits.size || waited >= RAFFLE_CONVERGE_MS) break
      await new Promise((r) => setTimeout(r, RAFFLE_POLL_MS))
    }
    const { seed, order } = raffleDraw(waveId, tickets)
    onToken({
      event: 'raffle-draw',
      waveId,
      tickets: tickets.length,
      seed,
      top: order[0] ? order[0].peerId : null
    })
    if (order.length === 0) return log('raffle: no eligible tickets for wave', shortId(waveId))
    // Walk the ranking; the winner is the first candidate whose fee burn verifies on-chain. Skip
    // myself: I'm the sponsor paying from my own wallet, so paying myself is a no-op — the prize
    // goes to the next eligible participant instead (I'm still a fair ticket in the draw).
    const verifyBurnOnChain = ctx.getVerifyBurnOnChain()
    const payReward = ctx.getPayReward()
    let winner = null
    for (const cand of order) {
      if (cand.peerId === me.id) continue
      if (verifyBurnOnChain) {
        const r = cand.burnTx
          ? await verifyBurnOnChain(cand.burnTx, { waveId, from: cand.address, minTrx: 1 }).catch(
              () => null
            )
          : null
        if (!r || !r.ok) {
          log('raffle: skipping unverified burn', shortId(cand.peerId), r && r.reason)
          continue // fake / unpaid / unconfirmed burn — not a valid winner
        }
      }
      winner = cand
      break
    }
    if (!winner) return log('raffle: no candidate with a verified burn for wave', shortId(waveId))
    if (!payReward) return log('raffle: winner', shortId(winner.peerId), '(no wallet — not paid)')
    if (!winner.address) return log('raffle: winner has no payout address', shortId(winner.peerId))
    try {
      const { hash } = await payReward(winner.address, raffleTrx)
      log('raffle: paid', raffleTrx, 'TRX ->', shortId(winner.peerId), 'tx', hash)
      onToken({
        event: 'raffle-win',
        waveId,
        winner: winner.peerId,
        address: winner.address,
        amount: raffleTrx,
        tickets: tickets.length,
        hash
      })
    } catch (e) {
      onToken({ event: 'raffle-error', waveId, error: e.message })
    }
  }

  return {
    optIn,
    currentReveal,
    reset,
    recordCommit,
    recordOwn,
    scheduleDraw,
    // My raffle commitment for the current wave, so the worker can put it in the burn memo → the
    // commit is recorded on-chain (auditable), not just gossiped.
    raffleCommit: () => {
      const rc = optIn()
      return rc ? rc.commit : ''
    }
  }
}

module.exports = { createRaffle }
