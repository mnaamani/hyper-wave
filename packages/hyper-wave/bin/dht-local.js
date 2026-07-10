#!/usr/bin/env bare
// Standalone local DHT bootstrap for fast same-machine testing/demo. Runs under Bare:
//   bare bin/dht-local.js   (or, if installed: hyper-wave-dev-dht)
// Needs `bare` on PATH — it's a separate runtime, not an npm dependency.
// Prints "BOOTSTRAP host:port" then stays alive. Point peers at it via
// HYPERWAVE_BOOTSTRAP=host:port. Ctrl-C to stop.
const createTestnet = require('@hyperswarm/testnet');

async function main() {
  const testnet = await createTestnet(3);
  const { host, port } = testnet.bootstrap[0];
  console.log(`BOOTSTRAP ${host}:${port}`);
  Bare.on('teardown', () => testnet.destroy());
  // Hold the event loop open (self-rescheduling timeout; CLAUDE.md Code Style: no setInterval).
  function keepAlive() {
    setTimeout(keepAlive, 1 << 30);
  }
  keepAlive();
}

main().catch((err) => {
  console.error('FAIL', err);
  Bare.exit(1);
});
