// Vendor the Bare native addons (udx-native, sodium-native, rocksdb-native, …) the engine needs
// for ANDROID into react-native-bare-kit, whose gradle module picks up
// `android/src/main/addons` as a jniLibs source set.
//
// This is the Android twin of link-ios-addons.mjs, and it exists for the same monorepo reason.
// react-native-bare-kit DOES run its own `link.mjs` (a gradle `preBuild` task, unlike iOS where
// CocoaPods skips the podspec's prepare_command) — but that script scans from the package's
// grandparent, i.e. the WORKSPACE ROOT, which in this npm-workspaces repo has no addon
// dependencies at all: they're reachable from mobile/ (via hyperwave-engine), not from the root.
// A scan of the root finds nothing, so the app would ship without addons and the worklet's dlopen
// would fail at runtime. Running bare-link ourselves from mobile/ writes the real .so files in
// first; gradle's own task then runs, finds nothing to add, and leaves them in place.
//
// bare-link only packages prebuilds the addon packages already ship — no NDK or compiler needed
// for this step (building the APP still needs the Android SDK/NDK).
import link from 'bare-link';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// The ABIs react-native-bare-kit itself links for (android/link.mjs).
const HOSTS = ['android-arm64', 'android-arm', 'android-ia32', 'android-x64'];

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // mobile/
const rnbk = path.resolve(appDir, '../node_modules/react-native-bare-kit');
const out = path.join(rnbk, 'android', 'src', 'main', 'addons');

if (!fs.existsSync(rnbk)) {
  console.log(
    '[link-android-addons] react-native-bare-kit not installed — skipping'
  );
  process.exit(0);
}

for await (const _ of link(appDir, { hosts: HOSTS, out })) {
  // resources are written as they resolve; we just need it to run to completion
}

// Count the shared objects actually written, per ABI — an empty tree here is exactly the failure
// this script exists to prevent, so make it visible rather than silently "done".
function countLibs(dir) {
  if (!fs.existsSync(dir)) {
    return 0;
  }
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      total += countLibs(path.join(dir, entry.name));
    } else if (entry.name.endsWith('.so')) {
      total += 1;
    }
  }
  return total;
}

const libs = countLibs(out);
console.log(
  `[link-android-addons] vendored ${libs} addon libraries -> ${path.relative(appDir, out)}`
);
if (libs === 0) {
  console.warn(
    '[link-android-addons] WARNING: no addon libraries were written — the app will fail to ' +
      'dlopen them at runtime. Check that the engine + its addon deps are installed.'
  );
}
