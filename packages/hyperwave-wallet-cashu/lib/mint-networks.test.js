// Mint → network classification (mint-networks.js): pure, offline. This is the
// data behind the paid-gate's cross-network filter, so its correctness is what
// keeps real money from mixing with test money.
//   bare lib/mint-networks.test.js   (or `npm test`)
const test = require('brittle');
const {
  KNOWN_MINTS,
  networkOfMint,
  crossNetworkMints
} = require('./mint-networks');

test('KNOWN_MINTS is the shared curated list (url + label + network)', (t) => {
  t.ok(KNOWN_MINTS.length >= 1, 'has entries');
  for (const mint of KNOWN_MINTS) {
    t.ok(typeof mint.url === 'string' && mint.url, 'entry has a url');
    t.ok(typeof mint.label === 'string' && mint.label, 'entry has a label');
    t.ok(
      mint.network === 'testnet' || mint.network === 'mainnet',
      'entry declares a known network'
    );
    // The list and the classifier must agree — they're one source of truth.
    t.is(
      networkOfMint(mint.url),
      mint.network,
      `${mint.url} classifies to its declared network`
    );
  }
});

test('an app-added mint is classified via extraMints', (t) => {
  const extra = [{ url: 'https://my.app.mint', network: 'mainnet' }];
  t.is(
    networkOfMint('https://my.app.mint', extra),
    'mainnet',
    'an app-added mint classifies from extraMints'
  );
  t.is(
    networkOfMint('https://my.app.mint'),
    'unknown',
    'without extraMints the same mint is unknown (permissive)'
  );
  t.ok(
    crossNetworkMints(
      'https://my.app.mint',
      'https://testnut.cashu.space',
      extra
    ),
    'app-added mainnet vs testnet → cross-network once extraMints is supplied'
  );
});

test('networkOfMint classifies known mints, testnut markers, and unknowns', (t) => {
  t.is(
    networkOfMint('https://testnut.cashu.space'),
    'testnet',
    'the free test mint is testnet'
  );
  t.is(
    networkOfMint('https://nofee.testnut.cashu.space'),
    'testnet',
    'a testnut subdomain falls through to the testnet heuristic'
  );
  t.is(
    networkOfMint('https://mint.minibits.cash/Bitcoin'),
    'mainnet',
    'a known real mint is mainnet (path ignored)'
  );
  t.is(
    networkOfMint('https://mint.coinos.io'),
    'mainnet',
    'a second known real mint is mainnet'
  );
  t.is(
    networkOfMint('https://21mint.me'),
    'mainnet',
    'a third known real mint is mainnet'
  );
  t.is(
    networkOfMint('https://some.custom.mint.example'),
    'unknown',
    'an unlisted mint is unknown'
  );
  t.is(networkOfMint(''), 'unknown', 'empty → unknown');
  t.is(networkOfMint(undefined), 'unknown', 'missing → unknown');
});

test('crossNetworkMints only flags DEFINITIVE test-vs-main mismatches', (t) => {
  t.ok(
    crossNetworkMints('https://testnut.cashu.space', 'https://mint.coinos.io'),
    'testnet burn vs mainnet wallet → cross-network (filtered)'
  );
  t.ok(
    crossNetworkMints(
      'https://mint.minibits.cash/Bitcoin',
      'https://testnut.cashu.space'
    ),
    'mainnet burn vs testnet wallet → cross-network (filtered)'
  );
  t.absent(
    crossNetworkMints(
      'https://mint.minibits.cash/Bitcoin',
      'https://mint.coinos.io'
    ),
    'two mainnet mints → same network (any mint interoperates)'
  );
  t.absent(
    crossNetworkMints(
      'https://testnut.cashu.space',
      'https://nofee.testnut.cashu.space'
    ),
    'two test mints → same network'
  );
  t.absent(
    crossNetworkMints(
      'https://some.custom.mint.example',
      'https://mint.coinos.io'
    ),
    'unknown mint is permissive — never a cross-network rejection'
  );
  t.absent(
    crossNetworkMints('https://mint.coinos.io', 'https://mint.coinos.io'),
    'identical mint → not cross-network'
  );
});
