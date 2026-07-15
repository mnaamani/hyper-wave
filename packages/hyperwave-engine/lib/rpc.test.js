// The host<->UI IPC seam (rpc.js): does a UI driving `createRpcClient` reach a real `createEngine`
// (fake wave + fake payments) wired through `serveEngine`, over an in-memory duplex pair — with
// request/response commands correlating their replies even under concurrency, and notifications
// streaming back as one-way events? This is the whole seam end-to-end without a network or the two
// process hosts. Runs under Bare:  bare lib/rpc.test.js   (or `npm test`)
const test = require('brittle');
const { Duplex } = require('streamx');
const FramedStream = require('framed-stream');
const { createEngine } = require('./engine');
const { serveEngine, createRpcClient } = require('./rpc');

// Two cross-wired in-memory duplex streams: whatever one end writes surfaces as the other's data.
function duplexPair() {
  let left = null;
  let right = null;
  left = new Duplex({
    write(data, cb) {
      right.push(data);
      cb();
    }
  });
  right = new Duplex({
    write(data, cb) {
      left.push(data);
      cb();
    }
  });
  return [left, right];
}

// The same fake wave engine.test.js uses: records the calls the engine makes, hands back its
// option callbacks so the test can fire wave events.
function fakeWave() {
  const calls = [];
  return {
    me: { id: 'ab'.repeat(32), angle: 12.3 },
    calls,
    opts: null,
    startWave: () => {
      calls.push('startWave');
      return 'wave-1';
    },
    join: () => 'wave-1',
    announcePaid: (paid) => calls.push(['announcePaid', paid]),
    setTag: (tag) => calls.push(['setTag', tag]),
    stageEntry: (entry) => calls.push(['stageEntry', entry]),
    setWallet: (addr) => calls.push(['setWallet', addr]),
    close: async () => calls.push('close')
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Stand up the full seam: engine (fake wave + optional fake payments) <-serveEngine-> duplex pair
// <-createRpcClient-> UI. Returns the client `call`, the recorded wave calls, and captured events.
function standUp({ payments } = {}) {
  const wave = fakeWave();
  const events = [];
  const [hostStream, uiStream] = duplexPair();

  const seam = serveEngine({ stream: hostStream });
  const engine = createEngine({
    storageDir: '/tmp/rpc-seam',
    config: {},
    emit: seam.emit,
    log: () => {},
    deps: {
      createWave: (opts) => {
        wave.opts = opts;
        return wave;
      },
      createPayments: payments
        ? async () => payments
        : async () => {
            throw new Error('no wallet in this test');
          }
    }
  });
  seam.attach(engine);

  const client = createRpcClient({
    stream: uiStream,
    onEvent: (msg) => events.push(msg)
  });

  return { wave, events, call: client.call, engine, seam };
}

test('fire-and-forget commands reach the engine, and engine events stream back to the UI', async (t) => {
  const { wave, events, call, engine } = standUp();
  t.teardown(() => engine.close());

  // engine -> UI: the wave protocol's callbacks arrive at the client as one-way events
  wave.opts.emit({ type: 'state', me: wave.me, peers: [] });
  wave.opts.emit({ type: 'event', event: 'started', waveId: 'wave-1' });
  wave.opts.emit({ type: 'feed', items: [{ payload: { hi: 1 } }] });
  await flush();
  t.ok(
    events.find((msg) => msg.type === 'state') &&
      events.find((msg) => msg.type === 'event' && msg.event === 'started') &&
      events.find((msg) => msg.type === 'feed' && msg.items.length === 1),
    'state / event / feed forwarded to the UI as events'
  );

  // UI -> engine: fire-and-forget commands reach the wave protocol (no reply awaited)
  call('set-tag', { tag: 'JP' });
  call('stage-entry', { entry: { payload: { a: 1 } } });
  call('start-wave');
  await flush();
  t.alike(
    wave.calls,
    [['setTag', 'JP'], ['stageEntry', { payload: { a: 1 } }], 'startWave'],
    'set-tag / stage-entry / start-wave routed across the seam'
  );
});

test('request/response commands correlate their replies — even with two in flight', async (t) => {
  // A wallet whose send() is deliberately slower for the FIRST recipient, so the replies arrive
  // out of call order — the seam must still route each result to the caller that asked for it.
  const pay = {
    address: 'Tme',
    balances: async () => ({ address: 'Tme', trx: 100 }),
    send: async (to, amount) => {
      await delay(to === 'Tslow' ? 40 : 5);
      return { hash: to + '-hash', to, amount };
    },
    transactions: async () => [{ hash: 'h', direction: 'in', amount: 5 }],
    dispose: () => {}
  };
  const { call, engine } = standUp({ payments: pay });
  t.teardown(() => engine.close());
  await flush(); // wallet init settles

  // two tips in flight: Tslow requested first but resolves last
  const [slow, fast] = await Promise.all([
    call('tip', { to: 'Tslow', amount: 1 }),
    call('tip', { to: 'Tfast', amount: 2 })
  ]);
  t.is(slow.type, 'tip-result', 'first call resolves with a tip-result');
  t.is(slow.to, 'Tslow', 'the slow reply routed back to the slow caller');
  t.is(slow.hash, 'Tslow-hash', 'with the slow tip hash');
  t.is(fast.to, 'Tfast', 'the fast reply routed back to the fast caller');
  t.is(fast.hash, 'Tfast-hash', 'with the fast tip hash');
  t.absent(
    'id' in slow,
    'the internal correlation id is stripped before the UI sees it'
  );

  // send-trx and fetch-transactions likewise resolve with their terminal result
  const sent = await call('send-trx', { to: 'Tfriend', amount: 3 });
  t.is(sent.type, 'send-result', 'send-trx resolves with send-result');
  t.is(sent.hash, 'Tfriend-hash', 'the send hash routes back');
  const txs = await call('fetch-transactions');
  t.is(txs.type, 'transactions', 'fetch-transactions resolves with the list');
  t.is(txs.list.length, 1, 'carrying the on-chain history');
});

test('request/response replies are ALSO surfaced through onEvent (event-oriented UIs)', async (t) => {
  const pay = {
    address: 'Tme',
    balances: async () => ({ address: 'Tme', trx: 100 }),
    send: async (to, amount) => ({ hash: 'h', to, amount }),
    transactions: async () => [],
    dispose: () => {}
  };
  const { call, events, engine } = standUp({ payments: pay });
  t.teardown(() => engine.close());
  await flush();

  await call('tip', { to: 'Tx', amount: 1 });
  // the desktop ipc.on('tip-result') / RN switch keep working with no change: the reply reaches
  // them through the same onEvent stream as one-way notifications.
  t.is(
    events.filter((msg) => msg.type === 'tip-result').length,
    1,
    'the tip-result reply arrived as an event too'
  );
});

test('onBootstrap builds the engine lazily from a first command (the mobile init path)', async (t) => {
  const wave = fakeWave();
  const events = [];
  const [hostStream, uiStream] = duplexPair();

  let engine = null;
  const seam = serveEngine({
    stream: hostStream,
    // mirrors worklet/app.js: the engine can't exist until `init` brings the storageDir
    onBootstrap: (command) => {
      if (command.type === 'init' && !engine) {
        engine = createEngine({
          storageDir: '/tmp/rpc-boot',
          config: { wallet: false },
          emit: seam.emit,
          log: () => {},
          deps: {
            createWave: (opts) => {
              wave.opts = opts;
              return wave;
            }
          }
        });
        seam.attach(engine);
      }
    }
  });
  const client = createRpcClient({
    stream: uiStream,
    onEvent: (msg) => events.push(msg)
  });
  t.teardown(() => engine && engine.close());

  // no engine yet — the init command constructs it, then a later command reaches the wave protocol
  client.call('init', { storageDir: 'ignored', config: {} });
  await flush();
  t.ok(engine, 'the init command built the engine via onBootstrap');
  client.call('set-tag', { tag: 'PT' });
  await flush();
  t.alike(
    wave.calls,
    [['setTag', 'PT']],
    'a command after bootstrap reaches the engine'
  );
});

test('the seam rides FramedStream — the transport both real hosts actually use', async (t) => {
  // The desktop worker and the mobile worklet both wrap their IPC pipe in FramedStream before
  // handing it to the seam. bare-rpc does its own length-prefix framing on top, so this proves
  // the two framings compose (no double-frame corruption) over the real transport shape.
  const [rawHost, rawUi] = duplexPair();
  const framedHost = new FramedStream(rawHost);
  const framedUi = new FramedStream(rawUi);
  const wave = fakeWave();
  const events = [];

  const seam = serveEngine({ stream: framedHost });
  const engine = createEngine({
    storageDir: '/tmp/rpc-framed',
    config: { wallet: false },
    emit: seam.emit,
    log: () => {},
    deps: {
      createWave: (opts) => {
        wave.opts = opts;
        return wave;
      }
    }
  });
  seam.attach(engine);
  const client = createRpcClient({
    stream: framedUi,
    onEvent: (msg) => events.push(msg)
  });
  t.teardown(() => engine.close());

  client.call('set-tag', { tag: 'BR' });
  wave.opts.emit({ type: 'event', event: 'started', waveId: 'w' });
  await flush();
  t.alike(
    wave.calls,
    [['setTag', 'BR']],
    'a command rode FramedStream to the engine'
  );
  t.ok(
    events.find((msg) => msg.type === 'event' && msg.event === 'started'),
    'an engine event rode FramedStream back to the UI'
  );
});

test('a request/response command still resolves (not hangs) on the engine error path', async (t) => {
  // No wallet -> handleTip emits a tip-result error. The awaiting call must resolve with that
  // error, not hang forever.
  const { call, engine } = standUp();
  t.teardown(() => engine.close());
  await flush();

  const result = await call('tip', { to: 'Tx', amount: 1 });
  t.is(result.type, 'tip-result', 'error still comes back as a tip-result');
  t.is(result.error, 'wallet not ready', 'carrying the failure reason');
});
