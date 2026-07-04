// HyperWave Bare worker: bridges the P2P engine (lib/wave.js) to the renderer.
// Started by the renderer via bridge.startWorker('/workers/hyperwave.js').
// Storage dir arrives as Bare.argv[2] (see electron/main.js getWorker), so each
// --storage instance gets its own identity + Corestore.

const FramedStream = require('framed-stream')
const goodbye = require('graceful-goodbye')
const env = require('bare-env')
const { createWave } = require('./lib/wave')
const { createPayments } = require('./lib/pay')

const pipe = new FramedStream(Bare.IPC)
const storageDir = Bare.argv[2]

function send(msg) {
  pipe.write(JSON.stringify(msg))
}

const wave = createWave({
  storageDir,
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

// Self-custodial WDK wallet (Tron testnet TRX) for bond / payout / tips. Async init
// (dynamic import of ESM WDK); emits `wallet` {address,trx} to the renderer on ready
// and every 15s. Runs independently of the wave engine for now (step 2 = wallets only).
let payments = null
let tBalance = null
createPayments({ storageDir, log: (...a) => console.log('[wallet]', ...a) })
  .then(async (pay) => {
    payments = pay
    wave.setWallet(pay.address) // so my selfies carry my address for tipping
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
  else if (msg.type === 'join-wave') wave.join()
  else if (msg.type === 'set-country') wave.setCountry(msg.country)
  else if (msg.type === 'stage-selfie') wave.stageSelfie(msg.selfie)
  else if (msg.type === 'tip') handleTip(msg)
})

// Kick-off: start the wave immediately, and burn the initiator's fee alongside (fire-and-
// forget — the lobby/race never waits on the chain). Burning (black hole address) proves
// skin in the game without enriching anyone; result is reported for the UI toast.
const KICKOFF_BURN_TRX = 1
function handleStartWave() {
  const waveId = wave.startWave()
  if (!waveId || !payments) return // busy / seed role / wallet not up — no fee due
  payments
    .burn(KICKOFF_BURN_TRX)
    .then(({ hash }) => send({ type: 'burn-result', hash, amount: KICKOFF_BURN_TRX, waveId }))
    .catch((e) => send({ type: 'burn-result', error: e.message, waveId }))
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
