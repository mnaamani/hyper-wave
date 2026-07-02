// Standalone local DHT bootstrap for fast same-machine testing/demo. Runs under Bare:
//   bare workers/lib/bootstrap.js
// Prints "BOOTSTRAP host:port" then stays alive. Point peers at it via
// HYPERWAVE_BOOTSTRAP=host:port. Ctrl-C to stop.
const createTestnet = require('@hyperswarm/testnet')

async function main() {
  const testnet = await createTestnet(3)
  const { host, port } = testnet.bootstrap[0]
  console.log(`BOOTSTRAP ${host}:${port}`)
  Bare.on('teardown', () => testnet.destroy())
  setInterval(() => {}, 1 << 30)
}

main().catch((err) => {
  console.error('FAIL', err)
  Bare.exit(1)
})
