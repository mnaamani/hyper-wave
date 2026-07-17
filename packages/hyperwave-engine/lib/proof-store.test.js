// The persistent per-mint proof store (proof-store.js): roundtrip + persistence +
// corruption tolerance. Uses real bare-fs against a temp file. Runs under Bare:
//   bare lib/proof-store.test.js   (or `npm test`)
const test = require('brittle');
const fs = require('bare-fs');
const { ProofStore } = require('./proof-store');

const MINT_A = 'https://mint-a.example';
const MINT_B = 'https://mint-b.example';
const proof = (amount) => ({ amount, secret: 's' + amount, id: 'k', C: 'c' });

function tempFile() {
  return '/tmp/hyperwave-proofstore-' + Date.now() + '-' + Math.random();
}

test('proofs persist per mint across restarts, and total sums across mints', (t) => {
  const file = tempFile();
  t.teardown(() => fs.rmSync(file, { force: true }));

  const store = new ProofStore({ file, fs });
  store.add(MINT_A, [proof(2), proof(8)]);
  store.add(MINT_B, [proof(5)]);
  t.is(store.total(), 15, 'total sums proofs across all mints');
  t.alike(store.mints().sort(), [MINT_A, MINT_B].sort(), 'tracks both mints');

  // A fresh instance over the same file sees the persisted proofs.
  const reopened = new ProofStore({ file, fs });
  t.is(reopened.total(), 15, 'proofs survive a restart');
  t.is(reopened.get(MINT_A).length, 2, 'per-mint proofs restored');

  // set() replaces a mint's proofs (the swap-change case); empty removes it.
  reopened.set(MINT_A, [proof(1)]);
  t.is(reopened.total(), 6, 'set replaces a mint bucket');
  reopened.set(MINT_B, []);
  t.absent(reopened.mints().includes(MINT_B), 'empty set drops the mint');
});

test('history is newest-first and persists; a corrupt file starts empty', (t) => {
  const file = tempFile();
  t.teardown(() => fs.rmSync(file, { force: true }));

  const store = new ProofStore({ file, fs });
  store.addHistory({ kind: 'burn', amount: 2 });
  store.addHistory({ kind: 'send', amount: 5 });
  t.is(store.history()[0].kind, 'send', 'newest first');
  t.is(new ProofStore({ file, fs }).history().length, 2, 'history persists');

  // A corrupt store must not throw or lose the process — it starts empty.
  fs.writeFileSync(file, '{ not json');
  const logs = [];
  const recovered = new ProofStore({ file, fs, log: (...a) => logs.push(a) });
  t.is(recovered.total(), 0, 'corrupt store starts empty (no crash)');
  t.ok(logs.length > 0, 'and surfaces the parse failure to the host');
});
