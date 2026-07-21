# Releasing HyperWave (desktop)

Publishing is **two things**, both keyed by the same `pear://` link in `package.json#upgrade`
(currently `pear://pwfsihrajqdzscrheaegd5n98xfo8qik9q4cpixjdenjniri718y`, minted with `pear touch`):

- **Installers** — the `.dmg` / `.msix` / `.AppImage` a new user downloads. Installer makers are
  **OS-native** (dmg→macOS, msix→Windows, AppImage/Snap/Flatpak→Linux), so you **can't cross-build
  them on one machine** — CI builds each on its own runner.
- **OTA update** — how an _already-installed_ app updates itself, served peer-to-peer by
  `pear-runtime` from a Hyperdrive at the upgrade link.

## Architecture — build in CI, seed on a persistent host

A Hyperdrive is **single-writer**, and CI storage is ephemeral (a runner's `/tmp` is destroyed when
the job ends, and `pear-ci` doesn't wait for peers to replicate). So seeding **cannot** be done from
CI durably. Split the two concerns:

```
GitHub Actions (release.yml)                 Always-on host (the SOLE writer/seeder)
  ├─ make-pear-app per platform  ──────┐       ┌─ gh run download (ota-* artifacts)
  │   → installers (artifacts)         │       ├─ pear stage <link>   (append the new version)
  └─ ota-payload per platform  ────────┴──────►└─ pear seed  <link>   (serve forever, systemd)
      → ota-<plat>-<arch> artifacts               ↑ installed apps replicate from here
```

- **CI** builds the installers **and** uploads each platform's raw app in the pear-runtime OTA
  layout (`ota-<platform-arch>` artifacts). It does **not** stage/seed.
- **One always-on host** downloads those artifacts, `pear stage`s them onto the drive, and
  `pear seed`s forever. Because it _produces_ the blocks locally, there's **no replication race** —
  availability never depends on the CI runner's lifetime.

> Only this host may `stage` (single-writer). For redundancy add **read-only** seeders elsewhere —
> `pear seed <link>` needs only the public link, not the key — that replicate from it and re-serve.

---

## One-time: stand up the seeder host

A cheap always-on box (small VPS / a Pi / a home server) with a public-ish network path (Hyperswarm
hole-punches, but a reachable host is more reliable):

1. Install **Node**, the **`pear` CLI**, and the **`gh` CLI** (authenticated: `gh auth login`, scopes
   repo + actions:read).
2. Put the **Pear identity that owns the upgrade link** on the host (the one you `pear touch`'d it
   with) — needed to `stage`. (If you're moving hosts, mint a fresh link with `pear touch` there and
   update `package.json#upgrade`.)
3. Check out this repo on the host.
4. Install the seeder service:

   ```sh
   sudo cp deploy/hyperwave-seeder.service /etc/systemd/system/
   # edit User / WorkingDirectory / the pear bin dir in PATH= to match the host
   sudo systemctl daemon-reload
   sudo systemctl enable --now hyperwave-seeder
   journalctl -u hyperwave-seeder -f
   ```

   (`ExecStart` is `node scripts/seed.mjs seed` = `pear seed <link>`.)

---

## Cut a release

1. Merge your branch → `main`; **bump `package.json#version`** (pear-runtime only applies a _higher_
   version).
2. Tag + push → CI builds installers on every platform and uploads the `ota-*` payloads:

   ```sh
   git tag v0.1.0 && git push origin v0.1.0
   ```

3. On the seeder host, publish the OTA update from that run (as the same user as the service, so it
   shares the Pear store):

   ```sh
   node scripts/seed.mjs stage --run <github-actions-run-id>   # [--repo owner/repo]
   ```

   This downloads the `ota-*` artifacts, merges them into one `by-arch/<plat>-<arch>/app` tree, and
   `pear stage`s it. The running `seed` service serves the new version immediately.

4. Grab the installers from the run's artifacts and attach them to a GitHub Release for new
   downloads.

Signing is optional (unsigned is fine for **alpha** — Gatekeeper/SmartScreen warnings; Linux
unaffected). To sign, add the secrets listed atop `release.yml`; unset ⇒ unsigned.

---

## Alternative: no host, macOS only

If you just want to seed from your Mac (not durable — only up while your Mac is), build + seed
locally:

```sh
export PATH="$HOME/Library/Application Support/pear/bin:$PATH"
# bump package.json#version first
npm run package        # → out/HyperWave-darwin-arm64/HyperWave.app
npm run ota:deploy     # → out/ota-deploy/  (assembles whatever platforms are in out/)
cd out/ota-deploy
pear stage <link>
pear seed  <link>      # keep running to seed
```

`ota:deploy` only wraps the platforms present in `out/`, so this seeds macOS only; use the host
flow for a multi-platform OTA.

---

## How OTA reaches users

Installed apps run `workers/updater.js` (a `pear-runtime` client) which joins the upgrade drive's
swarm and pulls a higher version, surfaced by `renderer/updater.js`. `npm start` passes
`--no-updates` so dev runs don't self-update.

## Verify

- `pear info <link>` shows the staged version (the link currently reports `[ Empty ]` — nothing
  published yet).
- Install an older build, launch, confirm it updates from the seeder.
