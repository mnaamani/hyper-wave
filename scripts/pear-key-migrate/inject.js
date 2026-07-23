#!/usr/bin/env node
'use strict';

// Register a supplied write keypair for a Pear app link into THIS machine's
// Pear platform corestore. This is exactly what `pear touch` does
// (`corestore.get({ keyPair }); await core.ready()`), except the keypair is
// the one exported by extract.js instead of a fresh random one.
//
// After this runs the link is writable here, so `pear stage <link>` /
// `pear seed <link>` work. Refuses to run if a core for the link already
// exists in the target store (honours the abort-if-exists guard).
//
// Pear must be shut down first (`pear shutdown`).
//
// FORK HAZARD: two machines holding the same write key must NEVER both
// append. After injecting here, stop staging on the origin machine for good.
//
// Usage:
//   node inject.js --link pear://<z32> --in <file> [--store <dir>] [--force]

const fs = require('fs');
const os = require('os');
const path = require('path');
const b4a = require('b4a');
const Corestore = require('corestore');
const crypto = require('hypercore-crypto');
const idEnc = require('hypercore-id-encoding');

const DEFAULT_STORE = path.join(
  os.homedir(),
  'Library/Application Support/pear/corestores/platform'
);

function usage() {
  process.stderr.write(
    'Usage: node inject.js --link pear://<z32> --in <file> ' +
      '[--store <dir>] [--force]\n'
  );
}

function parseArgs(argv) {
  const args = {
    link: null,
    in: null,
    store: DEFAULT_STORE,
    force: false,
    help: false
  };
  const handlers = {
    '--link': (next) => {
      args.link = next;
    },
    '--in': (next) => {
      args.in = next;
    },
    '--store': (next) => {
      args.store = next;
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token === '--force') {
      args.force = true;
      continue;
    }
    const handler = handlers[token];
    if (!handler) {
      throw new Error(`Unknown argument: ${token}`);
    }
    i += 1;
    handler(argv[i]);
  }
  return args;
}

function fail(message, err) {
  process.stderr.write(`\nerror: ${message}\n`);
  if (err) {
    process.stderr.write(`${err.stack || err.message || err}\n`);
  }
  process.exit(1);
}

function fingerprint(secretKey) {
  const digest = crypto.hash(secretKey);
  return b4a.toString(digest.subarray(0, 8), 'hex');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.link || !args.in) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const publicKey = idEnc.decode(args.link);
  const normalized = idEnc.normalize(publicKey);
  const discoveryKey = crypto.discoveryKey(publicKey);

  const record = JSON.parse(fs.readFileSync(args.in, 'utf8'));
  const secretKey = b4a.from(record.secretKey, 'hex');
  const recordPublic = b4a.from(record.publicKey, 'hex');

  // Integrity: the link, the record's public key, and the public half
  // embedded in the ed25519 secret key must all agree.
  if (!b4a.equals(recordPublic, publicKey)) {
    fail("--in file's publicKey does not match --link.");
  }
  if (
    secretKey.length !== 64 ||
    !b4a.equals(secretKey.subarray(32), publicKey)
  ) {
    fail('Secret key does not correspond to the link public key.');
  }

  const keyPair = { publicKey, secretKey };

  const store = new Corestore(args.store);
  try {
    await store.ready();
  } catch (err) {
    fail(
      'Could not open the platform corestore. Shut Pear down first ' +
        '(`pear shutdown`).',
      err
    );
  }

  const exists = await store.storage.hasCore(discoveryKey);
  if (exists && !args.force) {
    await store.close();
    fail(
      `A core for ${args.link} already exists in ${args.store}. ` +
        'Refusing to clobber. Sync content AFTER injecting into a clean ' +
        'store, or pass --force if you are certain.'
    );
  }

  const core = store.get({ keyPair, exclusive: true });
  await core.ready();
  const writable = core.writable;
  await core.close();
  await store.close();

  if (!writable) {
    fail('Registration completed but the core is not writable.');
  }

  process.stdout.write(`\nInjected write key for pear://${normalized}\n`);
  process.stdout.write(`  target store : ${args.store}\n`);
  process.stdout.write(`  secret fp    : ${fingerprint(secretKey)}\n`);
  process.stdout.write('  writable     : yes\n\n');
  process.stdout.write(
    'Next: restart Pear, then `pear seed pear://' +
      normalized +
      '` (with the\norigin machine seeding) to pull the drive up to its ' +
      'current length before\nstaging. Verify with `pear info pear://' +
      normalized +
      '`. Never stage from the\norigin machine again.\n'
  );
}

main().catch((err) => fail('unexpected failure', err));
