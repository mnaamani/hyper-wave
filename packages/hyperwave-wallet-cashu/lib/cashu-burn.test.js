// Pure structural burn verification (cashu-burn.js): builds real P2PK secrets
// with cashu-ts (offline — no mint) and checks every gate branch. Runs under Bare:
//   bare lib/cashu-burn.test.js   (or `npm test`)
const test = require('brittle');
const { installBareWebShims } = require('./bare-web-shims');
const { numsBurnPubkey } = require('./nums');
const { verifyBurnProofs, burnTags, p2pkLockPubkey } = require('./cashu-burn');
const { burnMemo } = require('hyperwave-engine');

installBareWebShims();

const WAVE = 'wave-deadbeef';
const PEER = 'peer-cafef00d';

// Build a synthetic proof carrying a P2PK secret locked to `pubkey` with `tags`.
// verifyBurnProofs reads only { amount, secret }, so this is enough (no mint).
function lockedProof(cashu, { amount, pubkey, tags }) {
  return {
    amount,
    secret: cashu.createP2PKsecret(pubkey, tags),
    id: 'k',
    C: 'c'
  };
}

test('verifyBurnProofs accepts an honest burn and rejects tampering', async (t) => {
  const cashu = await import('@cashu/cashu-ts');
  const nums = await numsBurnPubkey();
  const memo = burnMemo(WAVE, PEER);
  const proofs = [
    lockedProof(cashu, { amount: 2, pubkey: nums.pubkey, tags: burnTags(memo) })
  ];

  t.alike(
    verifyBurnProofs({
      proofs,
      numsPubkey: nums.pubkey,
      cashu,
      expect: { waveId: WAVE, minAmount: 2 }
    }),
    { ok: true },
    'honest burn (locked to NUMS, memo commits the wave, amount ok)'
  );

  t.is(
    verifyBurnProofs({
      proofs,
      numsPubkey: nums.pubkey,
      cashu,
      expect: { waveId: 'other-wave' }
    }).reason,
    'memo-mismatch',
    'a burn for another wave is rejected'
  );

  t.is(
    verifyBurnProofs({
      proofs,
      numsPubkey: nums.pubkey,
      cashu,
      expect: { minAmount: 100 }
    }).reason,
    'amount-too-low',
    'below the required fee is rejected'
  );

  // Locked to some OTHER key (not the NUMS black hole) = recoverable = not a burn.
  const notBurned = [
    lockedProof(cashu, {
      amount: 2,
      pubkey: '02' + 'a'.repeat(64),
      tags: burnTags(memo)
    })
  ];
  t.is(
    verifyBurnProofs({
      proofs: notBurned,
      numsPubkey: nums.pubkey,
      cashu,
      expect: {}
    }).reason,
    'not-burned',
    'ecash locked to a spendable key is not a burn'
  );

  t.is(
    verifyBurnProofs({ proofs: [], numsPubkey: nums.pubkey, cashu, expect: {} })
      .reason,
    'no-proofs',
    'an empty token is rejected'
  );
});

test('p2pkLockPubkey reads the lock target (the received-tip guard)', async (t) => {
  const cashu = await import('@cashu/cashu-ts');
  const recipient = '02' + 'b'.repeat(64);
  const locked = cashu.createP2PKsecret(recipient, []);
  t.is(
    p2pkLockPubkey(locked, cashu),
    recipient,
    'returns the pubkey a P2PK secret is locked to'
  );
  // A plain (non-P2PK) secret is just a random hex string — not a lock.
  t.is(
    p2pkLockPubkey('deadbeef', cashu),
    null,
    'a non-P2PK secret has no lock target'
  );
});
