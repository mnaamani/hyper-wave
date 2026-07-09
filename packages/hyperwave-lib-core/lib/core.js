// The HyperWave engine, host-agnostic. Everything the desktop worker (workers/hyperwave.js) and
// a mobile bare-kit worklet (workers/worklet/app.js) share lives here: it wires the P2P engine
// (wave.js) + the WDK wallet (pay.js) together and exposes a tiny message surface. The host
// supplies { storageDir, config, send } and feeds it decoded messages via onMessage() — there's
// no Bare.argv / bare-env / IPC transport in here, so the same core boots under Electron-spawned
// Bare and a react-native-bare-kit worklet unchanged. `deps` lets tests inject fake factories
// (so core is unit-testable without a real swarm or a wallet). Unit-tested in core.test.js.
const path = require('bare-path')
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

  // Log the resolved storage dir up front — every host routes through here, so this is the one
  // line that always tells you which dir this engine (and its wallet.seed) is really using. A
  // relative arg is resolved against cwd (the same way bare-fs/Corestore resolve it downstream),
  // so the log shows the true absolute on-disk location, not the ambiguous relative string.
  const absStorageDir = path.resolve(storageDir)
  log('storage dir:', absStorageDir)

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
  let pushBalance = null // re-fetch the balance + send a `wallet` msg; set once the wallet is up
  if (config.wallet !== false) {
    makePayments({ storageDir, seed: config.seed, log: (...a) => log('[wallet]', ...a) })
      .then(async (pay) => {
        payments = pay
        wireWallet(wave, pay)
        // Echo the wallet next to its storage dir so "which dir → which wallet" is unambiguous.
        log('wallet', pay.address, 'in storage dir:', absStorageDir)
        pushBalance = async () =>
          send({
            type: 'wallet',
            ...(await pay.balances().catch(() => ({ address: pay.address, trx: 0 })))
          })
        await pushBalance()
        tBalance = setInterval(pushBalance, 15000)
      })
      .catch((e) => {
        log('[wallet] init failed:', e.message)
        send({ type: 'wallet', error: e.message }) // surface to the host (mobile has no console)
      })
  }

  // Participation fee (fees.js), burned to the black hole. The `burn-result` message carries a
  // `stage` so the UI never says "burned" prematurely:
  //   confirming — tx broadcast, awaiting on-chain confirmation (kick-off only)
  //   burned     — confirmed on-chain (kick-off) or broadcast (join, fire-and-forget)
  //   failed     — couldn't burn / never confirmed

  // Kick-off: the wave is NOT announced until the initiator's burn is CONFIRMED on-chain, so
  // peers can verify it and won't join an unpaid (spam) wave.
  async function handleStartWave() {
    // Fail fast: a wallet that can't cover the fee would broadcast a burn that never confirms —
    // the wave would just stall until PAY_TIMEOUT. Refuse up front with a clear message. Only when
    // we could actually read the balance; a failed read falls through and lets the burn try.
    if (payments) {
      const bal = await payments.balances().catch(() => null)
      if (bal && bal.trx < FEE_TRX) {
        send({
          type: 'burn-result',
          stage: 'failed',
          reason: 'kickoff',
          error: `wallet unfunded (${bal.trx} TRX) — fund it to kick off a wave`
        })
        return
      }
    }
    const waveId = wave.startWave()
    if (!waveId || !payments) return // busy / no wallet (unpaid path already announced)
    try {
      const { hash, proof } = await payFee(wave, payments, waveId, 'kickoff')
      send({ type: 'burn-result', stage: 'confirming', hash, waveId, reason: 'kickoff' })
      if (await confirmBurn(payments, waveId, hash)) {
        send({
          type: 'burn-result',
          stage: 'burned',
          hash,
          amount: FEE_TRX,
          waveId,
          reason: 'kickoff'
        })
        wave.announcePaid(proof)
      } else {
        const error = 'burn not confirmed on-chain'
        send({ type: 'burn-result', stage: 'failed', error, waveId, reason: 'kickoff' })
      }
    } catch (e) {
      send({ type: 'burn-result', stage: 'failed', error: e.message, waveId, reason: 'kickoff' })
    }
  }

  // Join: wave.join() is gated on the kick-off being verified (returns null otherwise), so we only
  // burn the join fee for a wave that's proven paid. The join burn is fire-and-forget (no on-chain
  // confirmation), so it's reported as burned on broadcast.
  async function handleJoin() {
    // Fail fast, like kick-off: an unfunded joiner would broadcast a burn that never confirms and
    // then be refused gallery admission ("fee-unpaid") — confusing. Refuse the join up front with
    // a clear message instead. Only when we could actually read the balance.
    if (payments) {
      const bal = await payments.balances().catch(() => null)
      if (bal && bal.trx < FEE_TRX) {
        send({
          type: 'burn-result',
          stage: 'failed',
          reason: 'join',
          error: `wallet unfunded (${bal.trx} TRX) — fund it to join the wave`
        })
        return
      }
    }
    const waveId = wave.join()
    if (!waveId || !payments) return
    try {
      const { hash } = await payFee(wave, payments, waveId, 'join')
      send({ type: 'burn-result', stage: 'burned', hash, amount: FEE_TRX, waveId, reason: 'join' })
    } catch (e) {
      send({ type: 'burn-result', stage: 'failed', error: e.message, waveId, reason: 'join' })
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

  // Plain wallet transfer: send `amount` TRX to any address
  async function handleSend({ to, amount }) {
    if (!payments) return send({ type: 'send-result', error: 'wallet not ready', to })
    const trx = Number(amount)
    if (!to || !(trx > 0)) {
      return send({ type: 'send-result', error: 'invalid recipient/amount', to })
    }
    const bal = await payments.balances().catch(() => null)
    if (bal && bal.trx < trx) {
      return send({ type: 'send-result', error: `insufficient balance (${bal.trx} TRX)`, to })
    }
    try {
      const { hash } = await payments.send(to, trx)
      send({ type: 'send-result', hash, to, amount: trx })
      pushBalance?.()
    } catch (e) {
      send({ type: 'send-result', error: e.message, to })
    }
  }

  // On-chain transaction history for the wallet view — includes funds/tips RECEIVED (which the
  // app never sees as events), not just what we initiated. Read-only; [] without a wallet.
  async function handleTransactions() {
    const list = payments ? await payments.transactions().catch(() => []) : []
    send({ type: 'transactions', list })
  }

  // Host -> engine commands (same message shapes the desktop renderer + the RN UI both speak).
  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'start-wave') handleStartWave()
    else if (msg.type === 'join-wave') handleJoin()
    else if (msg.type === 'set-country') wave.setCountry(msg.country)
    else if (msg.type === 'stage-selfie') wave.stageSelfie(msg.selfie)
    else if (msg.type === 'tip') handleTip(msg)
    else if (msg.type === 'send-trx') handleSend(msg)
    else if (msg.type === 'fetch-transactions') handleTransactions()
    else if (msg.type === 'refresh-wallet') pushBalance?.() // manual balance re-check (after funding)
  }

  async function close() {
    if (tBalance) clearInterval(tBalance)
    if (payments) payments.dispose()
    await wave.close()
  }

  return { wave, onMessage, close }
}

module.exports = { init }
