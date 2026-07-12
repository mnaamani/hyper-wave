// GallerySession lifecycle: per-wave open/create, the archivist rule (a retained gallery
// survives moving on and is reused on return; an ephemeral one is closed and replaced),
// the current key/waveId exposure, and posting through the session (no-gallery error path
// + a writable originator's post landing in the emitted view). Uses a real Corestore +
// Autobase on disk, no swarm. Runs under Bare:  bare lib/gallery-session.test.js  (or `npm test`)
const test = require('brittle');
const Corestore = require('corestore');
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const fs = require('bare-fs');
const { GallerySession } = require('./gallery-session');
const { signJoin } = require('./attest');

// A session over a throwaway store, with capturable host callbacks. Payments off
// (enforcePaid false) — the paid-gate signature checks are covered by wave.token/autobase.
// `holder.joinSig` stands in for wave.joinSig (set after the gallery is ready, exactly
// like wave.js does).
function makeSession(t, { events = [], views = [] } = {}) {
  const dir =
    '/tmp/hyperwave-gallery-session-test-' + Date.now() + '-' + Math.random();
  const store = new Corestore(dir);
  const keyPair = crypto.keyPair();
  const holder = { joinSig: null };
  const session = new GallerySession({
    store,
    me: { id: b4a.toString(keyPair.publicKey, 'hex'), country: 'BR' },
    onGallery: (items) => views.push(items),
    onEvent: (evt) => events.push(evt),
    enforcePaid: () => false,
    walletAddress: () => null,
    burnProof: () => null,
    joinProof: () => holder.joinSig,
    log: () => {}
  });
  t.teardown(async () => {
    await session.close();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { session, keyPair, holder };
}

// Poll until pred() is true or ~2s passed (gallery emits are fire-and-forget async).
function until(pred) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (pred() || Date.now() - started > 2000) {
        resolve(pred());
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

test('open creates a per-wave gallery and exposes its key + waveId once ready', async (t) => {
  const { session } = makeSession(t);
  t.is(session.key, null, 'no key before any gallery');
  t.is(session.waveId, null);
  const gallery = session.open('wave-1', null);
  await gallery.ready();
  t.is(session.waveId, 'wave-1');
  t.is(
    session.key,
    b4a.toString(gallery.key, 'hex'),
    'key is the Autobase bootstrap key'
  );
  t.is(
    session.open('wave-1', null),
    gallery,
    'reopening the current wave is a no-op'
  );
});

test('moving on replaces an ephemeral gallery but reuses a retained one', async (t) => {
  const { session } = makeSession(t);
  // Ephemeral: not mine — moving on closes it; coming back builds a NEW instance.
  const ephemeral = session.open('wave-eph', null);
  await ephemeral.ready();
  session.open('wave-next', null);
  t.not(
    session.open('wave-eph', null),
    ephemeral,
    'ephemeral gallery was closed, not kept'
  );

  // Retained (a wave I initiated): survives moving on; coming back reuses the SAME instance.
  session.retain('wave-mine');
  const mine = session.open('wave-mine', null);
  await mine.ready();
  const mineKey = session.key;
  session.open('wave-other', null);
  t.is(
    session.open('wave-mine', null),
    mine,
    'the archivist keeps its own wave’s gallery'
  );
  t.is(session.key, mineKey, 'returning to it restores its key');
  t.is(session.waveId, 'wave-mine');
});

test('postSelfie without a gallery reports gallery-error to the host', async (t) => {
  const events = [];
  const { session } = makeSession(t, { events });
  await session.postSelfie({ waveId: 'w', hopCount: 0 });
  t.alike(events, [{ event: 'gallery-error', reason: 'no-gallery-yet' }]);
});

test('a writable originator posts through the session and the view emits it', async (t) => {
  const views = [];
  const { session, keyPair, holder } = makeSession(t, { views });
  const gallery = session.open('wave-post', null);
  await gallery.ready();
  holder.joinSig = signJoin(keyPair, {
    waveId: 'wave-post',
    writerKey: session.writerKey
  });
  await session.postSelfie({
    waveId: 'wave-post',
    hopCount: 0,
    caption: 'goal!',
    image: 'data:jpeg'
  });
  t.ok(
    await until(() => views.some((items) => items.length === 1)),
    'the posted selfie reached the emitted gallery view'
  );
  const items = views.find((view) => view.length === 1);
  t.is(items[0].caption, 'goal!');
  t.is(items[0].country, 'BR', 'my country rides the entry');
});

test('admitRoster batch-admits only validly-signed join credentials', async (t) => {
  const { session } = makeSession(t);
  session.retain('wave-adm'); // only the wave's originator admits
  const gallery = session.open('wave-adm', null);
  await gallery.ready();

  const joiner = crypto.keyPair();
  const joinerId = b4a.toString(joiner.publicKey, 'hex');
  const writerKey = b4a.toString(crypto.keyPair().publicKey, 'hex');
  const good = {
    peerId: joinerId,
    writerKey,
    joinSig: signJoin(joiner, { waveId: 'wave-adm', writerKey })
  };
  const badSig = { ...good, joinSig: good.joinSig.replace(/^../, '00') };
  const wrongWave = {
    ...good,
    joinSig: signJoin(joiner, { waveId: 'other-wave', writerKey })
  };

  t.is(
    await session.admitRoster([badSig, wrongWave, good, good]),
    1,
    'one valid credential admitted; forged/cross-wave/duplicate ones dropped'
  );
  t.is(await session.admitRoster([good]), 0, 'already admitted — deduped');
});

test('admitRoster refuses on a wave I did not initiate', async (t) => {
  const { session } = makeSession(t);
  const gallery = session.open('wave-notmine', null);
  await gallery.ready();
  const joiner = crypto.keyPair();
  const writerKey = b4a.toString(crypto.keyPair().publicKey, 'hex');
  const cred = {
    peerId: b4a.toString(joiner.publicKey, 'hex'),
    writerKey,
    joinSig: signJoin(joiner, { waveId: 'wave-notmine', writerKey })
  };
  t.is(
    await session.admitRoster([cred]),
    0,
    'non-originator sessions never admit'
  );
});
