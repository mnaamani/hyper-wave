// createWave with a HOST-SUPPLIED Hyperswarm (the `swarm` option): the engine shares the
// instance instead of creating its own, takes its identity from it, and — critically — does
// NOT destroy it on close (the host owns its lifecycle). Uses a real Hyperswarm on a local
// testnet DHT (no second peer needed — this checks ownership/identity, not discovery).
// Runs under Bare:  bare lib/swarm.share.test.js   (or `npm test`)
const test = require('brittle');
const fs = require('bare-fs');
const b4a = require('b4a');
const Hyperswarm = require('hyperswarm');
const createTestnet = require('@hyperswarm/testnet');
const { createWave } = require('./wave');

test('createWave shares a host-owned swarm: takes its identity, never destroys it', async (t) => {
  const testnet = await createTestnet(1);
  const hostSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap });
  const dir = `/tmp/hw-share-${Date.now()}`;
  t.teardown(async () => {
    await hostSwarm.destroy();
    await testnet.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const wave = createWave({
    storageDir: dir,
    topicId: 'share-test',
    swarm: hostSwarm, // <-- the new option: use the host's instance
    emit: () => {}
  });

  t.is(
    wave.me.id,
    b4a.toString(hostSwarm.keyPair.publicKey, 'hex'),
    'identity is the shared swarm’s keyPair (not a fresh engine-derived one)'
  );

  await wave.close();

  t.absent(
    hostSwarm.destroyed,
    'the engine did NOT destroy the host-owned swarm on close (the host owns its lifecycle)'
  );
});
