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

// Self-custodial WDK wallet (Tron testnet USDT) for bond / payout / tips. Async init
// (dynamic import of ESM WDK); emits `wallet` {address,trx,usdt} to the renderer on ready
// and every 15s. Runs independently of the wave engine for now (step 2 = wallets only).
let payments = null
let tBalance = null
createPayments({ storageDir, log: (...a) => console.log('[wallet]', ...a) })
  .then(async (pay) => {
    payments = pay
    const push = async () => {
      const bal = await pay.balances().catch(() => ({ address: pay.address, trx: 0, usdt: 0 }))
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
  if (msg.type === 'start-wave') wave.startWave()
  else if (msg.type === 'join-wave') wave.join()
  else if (msg.type === 'set-country') wave.setCountry(msg.country)
  else if (msg.type === 'stage-selfie') wave.stageSelfie(msg.selfie)
})

goodbye(async () => {
  if (tBalance) clearInterval(tBalance)
  if (payments) payments.dispose()
  await wave.close()
})
