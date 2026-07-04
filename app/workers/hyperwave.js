// HyperWave Bare worker: bridges the P2P engine (lib/wave.js) to the renderer.
// Started by the renderer via bridge.startWorker('/workers/hyperwave.js').
// Storage dir arrives as Bare.argv[2] (see electron/main.js getWorker), so each
// --storage instance gets its own identity + Corestore.

const FramedStream = require('framed-stream')
const goodbye = require('graceful-goodbye')
const env = require('bare-env')
const { createWave, parseBootstrap } = require('./lib/wave')
const { createPayments } = require('./lib/pay')
const { FEE_TRX, payFee, confirmBurn, wireWallet } = require('./lib/fees')

const pipe = new FramedStream(Bare.IPC)
const storageDir = Bare.argv[2]

function send(msg) {
  pipe.write(JSON.stringify(msg))
}

// Optional env overrides (same as wave.run.js): HYPERWAVE_BOOTSTRAP=host:port uses a
// local DHT (instant same-machine discovery for demos); HYPERWAVE_MATCH isolates the ring.
const bootstrap = parseBootstrap(env.HYPERWAVE_BOOTSTRAP)

const wave = createWave({
  storageDir,
  bootstrap,
  matchId: env.HYPERWAVE_MATCH || undefined,
  lobbyMs: env.HYPERWAVE_LOBBY_MS ? Number(env.HYPERWAVE_LOBBY_MS) : undefined,
  role: env.HYPERWAVE_ROLE || 'peer', // 'validator'/'seed' runs this instance as a gallery seed
  onState: (state) => send({ type: 'state', ...state }),
  onToken: (event) => send({ type: 'token', ...event }),
  onGallery: (items) => send({ type: 'gallery', items }),
  log: (...a) => console.log('[hyperwave]', ...a)
})

console.log(
  '[hyperwave] worker up, me=',
  wave.me.id.slice(0, 8),
  'angle=',
  wave.me.angle.toFixed(1)
)

// Self-custodial WDK wallet (Tron testnet TRX) for fees / payout / tips. Async init
// (dynamic import of ESM WDK); emits `wallet` {address,trx} to the renderer on ready
// and every 15s. Once up, it's wired into the engine via setWallet (address for
// tips/attestations, on-chain burn verifier = paid-wave gate, reward sender = payout).
let payments = null
let tBalance = null
createPayments({ storageDir, log: (...a) => console.log('[wallet]', ...a) })
  .then(async (pay) => {
    payments = pay
    wireWallet(wave, pay)
    const push = async () => {
      const bal = await pay.balances().catch(() => ({ address: pay.address, trx: 0 }))
      send({ type: 'wallet', ...bal })
    }
    await push()
    tBalance = setInterval(push, 15000)
  })
  .catch((e) => console.log('[wallet] init failed:', e.message))

// Renderer -> worker commands.
pipe.on('data', (data) => {
  let msg
  try {
    msg = JSON.parse(data.toString())
  } catch {
    return
  }
  if (msg.type === 'start-wave') handleStartWave()
  else if (msg.type === 'join-wave') handleJoin()
  else if (msg.type === 'set-country') wave.setCountry(msg.country)
  else if (msg.type === 'stage-selfie') wave.stageSelfie(msg.selfie)
  else if (msg.type === 'tip') handleTip(msg)
})

// Participation fee (fees.js) — burned to the black hole (not paid to anyone) by both the
// initiator (kick-off) and each joiner. The on-chain memo commits the burn to this wave +
// peer; the ring-key attestation (recordBurn, inside payFee) binds my identity + posts it
// to the gallery for the validator. `burn-result` -> UI toast.
async function burnFee(waveId, reason) {
  const { hash, proof } = await payFee(wave, payments, waveId, reason)
  send({ type: 'burn-result', hash, amount: FEE_TRX, waveId, reason })
  return { hash, proof }
}

// Kick-off: the wave is NOT announced until the initiator's burn is CONFIRMED on-chain, so
// peers can verify it and won't join an unpaid (spam) wave. wave.startWave() enters the
// lobby (deferred announce); we burn, wait for the burn to confirm, then announcePaid.
async function handleStartWave() {
  const waveId = wave.startWave()
  if (!waveId || !payments) return // busy / seed / no wallet (unpaid path already announced)
  try {
    const { hash, proof } = await burnFee(waveId, 'kickoff')
    if (await confirmBurn(payments, waveId, hash)) wave.announcePaid(proof)
    else {
      send({ type: 'burn-result', error: 'kick-off burn not confirmed', waveId, reason: 'kickoff' })
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

// Gallery tip: send a real testnet TRX transfer to the selfie owner's wallet, then
// report the tx hash (or error) back to the renderer.
async function handleTip({ to, amount }) {
  if (!payments) return send({ type: 'tip-result', error: 'wallet not ready' })
  try {
    const { hash } = await payments.send(to, amount)
    send({ type: 'tip-result', hash, to, amount })
  } catch (e) {
    send({ type: 'tip-result', error: e.message, to })
  }
}

goodbye(async () => {
  if (tBalance) clearInterval(tBalance)
  if (payments) payments.dispose()
  await wave.close()
})
