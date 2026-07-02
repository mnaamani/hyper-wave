// One wave instance per process (the real topology: each worker is its own process).
// Runs under Bare:  bare workers/lib/wave.run.js <name> <storageDir>
//   env HYPERWAVE_BOOTSTRAP=host:port  -> local DHT (fast same-machine discovery)
//   env HYPERWAVE_MATCH=<id>           -> isolated match topic
//   env START=<n>                      -> originate once >= n peers are present
//   env AUTOSELFIE=1                   -> post a fake selfie in each proof window
const env = require('bare-env')
const { createWave } = require('./wave.js')

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
const wave = createWave({
  storageDir,
  bootstrap,
  matchId: env.HYPERWAVE_MATCH || undefined,
  onState: (s) => {
    console.log(
      `[${name}] peers=${s.peers.length} me=${s.me.id.slice(0, 8)}@${s.me.angle.toFixed(1)} ` +
        `succ=${s.successor ? s.successor.id.slice(0, 8) + '@' + s.successor.angle.toFixed(1) : 'none'}`
    )
    if (env.START && !started && s.peers.length >= Number(env.START)) {
      started = true
      setTimeout(() => wave.startWave(), 500)
    }
  },
  onToken: (e) => {
    console.log(`[${name}] TOKEN`, JSON.stringify(e))
    if (env.AUTOSELFIE && e.event === 'holding') {
      wave.postSelfie({
        waveId: e.waveId,
        hopCount: e.hopCount,
        receiptSig: e.receiptSig,
        chainHash: e.chainHash,
        caption: `${name} was here`,
        image: `fake-image-${name}`
      })
    }
  },
  onGallery: (items) =>
    console.log(`[${name}] GALLERY size=${items.length} [${items.map((i) => i.caption).join(', ')}]`),
  log: (...m) => console.log(`[${name}]`, ...m)
})
