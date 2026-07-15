// The host-agnostic engine (engine.js): does it route host commands to the wave protocol and
// forward engine events to `emit`, in both the no-wallet and wallet-ready paths? Runs with
// FAKE wave + payments factories (injected via `deps`), so no real swarm / no network — this
// is exactly what the extraction bought: the engine is testable without a host. Runs under Bare:
//   bare lib/engine.test.js   (or `npm test`)
const test = require('brittle');
const { createEngine } = require('./engine');

// A fake wave that records the calls the engine makes on it, and hands the engine the option
// callback so the test can fire wave events (emit) itself.
function fakeWave() {
  const calls = [];
  const wave = {
    me: { id: 'ab'.repeat(32), angle: 12.3 },
    calls,
    opts: null,
    startWave: () => {
      calls.push('startWave');
      return 'wave-1';
    },
    join: () => {
      calls.push('join');
      return 'wave-1';
    },
    announcePaid: (paid) => calls.push(['announcePaid', paid]),
    setTag: (tag) => calls.push(['setTag', tag]),
    stageEntry: (entry) => calls.push(['stageEntry', entry]),
    setWallet: (addr) => calls.push(['setWallet', addr]),
    close: async () => calls.push('close')
  };
  return wave;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0)); // let the async wallet init settle

test('the engine routes commands to the wave protocol and forwards its events to emit', async (t) => {
  const sent = [];
  const wave = fakeWave();
  const engine = createEngine({
    storageDir: '/tmp/e',
    config: { topicId: 'm', bootstrap: '' },
    emit: (msg) => sent.push(msg),
    log: () => {},
    deps: {
      createWave: (opts) => {
        wave.opts = opts;
        return wave;
      },
      createPayments: async () => {
        throw new Error('no wallet in this test');
      }
    }
  });
  t.teardown(() => engine.close());

  // the wave now emits fully-formed { type, … } messages straight to `emit` (the engine passes it
  // through, no per-kind wrapping), so the fake fires them directly
  wave.opts.emit({ type: 'state', me: wave.me, peers: [] });
  wave.opts.emit({ type: 'event', event: 'started', waveId: 'wave-1' });
  wave.opts.emit({ type: 'feed', items: [{ caption: 'hi' }] });
  t.ok(
    sent.find((msg) => msg.type === 'state') &&
      sent.find((msg) => msg.type === 'event' && msg.event === 'started') &&
      sent.find((msg) => msg.type === 'feed' && msg.items.length === 1),
    'state / event / feed messages forwarded through emit'
  );

  // plain commands are dispatched to the engine
  engine.exec({ type: 'set-tag', tag: 'JP' });
  engine.exec({ type: 'stage-entry', entry: 'data:image/jpeg;base64,xxx' });
  engine.exec({ type: 'start-wave' });
  t.alike(
    wave.calls,
    [
      ['setTag', 'JP'],
      ['stageEntry', 'data:image/jpeg;base64,xxx'],
      'startWave'
    ],
    'set-tag / stage-entry / start-wave routed to the wave protocol'
  );

  // a typo'd / unknown command surfaces an error instead of silently no-op'ing, and doesn't
  // reach the wave protocol
  const callsBefore = wave.calls.length;
  engine.exec({ type: 'stage-entery', entry: 'oops' }); // typo
  engine.exec({ type: 42 }); // non-string type
  engine.exec(null); // not even an object
  t.is(
    wave.calls.length,
    callsBefore,
    'bad commands never reach the wave protocol'
  );
  t.is(
    sent.filter((msg) => msg.type === 'error' && msg.scope === 'command')
      .length,
    3,
    'each malformed / unknown command raises a { type:error, scope:command }'
  );
  t.ok(
    sent.find((msg) => msg.type === 'error' && msg.command === 'stage-entery'),
    'the error echoes the offending command type (not the payload)'
  );

  await flush();
  // with no wallet, a tip is refused rather than silently dropped
  engine.exec({ type: 'tip', to: 'Trecipient', amount: 1 });
  await flush();
  t.ok(
    sent.find(
      (msg) => msg.type === 'tip-result' && msg.error === 'wallet not ready'
    ),
    'tip with no wallet returns an error result'
  );
  t.ok(
    sent.find((msg) => msg.type === 'wallet' && msg.error),
    'a wallet init failure surfaces a { wallet, error } message (no balance)'
  );
  t.absent(
    sent.find((msg) => msg.type === 'wallet' && msg.address),
    'no wallet balance message when the wallet failed to init'
  );
});

test('the engine wires a ready wallet into the wave protocol and pushes the balance + pays tips', async (t) => {
  const sent = [];
  const wave = fakeWave();
  const tipped = [];
  const pay = {
    address: 'Tmywallet',
    balances: async () => ({ address: 'Tmywallet', trx: 7 }),
    send: async (to, amount) => {
      tipped.push([to, amount]);
      return { hash: 'f'.repeat(64) };
    },
    transactions: async () => [
      {
        hash: 'a'.repeat(64),
        direction: 'in',
        amount: 5,
        timestamp: 1,
        memo: ''
      }
    ],
    dispose: () => {}
  };
  const engine = createEngine({
    storageDir: '/tmp/e',
    config: {},
    emit: (msg) => sent.push(msg),
    log: () => {},
    deps: {
      createWave: (opts) => {
        wave.opts = opts;
        return wave;
      },
      createPayments: async () => pay
    }
  });
  t.teardown(() => engine.close());

  await flush(); // wallet init resolves
  t.ok(
    sent.find(
      (msg) =>
        msg.type === 'wallet' && msg.address === 'Tmywallet' && msg.trx === 7
    ),
    'balance pushed to the host once the wallet is ready'
  );
  t.ok(
    wave.calls.find(
      (call) =>
        Array.isArray(call) &&
        call[0] === 'setWallet' &&
        call[1] === 'Tmywallet'
    ),
    'the wallet is wired into the wave protocol (setWallet)'
  );

  engine.exec({ type: 'tip', to: 'Trecipient', amount: 2 });
  await flush();
  t.alike(tipped, [['Trecipient', 2]], 'tip forwarded to payments.send');
  t.ok(
    sent.find(
      (msg) => msg.type === 'tip-result' && msg.hash && msg.to === 'Trecipient'
    ),
    'tip-result with the tx hash returned to the host'
  );

  engine.exec({ type: 'send-trx', to: 'Tfriend', amount: 3 });
  await flush();
  t.alike(tipped.at(-1), ['Tfriend', 3], 'send-trx forwarded to payments.send');
  t.ok(
    sent.find(
      (msg) =>
        msg.type === 'send-result' &&
        msg.hash &&
        msg.to === 'Tfriend' &&
        msg.amount === 3
    ),
    'send-result with the tx hash returned to the host'
  );

  engine.exec({ type: 'fetch-transactions' });
  await flush();
  const txMsg = sent.find((msg) => msg.type === 'transactions');
  t.ok(
    txMsg && txMsg.list.length === 1 && txMsg.list[0].direction === 'in',
    'on-chain history forwarded'
  );
});
