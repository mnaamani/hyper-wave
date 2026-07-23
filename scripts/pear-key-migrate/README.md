# pear-key-migrate

Move the **write capability** for a Pear app link (e.g. the desktop
`upgrade` link in the root `package.json`) from the machine that created it
to another machine, so all future `pear stage` / release steps run there.

## How it works

A Pear link's write capability is an ed25519 keypair whose secret key Pear
stores in a per-core auth record inside the platform corestore
(`~/Library/Application Support/pear/corestores/platform`). It is **not** a
file you can `cp`, and it is **not** re-derivable (`pear touch` generates it
from a random name that is immediately discarded).

`pear touch`, at its core, is just:

```js
const core = corestore.get({ keyPair, exclusive: true });
await core.ready(); // persists the keypair's secret into the corestore
```

- **`extract.js`** reads that persisted keypair out of the origin store.
- **`inject.js`** runs the *same* `get({ keyPair })` registration on the
  target machine with the exported keypair — a faithful "touch with a
  supplied key". No rocksdb surgery.

`pear stage` decides writability purely by opening the drive by key and
checking whether the loaded auth record has a secret — so once injected, the
target can stage.

## ⚠️ Fork hazard (the one rule that matters)

Two machines holding the same write key must **never both append**. Doing so
forks the hypercore and corrupts the drive. The whole point here is to move
the writer, so: **after injecting, never `pear stage` from the origin machine
again.** Keep the origin around only as a seeder/backup.

## Requirements

- Node (or `bare`) with this repo's `node_modules` resolvable — the scripts
  require `corestore`, `hypercore-crypto`, `hypercore-id-encoding`, `b4a`.
  On the target machine, run them from a checkout of this repo after
  `npm install`.
- **Pear shut down on whichever machine a script touches** (`pear shutdown`) —
  the sidecar holds an exclusive lock on the platform corestore.
- The scripts default `--store` to the macOS platform corestore path; pass
  `--store <dir>` on Linux/Windows or for a test store.

## Procedure

Do a dry run with a throwaway link first (see below), then:

1. **Origin machine** — stop Pear and extract:
   ```
   pear shutdown
   node scripts/pear-key-migrate/extract.js --link pear://<z32>
   ```
   Writes `~/pear-writekey-<prefix>.json` (chmod 600) and prints a secret
   fingerprint. Note it.

2. **Transfer** the JSON to the target over an encrypted channel only
   (`scp`, or `age`-encrypt then copy). Never paste it anywhere.

3. **Target machine** — stop Pear and inject into a *clean* store (no existing
   core for the link; inject aborts otherwise):
   ```
   pear shutdown
   node scripts/pear-key-migrate/inject.js \
     --link pear://<z32> --in ./pear-writekey-<prefix>.json
   ```
   Confirm the printed secret fingerprint matches step 1.

4. **Target machine** — restart Pear and sync the drive up to its current
   length, with the origin machine online and seeding
   (`pear seed pear://<z32>` on the origin):
   ```
   pear seed pear://<z32>       # pull content; leave running until synced
   pear info pear://<z32>       # sanity-check
   pear stage pear://<z32> .    # now writable here
   ```

5. **Shred** every copy of the JSON on both machines
   (`shred -u` / `rm -P`), and never stage from the origin again.

## Validate with a throwaway link first

Because this pokes Pear's platform store, prove the round trip end-to-end
before touching the real `upgrade` link:

```
# origin
pear touch                      # note the pear://<z32> it prints
mkdir -p /tmp/testapp && echo hi > /tmp/testapp/x.txt
pear stage pear://<z32> /tmp/testapp
pear shutdown
node scripts/pear-key-migrate/extract.js --link pear://<z32>

# target (after transferring the json)
pear shutdown
node scripts/pear-key-migrate/inject.js --link pear://<z32> --in <json>
# restart pear, seed from origin, then:
echo bye >> /tmp/testapp/x.txt
pear stage pear://<z32> /tmp/testapp   # must succeed and bump the version
```

If the target stage succeeds and the version increments without a fork error,
the real migration is safe. This also surfaces any corestore version mismatch
harmlessly (Pear may bundle a slightly different corestore point release than
this repo's `node_modules`).

## Alternative: the supported path

If you'd rather not depend on Pear's internal storage format, Pear's built-in
`multisig`/`provision` flow is designed for releasing from a machine that does
not hold a single master secret (portable *signer* keys, revocable, no secret
copied). It's a bigger change to the OTA model but strictly more robust.
