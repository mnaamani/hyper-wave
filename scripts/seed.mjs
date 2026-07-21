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
function capture(bin, argv) {
  return execFileSync(bin, argv, { encoding: 'utf8' });
}
// Synchronous sleep for the retry backoff (this whole script is synchronous execFileSync calls).
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
// Retry a flaky step (the multi-GB artifact downloads time out on a network blip). Re-throws once
// the attempts are exhausted so a genuine failure still surfaces.
function withRetries(label, fn) {
  const MAX_ATTEMPTS = 4;
  const BACKOFF_MS = 5000;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      fn();
      return;
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) {
        throw err;
      }
      const waitMs = BACKOFF_MS * attempt;
      const firstLine = String(err.message || err).split('\n')[0];
      console.error(
        `  ${label} failed (attempt ${attempt}/${MAX_ATTEMPTS}): ` +
          `${firstLine} — retrying in ${waitMs / 1000}s`
      );
      sleepMs(waitMs);
    }
  }
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
  // A STABLE per-run dir (not mkdtemp) so a re-run after a network failure resumes: artifacts that
  // already finished are skipped via their marker instead of re-pulling all ~GBs. gh api needs
  // owner/repo explicitly, so infer it from the checkout when --repo wasn't passed.
  const tmp = path.join(os.tmpdir(), `hw-ota-${runId}`);
  const downloads = path.join(tmp, 'dl');
  fs.mkdirSync(downloads, { recursive: true });
  const repoSlug =
    repo ||
    capture('gh', [
      'repo',
      'view',
      '--json',
      'nameWithOwner',
      '-q',
      '.nameWithOwner'
    ]).trim();

  // Download each OTA payload artifact SEPARATELY, with retries. `gh run download --pattern` pulls
  // every platform's payload (~2+ GB total) in one non-resumable shot, so a single TCP timeout
  // discards the whole transfer. A per-artifact loop retries only the one that failed and skips any
  // already fully pulled (the `.download-complete` marker) so re-running `stage` picks up where it
  // stopped.
  const artifactNames = capture('gh', [
    'api',
    `repos/${repoSlug}/actions/runs/${runId}/artifacts`,
    '--paginate',
    '-q',
    '.artifacts[].name'
  ])
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => name.startsWith('ota-'));
  if (artifactNames.length === 0) {
    console.error(`No ota-* artifacts found on run ${runId}.`);
    process.exit(1);
  }
  for (const name of artifactNames) {
    const dest = path.join(downloads, name);
    const doneMarker = path.join(dest, '.download-complete');
    if (fs.existsSync(doneMarker)) {
      console.log(`  ✓ ${name} (already downloaded)`);
      continue;
    }
    // A partial dir from a prior aborted attempt would confuse gh — start it clean.
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    withRetries(name, () => {
      run('gh', [
        'run',
        'download',
        runId,
        '--name',
        name,
        '--dir',
        dest,
        ...(repo ? ['--repo', repo] : [])
      ]);
    });
    fs.writeFileSync(doneMarker, '');
  }

  // Merge each artifact's by-arch/<platform-arch>/app (+ one package.json) into one deploy tree.
  // Rebuilt from scratch each run so a resumed download can't merge a stale prior tree.
  const deploy = path.join(tmp, 'ota-deploy');
  fs.rmSync(deploy, { recursive: true, force: true });
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
