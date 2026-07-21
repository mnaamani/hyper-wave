// Durable OTA seeder — host tooling. Building (per-OS installers + the by-arch app payloads)
// happens in CI; SEEDING must persist, so it runs on an always-on host that is the SOLE writer of
// the upgrade Hyperdrive (a Hyperdrive is single-writer — do NOT also stage from CI, or the drive
// forks). CI storage is ephemeral, so this host owns the blocks and serves them forever.
//
//   node scripts/seed.mjs seed                     # the always-on seeder — run under systemd
//   node scripts/seed.mjs stage --run <run-id>     # publish a release: pull CI artifacts + pear stage
//
// The running `seed` service serves whatever is staged into the shared Pear store, so a `stage`
// run's new version goes live to it automatically. Prereqs on the host:
//   - `pear` on PATH + the Pear identity that OWNS the upgrade link (needed to `stage`; seeding
//     itself only needs the public link),
//   - `gh` CLI authenticated with repo + actions:read (for `stage` to download the run artifacts),
//   - Node + this repo checked out (for the assembly + package.json#upgrade).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const cmd = args[0];
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const link = flag('--link') || pkg.upgrade;

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function run(bin, argv) {
  console.log('$', bin, argv.join(' '));
  execFileSync(bin, argv, { stdio: 'inherit' });
}

function seed() {
  // The always-on part: serve the upgrade drive forever. Seeding replicates a public drive, so it
  // needs only the link (no key). Run this under a supervisor (systemd/pm2) — see RELEASE.md.
  run('pear', ['seed', link]);
}

function stage() {
  const runId = flag('--run');
  if (!runId) {
    console.error('stage needs --run <github-actions-run-id>');
    process.exit(1);
  }
  const repo = flag('--repo'); // owner/repo — optional; gh infers it from the git remote
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-ota-'));
  const downloads = path.join(tmp, 'dl');
  fs.mkdirSync(downloads, { recursive: true });

  // Pull every platform's OTA payload artifact from the CI run.
  run('gh', [
    'run',
    'download',
    runId,
    '--pattern',
    'ota-*',
    '--dir',
    downloads,
    ...(repo ? ['--repo', repo] : [])
  ]);

  // Merge each artifact's by-arch/<platform-arch>/app (+ one package.json) into one deploy tree.
  const deploy = path.join(tmp, 'ota-deploy');
  fs.mkdirSync(path.join(deploy, 'by-arch'), { recursive: true });
  let wrotePackageJson = false;
  for (const artifact of fs.readdirSync(downloads)) {
    const base = path.join(downloads, artifact);
    if (!fs.statSync(base).isDirectory()) {
      continue;
    }
    const artifactPkg = path.join(base, 'package.json');
    if (!wrotePackageJson && fs.existsSync(artifactPkg)) {
      fs.copyFileSync(artifactPkg, path.join(deploy, 'package.json'));
      wrotePackageJson = true;
    }
    const byArch = path.join(base, 'by-arch');
    if (!fs.existsSync(byArch)) {
      continue;
    }
    for (const platformArch of fs.readdirSync(byArch)) {
      fs.cpSync(
        path.join(byArch, platformArch),
        path.join(deploy, 'by-arch', platformArch),
        { recursive: true }
      );
      console.log('  + ' + platformArch);
    }
  }
  if (!wrotePackageJson) {
    console.error('No package.json found in the downloaded ota-* artifacts.');
    process.exit(1);
  }

  // Append this release to the upgrade drive. The running `seed` service (same Pear store) then
  // serves it; installed apps on a lower version update on next launch.
  run('pear', ['stage', link, deploy]);
  console.log(
    `\nStaged to ${link}. The always-on 'seed' service will serve it.`
  );
}

const commands = { seed, stage };
if (!commands[cmd]) {
  console.log(
    'usage: node scripts/seed.mjs seed | stage --run <run-id> ' +
      '[--repo owner/repo] [--link pear://…]'
  );
  process.exit(1);
}
commands[cmd]();
