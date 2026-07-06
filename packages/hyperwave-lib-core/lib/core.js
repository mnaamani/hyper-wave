// The HyperWave engine, host-agnostic. Everything the desktop worker (workers/hyperwave.js) and
// a mobile bare-kit worklet (workers/worklet/app.js) share lives here: it wires the P2P engine
// (wave.js) + the WDK wallet (pay.js) together and exposes a tiny message surface. The host
// supplies { storageDir, config, send } and feeds it decoded messages via onMessage() — there's
// no Bare.argv / bare-env / IPC transport in here, so the same core boots under Electron-spawned
// Bare and a react-native-bare-kit worklet unchanged. `deps` lets tests inject fake factories
// (so core is unit-testable without a real swarm or a wallet). Unit-tested in core.test.js.
const { createWave, parseBootstrap } = require('./wave')
const { createPayments } = require('./pay')
const { FEE_TRX, payFee, confirmBurn, wireWallet } = require('./fees')

function init({
  storageDir,
  config = {},
  send,
  log = (...a) => console.log('[hyperwave]', ...a),
  deps = {}
}) {
  const makeWave = deps.createWave || createWave
  const makePayments = deps.createPayments || createPayments

  const wave = makeWave({
    storageDir,
    bootstrap: config.bootstrap ? parseBootstrap(config.bootstrap) : undefined,
    matchId: config.matchId,
    lobbyMs: config.lobbyMs,
    // Raffle prize (TRX): if > 0, for waves THIS peer initiates it draws a winner among the
    // gallery participants and pays them from its own wallet. 0 = off. No roles — the wave's
    // initiator is its own gallery archivist + commit-recorder + raffle sponsor.
    raffleTrx: config.raffleTrx || 0,
    onState: (state) => send({ type: 'state', ...state }),
    onEvent: (event) => send({ type: 'event', ...event }),
    onGallery: (items) => send({ type: 'gallery', items }),
    log
  })
  log('engine up, me=', wave.me.id.slice(0, 8), 'angle=', wave.me.angle.toFixed(1))

  // Self-custodial WDK wallet (Tron testnet TRX) for fee burns + gallery tips. Async ESM init;
  // emits `wallet` {address,trx} on ready + every 15s, and wires into the engine (address for
  // tips/attestations + the on-chain burn verifier = the paid-wave anti-spam gate). A host can
  // opt out with `config.wallet: false` (e.g. mobile, until WDK-in-worklet is confirmed) — the
  // engine then runs wallet-less (receipt-only gallery, no burns/paid-gate/tips).
  let payments = null
  let tBalance = null
  if (config.wallet !== false) {
    makePayments({ storageDir, seed: config.seed, log: (...a) => log('[wallet]', ...a) })
      .then(async (pay) => {
        payments = pay
        wireWallet(wave, pay)
        const push = async () =>
          send({
            type: 'wallet',
            ...(await pay.balances().catch(() => ({ address: pay.address, trx: 0 })))
          })
        await push()
        tBalance = setInterval(push, 15000)
      })
      .catch((e) => {
        log('[wallet] init failed:', e.message)
        send({ type: 'wallet', error: e.message }) // surface to the host (mobile has no console)
      })
  }

  // Participation fee (fees.js) — burned to the black hole by both initiator (kick-off) and each
  // joiner. `burn-result` -> UI toast.
  async function burnFee(waveId, reason) {
    const { hash, proof } = await payFee(wave, payments, waveId, reason)
    send({ type: 'burn-result', hash, amount: FEE_TRX, waveId, reason })
    return { hash, proof }
  }

  // Kick-off: the wave is NOT announced until the initiator's burn is CONFIRMED on-chain, so
  // peers can verify it and won't join an unpaid (spam) wave.
  async function handleStartWave() {
    const waveId = wave.startWave()
    if (!waveId || !payments) return // busy / no wallet (unpaid path already announced)
    try {
      const { hash, proof } = await burnFee(waveId, 'kickoff')
      if (await confirmBurn(payments, waveId, hash)) wave.announcePaid(proof)
      else {
        send({
          type: 'burn-result',
          error: 'kick-off burn not confirmed',
          waveId,
          reason: 'kickoff'
        })
      }
    } catch (e) {
      send({ type: 'burn-result', error: e.message, waveId, reason: 'kickoff' })
    }
  }

  // Join: wave.join() is gated on the kick-off being verified (returns null otherwise), so we
  // only burn the join fee for a wave that's proven paid.
  async function handleJoin() {
    const waveId = wave.join()
    if (!waveId || !payments) return
    try {
      await burnFee(waveId, 'join')
    } catch (e) {
      send({ type: 'burn-result', error: e.message, waveId, reason: 'join' })
    }
  }

  // Gallery tip: a real testnet TRX transfer to the selfie owner's wallet.
  async function handleTip({ to, amount }) {
    if (!payments) return send({ type: 'tip-result', error: 'wallet not ready' })
    try {
      const { hash } = await payments.send(to, amount)
      send({ type: 'tip-result', hash, to, amount })
    } catch (e) {
      send({ type: 'tip-result', error: e.message, to })
    }
  }

  // Host -> engine commands (same message shapes the desktop renderer + the RN UI both speak).
  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'start-wave') handleStartWave()
    else if (msg.type === 'join-wave') handleJoin()
    else if (msg.type === 'set-country') wave.setCountry(msg.country)
    else if (msg.type === 'stage-selfie') wave.stageSelfie(msg.selfie)
    else if (msg.type === 'tip') handleTip(msg)
  }

  async function close() {
    if (tBalance) clearInterval(tBalance)
    if (payments) payments.dispose()
    await wave.close()
  }

  return { wave, onMessage, close }
}

module.exports = { init }
