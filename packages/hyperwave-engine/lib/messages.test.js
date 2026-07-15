// The gossip message seam (messages.js): every factory builds a message its own kind's
// validator accepts (after the flood mid is stamped, as floodGossip does), and the
// validators reject unknown kinds, missing fields, and mistyped fields while tolerating
// unknown extras. Pure — no swarm. Runs under Bare:
//   bare lib/messages.test.js   (or `npm test`)
const test = require('brittle');
const {
  FLOODED_KINDS,
  validGossip,
  makeHeartbeat,
  makeWaveAnnounce,
  makeWaveJoin,
  makeWaveStart,
  makeWaveSync
} = require('./messages');

const PEER = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const WAVE = '12'.repeat(16);
const MID = 'ef'.repeat(8);
const SIG = '00'.repeat(64);
const CRED = { peerId: OTHER, writerKey: 'ee'.repeat(32), joinSig: SIG };

// Stamp the flood mid exactly like floodGossip does before broadcast.
function flooded(msg) {
  return { ...msg, mid: MID };
}

test('every factory builds a message its validator accepts', (t) => {
  t.ok(validGossip(makeHeartbeat({ id: PEER, tag: 'BR' })), 'heartbeat');
  t.ok(
    validGossip(makeHeartbeat({ id: PEER })),
    'heartbeat tag defaults to null'
  );
  t.ok(
    validGossip(
      flooded(makeWaveAnnounce({ waveId: WAVE, by: PEER, lobbyMs: 15000 }))
    ),
    'wave-announce'
  );
  t.ok(
    validGossip(flooded(makeWaveJoin({ waveId: WAVE, ...CRED }))),
    'wave-join'
  );
  t.ok(
    validGossip(
      flooded(
        makeWaveStart({
          waveId: WAVE,
          by: PEER,
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
      makeWaveSync({
        waveId: WAVE,
        phase: 'lobby',
        by: PEER,
        writers: [CRED],
        lobbyMsLeft: 4000
      })
    ),
    'wave-sync (lobby: no sweep timing yet)'
  );
  t.ok(
    validGossip(
      makeWaveSync({
        waveId: WAVE,
        phase: 'racing',
        by: PEER,
        writers: [],
        t0: 1719705612080,
        lapMs: 8000,
        lobbyMsLeft: 0
      })
    ),
    'wave-sync (racing: carries the sweep timing)'
  );
});

test('optional attestations ride only when present', (t) => {
  const paid = { waveId: WAVE, sig: SIG };
  const unpaid = makeWaveAnnounce({ waveId: WAVE, by: PEER, lobbyMs: 1 });
  const paidMsg = makeWaveAnnounce({
    waveId: WAVE,
    by: PEER,
    lobbyMs: 1,
    paid
  });
  t.absent('paid' in unpaid, 'no paid key on the unpaid path');
  t.is(paidMsg.paid, paid, 'the proof rides when present');
  const burnless = makeWaveJoin({ waveId: WAVE, ...CRED });
  t.absent('burn' in burnless, 'no burn key before the fee confirms');
});

test('unknown kinds and non-objects are rejected', (t) => {
  t.absent(validGossip(null));
  t.absent(validGossip('heartbeat'));
  t.absent(validGossip({ kind: 'token', waveId: WAVE }), 'unknown kind');
  t.absent(validGossip({ id: PEER }), 'missing kind');
});

test('missing or mistyped fields are rejected per kind', (t) => {
  t.absent(validGossip({ kind: 'heartbeat', id: 'not-hex' }), 'bad id');
  t.absent(
    validGossip({ kind: 'heartbeat', id: PEER, tag: 'X'.repeat(9) }),
    'oversized tag'
  );
  t.absent(
    validGossip(makeWaveAnnounce({ waveId: WAVE, by: PEER, lobbyMs: 15000 })),
    'flooded kind without its mid'
  );
  t.absent(
    validGossip(
      flooded(makeWaveAnnounce({ waveId: 'short', by: PEER, lobbyMs: 1 }))
    ),
    'malformed waveId'
  );
  t.absent(
    validGossip(
      flooded(makeWaveAnnounce({ waveId: WAVE, by: PEER, lobbyMs: '15000' }))
    ),
    'stringly-typed lobbyMs'
  );
  t.absent(
    validGossip(
      flooded(makeWaveJoin({ waveId: WAVE, ...CRED, joinSig: undefined }))
    ),
    'join without its attestation'
  );
  t.absent(
    validGossip(
      flooded(
        makeWaveStart({
          waveId: WAVE,
          by: PEER,
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
        makeWaveStart({
          waveId: WAVE,
          by: PEER,
          writers: [],
          t0: Infinity,
          lapMs: 1
        })
      )
    ),
    'non-finite t0'
  );
  t.absent(
    validGossip(
      makeWaveSync({
        waveId: WAVE,
        phase: 'sprinting',
        by: PEER,
        writers: [],
        lobbyMsLeft: 0
      })
    ),
    'unknown phase'
  );
});

test('unknown extra fields are tolerated (forward compat)', (t) => {
  const msg = flooded(makeWaveJoin({ waveId: WAVE, ...CRED }));
  t.ok(validGossip({ ...msg, futureField: 42 }));
});

test('the flooded/direct classification matches the five kinds', (t) => {
  t.alike(
    [...FLOODED_KINDS].sort(),
    ['wave-announce', 'wave-join', 'wave-start'],
    'three flooded kinds'
  );
  t.absent(FLOODED_KINDS.has('heartbeat'), 'heartbeat is one-hop');
  t.absent(FLOODED_KINDS.has('wave-sync'), 'wave-sync is unicast');
});
