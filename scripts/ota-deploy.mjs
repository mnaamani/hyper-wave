// Assemble the pear-runtime OTA deployment folder from electron-forge's package output.
//
//   node scripts/ota-deploy.mjs        (or: npm run ota:deploy)
//
// pear-runtime distributes updates from a Hyperdrive keyed by package.json#upgrade. Its README
// wants a deployment folder shaped:
//
//   <deploy>/package.json
//   <deploy>/by-arch/<platform>-<arch>/app/     <- the built app (electron-forge's package dir)
//
// This wraps every `out/HyperWave-<platform>-<arch>/` that `npm run package` (or `npm run make`)
// produced into that layout at `out/ota-deploy/`, then prints the `pear stage` / `pear seed`
// commands. Those two need the `pear` CLI on PATH and YOUR Pear identity (the one that minted the
// upgrade link) — see RELEASE.md. NB: pear-runtime only applies an update whose version is HIGHER,
// so bump package.json#version before building each release.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'out');
const deploy = path.join(outDir, 'ota-deploy');

const pkg = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8')
);
const APP = pkg.productName || pkg.name; // 'HyperWave'
const packageDirRe = new RegExp(`^${APP}-(darwin|win32|linux)-[^/]+$`);

if (!fs.existsSync(outDir)) {
  console.error('No out/ — run `npm run package` (or `npm run make`) first.');
  process.exit(1);
}
const packageDirs = fs
  .readdirSync(outDir)
  .filter((name) => packageDirRe.test(name));
if (packageDirs.length === 0) {
  console.error(
    `No packaged app in out/ (expected ${APP}-<platform>-<arch>/). ` +
      'Run `npm run package` first.'
  );
  process.exit(1);
}

fs.rmSync(deploy, { recursive: true, force: true });
fs.mkdirSync(path.join(deploy, 'by-arch'), { recursive: true });
fs.copyFileSync(
  path.join(root, 'package.json'),
  path.join(deploy, 'package.json')
);

for (const dir of packageDirs) {
  const platformArch = dir.slice(APP.length + 1); // 'darwin-arm64'
  const dest = path.join(deploy, 'by-arch', platformArch, 'app');
  fs.cpSync(path.join(outDir, dir), dest, { recursive: true });
  console.log(`  + ${platformArch}`);
}

console.log(`\nOTA deploy folder ready: ${path.relative(root, deploy)}`);
console.log('Publish the update (needs `pear` on PATH + your Pear identity):');
console.log(`  cd ${path.relative(root, deploy)}`);
console.log(`  pear stage ${pkg.upgrade}`);
console.log(
  `  pear seed ${pkg.upgrade}   # keep running to seed to installed apps`
);
