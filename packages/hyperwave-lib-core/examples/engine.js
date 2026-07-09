// engine.js — host the whole engine with init(): storageDir + config + a `send`
// callback for engine→host events, driven by onMessage() commands. This is the surface
// the desktop worker and mobile worklet both use. This example boots wallet-less, prints
// its identity + any state events, then closes. Run:  bare examples/engine.js
const fs = require('bare-fs');
const { init } = require('hyperwave-lib-core');

async function main() {
  const dir = '/tmp/hw-example-engine-' + Date.now();

  const core = init({
    storageDir: dir,
    config: {
      matchId: 'example-' + Date.now(), // isolate this run's ring
      wallet: false // wallet-less: no fees/tips, receipt-only gallery (keeps the example offline)
    },
    send: (msg) => {
      if (msg.type === 'state') {
        console.log(
          'state: peers',
          msg.peers.length,
          'me',
          msg.me.id.slice(0, 8),
          '@',
          msg.me.angle.toFixed(1)
        );
      } else if (msg.type === 'event') {
        console.log('event:', msg.event, msg.waveId || '');
      }
    }
  });

  console.log(
    'engine up. my seat:',
    core.wave.me.id.slice(0, 8),
    '@',
    core.wave.me.angle.toFixed(1)
  );

  // Commands a host sends (no peers here, so start-wave just announces to an empty ring):
  core.onMessage({ type: 'set-country', country: 'BR' });
  core.onMessage({ type: 'start-wave' });

  // Let a state/event tick or two fire, then shut down cleanly.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await core.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('closed.');
}

main().catch((err) => {
  console.error('FAIL', err);
  Bare.exit(1);
});
