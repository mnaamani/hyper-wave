// wave.js — drive the engine at a lower level with createWave() (what init() wraps,
// minus the wallet). It builds the Hyperswarm/Corestore transport and returns the wave
// controls. This example prints its identity, kicks off a (solo) wave, then closes.
// Run:  bare examples/wave.js
const fs = require('bare-fs');
const env = require('bare-env');
const { createWave, parseBootstrap } = require('hyper-wave');

async function main() {
  const dir = '/tmp/hw-example-wave-' + Date.now();

  const wave = createWave({
    storageDir: dir,
    matchId: 'example-' + Date.now(),
    bootstrap: parseBootstrap(env.HYPERWAVE_BOOTSTRAP), // host:port → local DHT, else public
    onState: ({ me, peers, successor }) => {
      console.log(
        'state: peers',
        peers.length,
        'me',
        me.id.slice(0, 8),
        '@',
        me.angle.toFixed(1),
        'succ',
        successor ? successor.id.slice(0, 8) : 'none'
      );
    },
    onEvent: (ev) => console.log('event:', ev.event, ev.waveId || ''),
    onGallery: (items) => console.log('gallery:', items.length)
    // swarmSeed: '<hex>'  // inject an identity; else <storage>/swarm.seed (stable across runs)
  });

  console.log('my seat:', wave.me); // { id, angle, country }

  wave.setCountry('BR');
  const waveId = wave.startWave(); // announce + open the lobby; null if busy
  console.log('kicked off wave:', waveId);
  wave.stageSelfie({ image: '<jpeg-data-url>', caption: 'me' }); // posts when the ball arrives

  await new Promise((resolve) => setTimeout(resolve, 1500));
  await wave.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('closed.');
}

main().catch((err) => {
  console.error('FAIL', err);
  Bare.exit(1);
});
