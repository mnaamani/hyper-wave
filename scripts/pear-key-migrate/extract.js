#!/usr/bin/env node
'use strict';

// Extract the write keypair for a Pear app link out of a local Pear
// platform corestore, so it can be re-registered on another machine
// (see inject.js). Read-only: opens the store, reads the persisted
// per-core auth record for the link, writes the keypair to a 0600 file.
//
// Pear must be shut down first (`pear shutdown`) — the sidecar holds an
// exclusive lock on the platform corestore's rocksdb.
//
// Usage:
//   node extract.js --link pear://<z32> [--out <file>] [--store <dir>]

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
    'Usage: node extract.js --link pear://<z32> ' +
      '[--out <file>] [--store <dir>]\n'
  );
}

function parseArgs(argv) {
  const args = { link: null, out: null, store: DEFAULT_STORE, help: false };
  const handlers = {
    '--link': (next) => {
      args.link = next;
    },
    '--out': (next) => {
      args.out = next;
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
  if (args.help || !args.link) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const publicKey = idEnc.decode(args.link);
  const normalized = idEnc.normalize(publicKey);
  const discoveryKey = crypto.discoveryKey(publicKey);
  const outPath =
    args.out ||
    path.join(os.homedir(), `pear-writekey-${normalized.slice(0, 12)}.json`);

  const store = new Corestore(args.store);
  try {
    await store.ready();
  } catch (err) {
    fail(
      'Could not open the platform corestore. Shut Pear down first ' +
        '(`pear shutdown`) — the sidecar locks it while running.',
      err
    );
  }

  const exists = await store.storage.hasCore(discoveryKey);
  if (!exists) {
    await store.close();
    fail(
      `No core for ${args.link} in this store (${args.store}). ` +
        'Wrong --store, or this machine never held the link.'
    );
  }

  const core = store.get({ key: publicKey });
  await core.ready();

  const keyPair = core.keyPair;
  const hasSecret =
    core.writable && keyPair && keyPair.secretKey && keyPair.secretKey.length;
  if (!hasSecret) {
    await core.close();
    await store.close();
    fail(
      'This store holds a READ-ONLY replica of the link (no write key). ' +
        'Run extract.js on the machine that created the link.'
    );
  }

  const record = {
    link: `pear://${normalized}`,
    publicKey: b4a.toString(keyPair.publicKey, 'hex'),
    secretKey: b4a.toString(keyPair.secretKey, 'hex'),
    length: core.length,
    exportedFrom: os.hostname()
  };

  await core.close();
  await store.close();

  fs.writeFileSync(outPath, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.chmodSync(outPath, 0o600);

  process.stdout.write(`\nExtracted write key for ${record.link}\n`);
  process.stdout.write(`  drive length : ${record.length}\n`);
  process.stdout.write(`  secret fp    : ${fingerprint(keyPair.secretKey)}\n`);
  process.stdout.write(`  written to   : ${outPath} (chmod 600)\n\n`);
  process.stdout.write(
    'Move this file to the target machine over an encrypted channel only ' +
      '(scp/age),\nverify the secret fp matches after inject.js, then shred ' +
      'every copy.\n'
  );
}

main().catch((err) => fail('unexpected failure', err));
