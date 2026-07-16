// The gossip message seam (messages.js): every factory builds a message its own kind's
// validator accepts once the uniform envelope (origin/ts/sig, + mid on flooded kinds) is
// stamped, and the validators reject unknown kinds, a missing envelope, missing fields, and
// mistyped fields while tolerating unknown extras. validGossip checks SHAPE only — the
// envelope signature is verified separately (attest.verifyMessage, tested in attest.test.js).
// Pure — no swarm. Runs under Bare:  bare lib/messages.test.js   (or `npm test`)
const test = require('brittle');
const {
  FLOODED_KINDS,
  validGossip,
  makeHeartbeat,
  makeSubs,
  makeWaveAnnounce,
  makeWaveJoin,
  makeWaveStart,
  makeWaveSync
} = require('./messages');

const PEER = 'ab'.repeat(32); // origin (author) — a 32-byte ring id in hex
const OTHER = 'cd'.repeat(32);
const WAVE = '12'.repeat(16);
const MID = 'ef'.repeat(8);
const SIG = '00'.repeat(64);
const CRED = { peerId: OTHER, writerKey: 'ee'.repeat(32), joinSig: SIG };

// Stamp the uniform envelope (origin/ts/sig) exactly as wave.js's originate() does — with a
// well-typed (but not cryptographically real — validGossip is shape-only) signature.
function sealed(msg) {
  return { ...msg, origin: PEER, ts: 1719705612080, sig: SIG };
}

// Stamp the flood mid exactly like originateFlood does before sealing.
function flooded(msg) {
  return sealed({ ...msg, mid: MID });
}

test('every factory builds a message its validator accepts once sealed', (t) => {
  t.ok(validGossip(sealed(makeHeartbeat({ tag: 'BR' }))), 'heartbeat');
  t.ok(
    validGossip(sealed(makeHeartbeat({}))),
    'heartbeat tag defaults to null'
  );
  t.ok(validGossip(sealed(makeSubs({ subs: [WAVE] }))), 'subs');
  t.ok(
    validGossip(sealed(makeSubs({ subs: [] }))),
    'empty subs (subscribed to nothing)'
  );
  t.absent(
    validGossip(sealed({ kind: 'subs', subs: [PEER] })),
    'subs rejects non-waveIds'
  );
  t.ok(
    validGossip(flooded(makeWaveAnnounce({ waveId: WAVE, lobbyMs: 15000 }))),
    'wave-announce'
  );
  t.ok(
    validGossip(
      flooded(
        makeWaveJoin({ waveId: WAVE, writerKey: CRED.writerKey, joinSig: SIG })
      )
    ),
    'wave-join (origin is the joiner)'
  );
  t.ok(
    validGossip(
      flooded(
        makeWaveStart({
          waveId: WAVE,
          writers: [CRED],
          t0: 1719705612080,
          lapMs: 8000
        })
      )
    ),
    'wave-start'
  );
  t.ok(
    validGossip(
      sealed(
        makeWaveSync({
          waveId: WAVE,
          phase: 'lobby',
          by: PEER,
          writers: [CRED],
          lobbyMsLeft: 4000
        })
      )
    ),
    'wave-sync (lobby: no sweep timing yet; `by` is the initiator)'
  );
  t.ok(
    validGossip(
      sealed(
        makeWaveSync({
          waveId: WAVE,
          phase: 'racing',
          by: PEER,
          writers: [],
          t0: 1719705612080,
          lapMs: 8000,
          lobbyMsLeft: 0
        })
      )
    ),
    'wave-sync (racing: carries the sweep timing)'
  );
});

test('the uniform envelope is required on every kind', (t) => {
  const heartbeat = makeHeartbeat({ tag: 'BR' });
  t.absent(validGossip(heartbeat), 'no envelope → rejected');
  t.absent(
    validGossip({ ...heartbeat, origin: PEER, ts: 1 }),
    'missing sig → rejected'
  );
  t.absent(
    validGossip({ ...heartbeat, origin: 'not-hex', ts: 1, sig: SIG }),
    'malformed origin → rejected'
  );
  t.absent(
    validGossip({ ...heartbeat, origin: PEER, ts: 'soon', sig: SIG }),
    'non-numeric ts → rejected'
  );
  const join = makeWaveJoin({
    waveId: WAVE,
    writerKey: CRED.writerKey,
    joinSig: SIG
  });
  t.absent(
    validGossip(sealed(join)),
    'flooded kind without its mid → rejected (mid is separate from the envelope)'
  );
});

test('optional attestations ride only when present', (t) => {
  const paid = { waveId: WAVE, sig: SIG };
  const unpaid = makeWaveAnnounce({ waveId: WAVE, lobbyMs: 1 });
  const paidMsg = makeWaveAnnounce({
    waveId: WAVE,
    lobbyMs: 1,
    paid,
    walletType: 'tron-nile'
  });
  t.absent('paid' in unpaid, 'no paid key on the unpaid path');
  t.absent(
    'walletType' in unpaid,
    'no walletType on an unpaid/wallet-less wave'
  );
  t.is(paidMsg.paid, paid, 'the proof rides when present');
  t.is(paidMsg.walletType, 'tron-nile', 'the wallet type rides on a paid wave');
  const burnless = makeWaveJoin({
    waveId: WAVE,
    writerKey: CRED.writerKey,
    joinSig: SIG
  });
  t.absent('burn' in burnless, 'no burn key before the fee confirms');
});

test('walletType is an optional string on the paid-carrying kinds', (t) => {
  t.ok(
    validGossip(
      flooded(
        makeWaveAnnounce({ waveId: WAVE, lobbyMs: 1, walletType: 'tron-nile' })
      )
    ),
    'wave-announce accepts a walletType'
  );
  t.ok(
    validGossip(
      flooded(
        makeWaveStart({
          waveId: WAVE,
          writers: [],
          t0: 1,
          lapMs: 1,
          walletType: 'btc'
        })
      )
    ),
    'wave-start accepts a walletType'
  );
  t.absent(
    validGossip(
      flooded(makeWaveAnnounce({ waveId: WAVE, lobbyMs: 1, walletType: 42 }))
    ),
    'a non-string walletType is rejected'
  );
});

test('factories carry no author field (origin is the author)', (t) => {
  t.absent('id' in makeHeartbeat({ tag: 'BR' }), 'heartbeat has no id');
  t.absent(
    'peerId' in
      makeWaveJoin({ waveId: WAVE, writerKey: CRED.writerKey, joinSig: SIG }),
    'wave-join has no peerId'
  );
  t.absent(
    'by' in makeWaveAnnounce({ waveId: WAVE, lobbyMs: 1 }),
    'wave-announce has no by'
  );
  t.absent(
    'by' in makeWaveStart({ waveId: WAVE, writers: [], t0: 1, lapMs: 1 }),
    'wave-start has no by'
  );
  t.ok(
    'by' in
      makeWaveSync({
        waveId: WAVE,
        phase: 'lobby',
        by: PEER,
        writers: [],
        lobbyMsLeft: 0
      }),
    'wave-sync keeps `by` (the initiator, distinct from origin)'
  );
});

test('unknown kinds and non-objects are rejected', (t) => {
  t.absent(validGossip(null));
  t.absent(validGossip('heartbeat'));
  t.absent(
    validGossip(sealed({ kind: 'token', waveId: WAVE })),
    'unknown kind'
  );
  t.absent(validGossip(sealed({ id: PEER })), 'missing kind');
});

test('missing or mistyped payload fields are rejected per kind', (t) => {
  t.absent(
    validGossip(sealed({ kind: 'heartbeat', tag: 'X'.repeat(9) })),
    'oversized tag'
  );
  t.absent(
    validGossip(flooded(makeWaveAnnounce({ waveId: 'short', lobbyMs: 1 }))),
    'malformed waveId'
  );
  t.absent(
    validGossip(flooded(makeWaveAnnounce({ waveId: WAVE, lobbyMs: '15000' }))),
    'stringly-typed lobbyMs'
  );
  t.absent(
    validGossip(
      flooded(
        makeWaveJoin({
          waveId: WAVE,
          writerKey: CRED.writerKey,
          joinSig: undefined
        })
      )
    ),
    'join without its attestation'
  );
  t.absent(
    validGossip(
      flooded(
        makeWaveStart({
          waveId: WAVE,
          writers: [{ peerId: OTHER }], // credential missing writerKey/joinSig
          t0: 1,
          lapMs: 1
        })
      )
    ),
    'malformed writers entry'
  );
  t.absent(
    validGossip(
      flooded(
        makeWaveStart({ waveId: WAVE, writers: [], t0: Infinity, lapMs: 1 })
      )
    ),
    'non-finite t0'
  );
  t.absent(
    validGossip(
      sealed(
        makeWaveSync({
          waveId: WAVE,
          phase: 'sprinting',
          by: PEER,
          writers: [],
          lobbyMsLeft: 0
        })
      )
    ),
    'unknown phase'
  );
});

test('unknown extra fields are tolerated (forward compat)', (t) => {
  const msg = flooded(
    makeWaveJoin({ waveId: WAVE, writerKey: CRED.writerKey, joinSig: SIG })
  );
  t.ok(validGossip({ ...msg, futureField: 42 }));
});

test('the flooded/direct classification matches the kinds', (t) => {
  t.alike(
    [...FLOODED_KINDS].sort(),
    ['wave-announce', 'wave-join', 'wave-start'],
    'three flooded kinds'
  );
  t.absent(FLOODED_KINDS.has('heartbeat'), 'heartbeat is one-hop');
  t.absent(FLOODED_KINDS.has('subs'), 'subs is one-hop');
  t.absent(FLOODED_KINDS.has('wave-sync'), 'wave-sync is unicast');
});
