// The app core's invariants (app-core.js, numbered 1–6 in its header). Each is a bug that was
// fixed once in the desktop renderer and would be re-broken by any re-implementation — this suite
// is the regression net for the renderer port AND for the mobile host.
//   bare lib/app-core.test.js   (or `npm test`)
import test from 'brittle';
import { createAppCore } from './app-core.js';

// A core wired to a recording transport and a controllable clock/timer queue, so the ended-wave
// TTL is exercised without waiting three minutes.
function makeCore(options = {}) {
  const sent = [];
  const timers = new Map();
  const snapshots = [];
  let clock = 1000;
  let nextTimer = 1;

  const core = createAppCore({
    send: (type, args) => sent.push({ type, ...args }),
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    ...options
  });
  core.subscribe((snapshot, kind) => snapshots.push({ snapshot, kind }));

  return {
    core,
    sent,
    snapshots,
    // Advance the clock, firing every timer that comes due (in due order, like a real loop).
    advance(ms) {
      clock += ms;
      let due = [...timers.entries()].filter(([, timer]) => timer.at <= clock);
      while (due.length > 0) {
        for (const [id, timer] of due) {
          timers.delete(id);
          timer.fn();
        }
        due = [...timers.entries()].filter(([, timer]) => timer.at <= clock);
      }
    },
    sentOf: (type) => sent.filter((command) => command.type === type)
  };
}

function announce(waveId, extra = {}) {
  return {
    type: 'event',
    event: 'wave-announce',
    waveId,
    by: 'peer-' + waveId,
    count: 1,
    lobbyMs: 15000,
    paid: 'verified',
    ...extra
  };
}

test('invariant 1: only wave-announce creates a directory entry', (t) => {
  const { core } = makeCore();

  // Events for an UNKNOWN wave must not create one — a late roster, an echoed unsubscribed, or a
  // racing-sync wave-active would otherwise spawn a phantom by-less bubble.
  core.handle({ type: 'event', event: 'roster', waveId: 'ghost', count: 4 });
  core.handle({ type: 'event', event: 'unsubscribed', waveId: 'ghost' });
  core.handle({
    type: 'event',
    event: 'wave-active',
    waveId: 'ghost',
    count: 4
  });
  core.handle({ type: 'event', event: 'wave-idle', waveId: 'ghost' });
  t.is(core.getSnapshot().waves.size, 0, 'no phantom wave was created');

  core.handle(announce('w1'));
  t.is(core.getSnapshot().waves.size, 1, 'wave-announce creates the entry');

  // …and the same events now UPDATE the known wave.
  core.handle({ type: 'event', event: 'roster', waveId: 'w1', count: 7 });
  t.is(core.getSnapshot().waves.get('w1').count, 7, 'known wave updates');
});

test('invariant 2: an inbound dm is redeemed for ANY wave, not just the active one', (t) => {
  const { core, sentOf } = makeCore();

  core.handle(announce('mine', { mine: true }));
  t.is(core.getSnapshot().activeWaveId, 'mine', 'my wave is active');

  // The tip arrives for a DIFFERENT wave — one the user has navigated away from (or never
  // opened). Routing it "for the active wave only" would silently destroy the sats.
  core.handle({
    type: 'event',
    event: 'dm',
    waveId: 'somewhere-else',
    note: { kind: 'tip', token: 'cashuAbc', amount: 5 }
  });

  t.alike(
    sentOf('redeem'),
    [{ type: 'redeem', token: 'cashuAbc' }],
    'the bearer token was redeemed regardless of the active wave'
  );
  t.is(sentOf('refresh-wallet').length, 1, 'balance refreshed after redeeming');
});

test('invariant 2b: a dm that is not a tip token is ignored', (t) => {
  const { core, sentOf } = makeCore();
  core.handle(announce('w1'));
  core.handle({
    type: 'event',
    event: 'dm',
    waveId: 'w1',
    note: { kind: 'tip', amount: 5 } // stripped announcement — no token to redeem
  });
  t.is(sentOf('redeem').length, 0, 'nothing redeemed without a token');
});

test('invariant 3: the pending capture is staged BEFORE the active wave switches', (t) => {
  const order = [];
  const { core } = makeCore({
    onBeforeSwitchWave: () => order.push('stage')
  });

  core.handle(announce('w1', { mine: true }));
  core.handle(announce('w2'));
  core.subscribe((snapshot, kind) => {
    if (kind === 'select') {
      order.push('active:' + snapshot.activeWaveId);
    }
  });

  core.selectWave('w2');
  t.alike(
    order,
    ['stage', 'active:w2'],
    'the host staged its capture before the switch was published'
  );
});

test('invariant 4: a network change deselects a now-cross-network active wave', (t) => {
  const { core } = makeCore();

  core.handle({ type: 'wallet', unit: 'sat', network: 'testnet' });
  core.handle(announce('w1', { network: 'testnet' }));
  core.selectWave('w1');
  t.is(core.getSnapshot().activeWaveId, 'w1', 'testnet wave is active');

  // The user switches to a mainnet mint: the testnet wave can no longer transact with my wallet.
  core.handle({ type: 'wallet', unit: 'sat', network: 'mainnet' });
  t.is(core.getSnapshot().activeWaveId, null, 'cross-network wave deselected');
  t.is(
    core.waveMatchesNetwork({ network: 'testnet' }),
    false,
    'and it no longer passes the same-network filter'
  );
});

test('invariant 4b: my OWN wave and a same-network wave survive a network change', (t) => {
  const { core } = makeCore();

  core.handle({ type: 'wallet', unit: 'sat', network: 'testnet' });
  core.handle(announce('mine', { mine: true, network: 'testnet' }));
  core.handle({ type: 'wallet', unit: 'sat', network: 'mainnet' });
  t.is(core.getSnapshot().activeWaveId, 'mine', 'my own wave is never dropped');

  // An unknown network on either side is permissive (mirrors the wallet's crossNetworkMints rule).
  t.ok(core.waveMatchesNetwork({ network: 'unknown' }), 'unknown → permissive');
  t.ok(core.waveMatchesNetwork({}), 'absent → permissive');
  t.ok(core.waveMatchesNetwork({ network: 'mainnet' }), 'same → matches');
});

test('invariant 5: an ended wave is unsubscribed when it is dropped', (t) => {
  const { core, sentOf, sent, advance } = makeCore({
    endedTtlMs: 1000,
    fadeMs: 100
  });

  core.handle(announce('w1'));
  core.selectWave('w1');
  t.alike(
    sentOf('subscribe-wave'),
    [{ type: 'subscribe-wave', waveId: 'w1' }],
    'opening a wave subscribes to it (browse-then-pick)'
  );

  core.handle({ type: 'event', event: 'wave-idle', waveId: 'w1' });
  t.is(core.getSnapshot().waves.get('w1').phase, 'ended', 'wave ended');
  t.is(sentOf('unsubscribe-wave').length, 0, 'still browsable during the TTL');

  advance(1000); // TTL elapses → fade
  t.ok(core.getSnapshot().waves.get('w1').fading, 'the wave is fading out');
  t.is(sentOf('unsubscribe-wave').length, 0, 'not yet dropped mid-fade');

  advance(100); // fade completes → drop
  t.alike(
    sentOf('unsubscribe-wave'),
    [{ type: 'unsubscribe-wave', waveId: 'w1' }],
    'its feed cores were freed — the budget stays O(subscribed)'
  );
  t.is(core.getSnapshot().waves.size, 0, 'and it left the directory');
  t.is(core.getSnapshot().activeWaveId, null, 'the view fell back to no wave');
  t.is(sent.at(-1).type, 'unsubscribe-wave', 'unsubscribe is the last command');
});

test('invariant 5b: an unsubscribed wave is dropped without an unsubscribe command', (t) => {
  const { core, sentOf, advance } = makeCore({
    endedTtlMs: 1000,
    fadeMs: 100
  });

  core.handle(announce('w1')); // aware only — never opened, so no cores are held
  core.handle({ type: 'event', event: 'wave-idle', waveId: 'w1' });
  advance(1000); // TTL → fade
  advance(100); // fade → drop
  t.is(core.getSnapshot().waves.size, 0, 'dropped');
  t.is(sentOf('unsubscribe-wave').length, 0, 'no pointless unsubscribe');
});

test('starting a wave supersedes my prior own wave (and frees its cores)', (t) => {
  const { core, sentOf } = makeCore();

  // The engine subscribes the initiator to its own wave, and says so on the announce.
  core.handle(announce('old', { mine: true, subscribed: true }));
  core.handle(announce('new', { mine: true, subscribed: true }));

  t.is(core.getSnapshot().activeWaveId, 'new', 'the new wave is auto-engaged');
  t.absent(core.getSnapshot().waves.get('old'), 'the prior one is gone');
  t.alike(
    sentOf('unsubscribe-wave'),
    [{ type: 'unsubscribe-wave', waveId: 'old' }],
    'and its cores were freed'
  );
});

test('a confirmed tip dms the token privately and floods a stripped note', (t) => {
  const { core, sent } = makeCore();

  core.handle(announce('w1'));
  core.selectWave('w1');
  core.tip({ waveId: 'w1', peerId: 'peer-9', address: 'addr-9', amount: 5 });
  t.alike(
    sent.at(-1),
    { type: 'tip', to: 'addr-9', amount: 5, peerId: 'peer-9' },
    'the tip went out'
  );

  core.handle({ type: 'tip-result', hash: 'cashuTOKEN' });
  const dm = sent.find((command) => command.type === 'dm');
  const note = sent.find((command) => command.type === 'note');
  t.alike(
    dm,
    {
      type: 'dm',
      waveId: 'w1',
      to: 'peer-9',
      note: { kind: 'tip', token: 'cashuTOKEN', amount: 5 }
    },
    'the bearer token went PRIVATELY to the recipient'
  );
  t.alike(
    note,
    { type: 'note', waveId: 'w1', note: { kind: 'tip', amount: 5 } },
    'the flooded note is stripped — no token, no recipient'
  );
});

test('a failed tip announces nothing', (t) => {
  const { core, sentOf } = makeCore();

  core.handle(announce('w1'));
  core.tip({ waveId: 'w1', peerId: 'p', address: 'a', amount: 5 });
  core.handle({ type: 'tip-result', error: 'insufficient balance' });
  t.is(sentOf('dm').length, 0, 'no token delivered');
  t.is(sentOf('note').length, 0, 'no celebration for a tip that never landed');

  // A stray second result must not re-send the choreography for an already-consumed tip.
  core.handle({ type: 'tip-result', hash: 'late' });
  t.is(sentOf('dm').length, 0, 'the remembered tip was consumed once');
});

test('the snapshot maps engine shapes to the app theme', (t) => {
  const { core } = makeCore();

  core.handle({
    type: 'state',
    me: { id: 'me', tag: 'GB' },
    peers: [{ id: 'other', tag: 'JP' }]
  });
  core.handle(announce('w1', { mine: true }));
  core.handle({
    type: 'feed',
    waveId: 'w1',
    items: [
      { peerId: 'other', tag: 'JP', payload: { image: 'x', caption: 'hi' } }
    ]
  });

  const snapshot = core.getSnapshot();
  t.is(snapshot.me.country, 'GB', 'my tag is my country');
  t.is(snapshot.peers[0].country, 'JP', 'a peer tag is its country');
  t.alike(
    { image: snapshot.feed[0].image, caption: snapshot.feed[0].caption },
    { image: 'x', caption: 'hi' },
    'an entry payload is a moment'
  );
  t.is(snapshot.feed[0].country, 'JP', 'and carries the poster country');
});

test('only the active wave feeds the snapshot, but every feed is cached', (t) => {
  const { core } = makeCore();

  core.handle(announce('w1', { mine: true }));
  core.handle(announce('w2'));
  core.handle({
    type: 'feed',
    waveId: 'w2',
    items: [{ peerId: 'p2', payload: { caption: 'w2 moment' } }]
  });
  t.is(core.getSnapshot().feed.length, 0, 'a background feed never paints');

  core.selectWave('w2');
  t.is(core.getSnapshot().feed[0].caption, 'w2 moment', 'cached feed appears');
});

test('a balance-only wallet refresh keeps the mint and network', (t) => {
  const { core } = makeCore();

  core.handle({
    type: 'wallet',
    unit: 'sat',
    mint: 'https://mint',
    network: 'testnet',
    amount: 10
  });
  core.handle({ type: 'wallet', unit: 'sat', amount: 25 });
  const { wallet } = core.getSnapshot();
  t.alike(
    { mint: wallet.mint, network: wallet.network, amount: wallet.amount },
    { mint: 'https://mint', network: 'testnet', amount: 25 },
    'the refresh merged instead of blanking'
  );
});

// --- INVARIANT 6: a dismissed wave stays dismissed -------------------------------------------

test('dismissing a wave frees its cores and drops it from the directory', (t) => {
  const { core, sentOf } = makeCore();

  core.handle(announce('w1'));
  core.selectWave('w1'); // subscribes, so the dismissal must unsubscribe
  core.dismissWave('w1');

  const snapshot = core.getSnapshot();
  t.is(snapshot.waves.size, 0, 'gone from the directory');
  t.is(snapshot.activeWaveId, null, 'and deselected, since it was active');
  t.is(sentOf('unsubscribe-wave').length, 1, 'its cores were freed');
});

test('a dismissed wave is not resurrected by continuing gossip', (t) => {
  const { core } = makeCore();

  core.handle(announce('w1'));
  core.dismissWave('w1');
  // the engine keeps talking about a live wave: a re-announce, a roster update, a start
  core.handle(announce('w1'));
  core.handle({ type: 'event', event: 'roster', waveId: 'w1', count: 9 });
  core.handle({ type: 'event', event: 'wave-active', waveId: 'w1', count: 9 });
  core.handle({
    type: 'feed',
    waveId: 'w1',
    items: [{ peerId: 'p1', payload: { caption: 'nope' } }]
  });

  t.is(core.getSnapshot().waves.size, 0, 'it stayed gone');
});

test('dismissing MY OWN wave stops it auto-selecting itself again', (t) => {
  const { core } = makeCore();

  core.handle(announce('w1', { mine: true }));
  t.is(core.getSnapshot().activeWaveId, 'w1', 'my wave auto-engaged');

  core.dismissWave('w1');
  core.handle(announce('w1', { mine: true })); // a re-announce of the same wave

  const snapshot = core.getSnapshot();
  t.is(snapshot.activeWaveId, null, 'it did not re-engage');
  t.is(snapshot.waves.size, 0, 'nor reappear in the directory');
});

// Invariant 6 must never override invariant 2: dismissing a wave is a VIEWING choice, and a tip
// token addressed to me is money. Routing the dm "only for waves I still watch" would destroy it.
test('a tip dm for a dismissed wave is still redeemed', (t) => {
  const { core, sentOf } = makeCore();

  core.handle(announce('w1'));
  core.dismissWave('w1');
  core.handle({
    type: 'event',
    event: 'dm',
    waveId: 'w1',
    note: { kind: 'tip', token: 'cashuAbc', amount: 5 }
  });

  const redeems = sentOf('redeem');
  t.is(redeems.length, 1, 'the token was redeemed');
  t.is(redeems[0].token, 'cashuAbc', 'the right token');
});

test('dismissing one wave leaves the others alone', (t) => {
  const { core } = makeCore();

  core.handle(announce('w1'));
  core.handle(announce('w2'));
  core.dismissWave('w1');
  core.handle({ type: 'event', event: 'roster', waveId: 'w2', count: 4 });

  const snapshot = core.getSnapshot();
  t.is(snapshot.waves.size, 1, 'only the dismissed one went');
  t.is(snapshot.waves.get('w2').count, 4, 'the survivor still updates');
});
