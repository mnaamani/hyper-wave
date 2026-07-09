// The host-agnostic engine core (core.js): does it route host commands to the engine and
// forward engine events to `send`, in both the no-wallet and wallet-ready paths? Runs with
// FAKE wave + payments factories (injected via `deps`), so no real swarm / no network — this
// is exactly what the extraction bought: core is testable without a host. Runs under Bare:
//   bare workers/lib/core.test.js   (or `npm test`)
const test = require('brittle')
const hyperwave = require('./core')

// A fake engine that records the calls core makes on it, and hands core the option callbacks
// so the test can fire engine events (onState/onEvent/onGallery) itself.
function fakeWave() {
  const calls = []
  const w = {
    me: { id: 'ab'.repeat(32), angle: 12.3 },
    calls,
    opts: null,
    startWave: () => (calls.push('startWave'), 'wave-1'),
    join: () => (calls.push('join'), 'wave-1'),
    announcePaid: (p) => calls.push(['announcePaid', p]),
    setCountry: (c) => calls.push(['setCountry', c]),
    stageSelfie: (s) => calls.push(['stageSelfie', s]),
    setWallet: (addr) => calls.push(['setWallet', addr]),
    close: async () => calls.push('close')
  }
  return w
}

const flush = () => new Promise((r) => setTimeout(r, 0)) // let the async wallet init settle

test('core routes commands to the engine and forwards engine events to send', async (t) => {
  const sent = []
  const wave = fakeWave()
  const core = hyperwave.init({
    storageDir: '/tmp/e',
    config: { matchId: 'm', bootstrap: '' },
    send: (m) => sent.push(m),
    log: () => {},
    deps: {
      createWave: (opts) => ((wave.opts = opts), wave),
      createPayments: async () => {
        throw new Error('no wallet in this test')
      }
    }
  })
  t.teardown(() => core.close())

  // engine callbacks are wired through to send with the right envelope
  wave.opts.onState({ me: wave.me, peers: [] })
  wave.opts.onEvent({ event: 'started', waveId: 'wave-1' })
  wave.opts.onGallery([{ caption: 'hi' }])
  t.ok(
    sent.find((m) => m.type === 'state') &&
      sent.find((m) => m.type === 'event' && m.event === 'started') &&
      sent.find((m) => m.type === 'gallery' && m.items.length === 1),
    'state / token / gallery events forwarded with type envelopes'
  )

  // plain commands are dispatched to the engine
  core.onMessage({ type: 'set-country', country: 'JP' })
  core.onMessage({ type: 'stage-selfie', selfie: 'data:image/jpeg;base64,xxx' })
  core.onMessage({ type: 'start-wave' })
  t.alike(
    wave.calls,
    [['setCountry', 'JP'], ['stageSelfie', 'data:image/jpeg;base64,xxx'], 'startWave'],
    'set-country / stage-selfie / start-wave routed to the engine'
  )

  await flush()
  // with no wallet, a tip is refused rather than silently dropped
  core.onMessage({ type: 'tip', to: 'Trecipient', amount: 1 })
  await flush()
  t.ok(
    sent.find((m) => m.type === 'tip-result' && m.error === 'wallet not ready'),
    'tip with no wallet returns an error result'
  )
  t.ok(
    sent.find((m) => m.type === 'wallet' && m.error),
    'a wallet init failure surfaces a { wallet, error } message (no balance)'
  )
  t.absent(
    sent.find((m) => m.type === 'wallet' && m.address),
    'no wallet balance message when the wallet failed to init'
  )
})

test('core wires a ready wallet into the engine and pushes the balance + pays tips', async (t) => {
  const sent = []
  const wave = fakeWave()
  const tipped = []
  const pay = {
    address: 'Tmywallet',
    balances: async () => ({ address: 'Tmywallet', trx: 7 }),
    send: async (to, amount) => (tipped.push([to, amount]), { hash: 'f'.repeat(64) }),
    transactions: async () => [
      { hash: 'a'.repeat(64), direction: 'in', amount: 5, timestamp: 1, memo: '' }
    ],
    dispose: () => {}
  }
  const core = hyperwave.init({
    storageDir: '/tmp/e',
    config: {},
    send: (m) => sent.push(m),
    log: () => {},
    deps: {
      createWave: (opts) => ((wave.opts = opts), wave),
      createPayments: async () => pay
    }
  })
  t.teardown(() => core.close())

  await flush() // wallet init resolves
  t.ok(
    sent.find((m) => m.type === 'wallet' && m.address === 'Tmywallet' && m.trx === 7),
    'balance pushed to the host once the wallet is ready'
  )
  t.ok(
    wave.calls.find((c) => Array.isArray(c) && c[0] === 'setWallet' && c[1] === 'Tmywallet'),
    'the wallet is wired into the engine (setWallet)'
  )

  core.onMessage({ type: 'tip', to: 'Trecipient', amount: 2 })
  await flush()
  t.alike(tipped, [['Trecipient', 2]], 'tip forwarded to payments.send')
  t.ok(
    sent.find((m) => m.type === 'tip-result' && m.hash && m.to === 'Trecipient'),
    'tip-result with the tx hash returned to the host'
  )

  core.onMessage({ type: 'send-trx', to: 'Tfriend', amount: 3 })
  await flush()
  t.alike(tipped.at(-1), ['Tfriend', 3], 'send-trx forwarded to payments.send')
  t.ok(
    sent.find((m) => m.type === 'send-result' && m.hash && m.to === 'Tfriend' && m.amount === 3),
    'send-result with the tx hash returned to the host'
  )

  core.onMessage({ type: 'fetch-transactions' })
  await flush()
  const txMsg = sent.find((m) => m.type === 'transactions')
  t.ok(
    txMsg && txMsg.list.length === 1 && txMsg.list[0].direction === 'in',
    'on-chain history forwarded'
  )
})
