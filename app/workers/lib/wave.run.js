// One wave instance per process (the real topology: each worker is its own process).
// Runs under Bare:  bare workers/lib/wave.run.js <name> <storageDir>
//   env HYPERWAVE_BOOTSTRAP=host:port  -> local DHT (fast same-machine discovery)
//   env HYPERWAVE_MATCH=<id>           -> isolated match topic
//   env START=<n>                      -> announce a wave once >= n peers are present
//   env AUTOJOIN=1                     -> auto opt-in when a wave is announced
//   env AUTOSELFIE=1                   -> post a fake selfie in each proof window (if joined)
//   env HYPERWAVE_LOBBY_MS=<ms>        -> shorten the lobby for tests
const env = require('bare-env')
const { createWave } = require('./wave.js')
const { nodeIdOfHex, RING } = require('./chord.js')

const name = Bare.argv[2] || 'peer'
const storageDir = Bare.argv[3]
if (!storageDir) {
  console.error('usage: bare wave.run.js <name> <storageDir>')
  Bare.exit(1)
}

const bootstrap = env.HYPERWAVE_BOOTSTRAP
  ? env.HYPERWAVE_BOOTSTRAP.split(',').map((hp) => {
      const [host, port] = hp.split(':')
      return { host, port: Number(port) }
    })
  : null

let started = false
let payments = null // set by the WALLET=1 block below (if enabled)
const role = env.HYPERWAVE_ROLE || 'peer' // 'validator'/'seed' -> passive gallery seed
const wave = createWave({
  storageDir,
  role,
  bootstrap,
  matchId: env.HYPERWAVE_MATCH || undefined,
  lobbyMs: env.HYPERWAVE_LOBBY_MS ? Number(env.HYPERWAVE_LOBBY_MS) : undefined,
  onState: (s) => {
    console.log(
      `[${name}] peers=${s.peers.length} me=${s.me.id.slice(0, 8)}@${s.me.angle.toFixed(1)} ` +
        `succ=${s.successor ? s.successor.id.slice(0, 8) + '@' + s.successor.angle.toFixed(1) : 'none'}`
    )
    if (role === 'peer' && env.START && !started && s.peers.length >= Number(env.START)) {
      started = true
      setTimeout(() => {
        const waveId = wave.startWave()
        // initiator's kick-off fee: burn 1 TRX to the black hole (needs WALLET=1 + funds)
        if (waveId && payments) {
          payments
            .burn(1, `hyperwave:${waveId}:${wave.me.id}`)
            .then(({ hash }) => {
              wave.recordBurn({ reason: 'kickoff', amount: 1, txHash: hash })
              console.log(`[${name}] BURNED 1 TRX hash=${hash}`)
            })
            .catch((e) => console.log(`[${name}] burn FAIL`, e.message))
        }
      }, 500)
    }
  },
  onToken: (e) => {
    console.log(`[${name}] TOKEN`, JSON.stringify(e))
    // validator: on completion, read the burn-proofs it collected for this wave
    if (role !== 'peer' && e.event === 'completed') {
      setTimeout(async () => {
        const burns = await wave.chainBurns(e.waveId)
        console.log(
          `[${name}] BURNS wave=${e.waveId.slice(0, 8)} count=${burns.length} ` +
            `[${burns.map((b) => b.reason + ':' + b.peerId.slice(0, 6) + ':' + b.txHash.slice(0, 8)).join(', ')}]`
        )
      }, 3000)
    }
    if (role !== 'peer') return // a validator/seed doesn't join or selfie
    if (env.AUTOJOIN && e.event === 'wave-announce' && !e.mine) {
      const joinedId = wave.join()
      if (joinedId && payments) {
        payments
          .burn(1, `hyperwave:${joinedId}:${wave.me.id}`)
          .then(({ hash }) => {
            wave.recordBurn({ reason: 'join', amount: 1, txHash: hash })
            console.log(`[${name}] JOIN-BURNED 1 TRX hash=${hash}`)
          })
          .catch((err) => console.log(`[${name}] join burn FAIL`, err.message))
      }
    }
    // stage a (fake) selfie during the lobby, exactly like the renderer does at kickoff;
    // the worker posts it to the gallery when the token reaches this peer.
    if (env.AUTOSELFIE && e.event === 'wave-active' && e.joined) {
      wave.stageSelfie({ caption: `${name} was here`, image: `fake-image-${name}` })
    }
  },
  onGallery: (items) =>
    console.log(
      `[${name}] GALLERY size=${items.length} [${items
        .map((i) => i.caption + (i.address ? ' $' + i.address.slice(0, 5) : ''))
        .join(', ')}]`
    ),
  log: (...m) => console.log(`[${name}]`, ...m)
})

// env PROBE=1 -> after peers converge, exercise the distributed findSuccessor RPC by
// looking up the successor of the position just after me (my true successor).
if (env.PROBE) {
  setTimeout(async () => {
    const succ = await wave.findSuccessor((nodeIdOfHex(wave.me.id) + 1n) % RING)
    console.log(`[${name}] FINDSUCC my-successor = ${succ ? succ.slice(0, 8) : 'null'}`)
  }, 8000)
}

// env WALLET=1 -> bring up the WDK wallet and print address + balances (needs network).
// WALLET_SEND=<addr>:<amt> -> also do a one-off TRX transfer (funded wallets only).
if (env.WALLET) {
  const { createPayments } = require('./pay.js')
  createPayments({ storageDir, log: (...m) => console.log(`[${name}] wallet`, ...m) })
    .then(async (pay) => {
      payments = pay
      wave.setWallet(pay.address) // my selfies carry my address for tipping
      const b = await pay.balances()
      console.log(`[${name}] WALLET ${b.address} trx=${b.trx}`)
      if (env.WALLET_SEND) {
        const [to, amt] = env.WALLET_SEND.split(':')
        const r = await pay.send(to, Number(amt))
        console.log(`[${name}] WALLET SENT ${amt} -> ${to} hash=${r.hash}`)
      }
    })
    .catch((e) => console.log(`[${name}] wallet FAIL`, e.message))
}
