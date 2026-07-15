// wave.js — drive the engine at a lower level with createWave() (what init() wraps,
// minus the wallet). It builds the Hyperswarm/Corestore transport and returns the wave
// controls. This example prints its identity, starts a (solo) wave, then closes.
// Run:  bare examples/wave.js
const fs = require('bare-fs');
const env = require('bare-env');
const { createWave, parseBootstrap } = require('hyperwave-engine');

async function main() {
  const dir = '/tmp/hw-example-wave-' + Date.now();

  const wave = createWave({
    storageDir: dir,
    topicId: 'example-' + Date.now(),
    bootstrap: parseBootstrap(env.HYPERWAVE_BOOTSTRAP), // host:port → local DHT, else public
    onState: ({ me, peers }) => {
      console.log(
        'state: peers',
        peers.length,
        'me',
        me.id.slice(0, 8),
        '@',
        me.angle.toFixed(1)
      );
    },
    onEvent: (ev) => console.log('event:', ev.event, ev.waveId || ''),
    onFeed: (items) => console.log('feed:', items.length)
    // swarmSeed: '<hex>'  // inject an identity; else <storage>/swarm.seed (stable across runs)
  });

  console.log('my seat:', wave.me); // { id, angle, tag }

  wave.setTag('BR');
  const waveId = wave.startWave(); // announce + open the lobby; null if busy
  console.log('started wave:', waveId);
  wave.stageEntry({ payload: { label: 'me' } }); // opaque; posts at my sweep slot

  await new Promise((resolve) => setTimeout(resolve, 1500));
  await wave.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('closed.');
}

main().catch((err) => {
  console.error('FAIL', err);
  Bare.exit(1);
});
