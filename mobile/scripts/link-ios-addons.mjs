// Vendor the Bare native addons (udx-native, sodium-native, rocksdb-native, …) the engine needs
// for iOS into react-native-bare-kit, where its podspec vendors `ios/addons/*.xcframework`.
//
// react-native-bare-kit ships this exact step as its podspec `prepare_command` (`ios/link.mjs`),
// but (a) CocoaPods skips prepare_command for local path pods — how node_modules pods install —
// and (b) that script scans from the *repo root*, which in this npm-workspaces monorepo has no
// addon dependencies. So we run `bare-link` ourselves from mobile/ (which reaches the addons
// via hyperwave) and write into the hoisted react-native-bare-kit. bare-link just
// packages the iOS prebuilds the addon packages already ship — no compiler needed, runs anywhere.
import link from 'bare-link';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // mobile/
const rnbk = path.resolve(appDir, '../node_modules/react-native-bare-kit');
const out = path.join(rnbk, 'ios', 'addons');

if (!fs.existsSync(rnbk)) {
  console.log(
    '[link-ios-addons] react-native-bare-kit not installed — skipping'
  );
  process.exit(0);
}

for await (const _ of link(appDir, {
  hosts: ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator'],
  out
})) {
  // resources are written as they resolve; we just need it to run to completion
}

const vendoredCount = fs.existsSync(out)
  ? fs.readdirSync(out).filter((name) => name.endsWith('.xcframework')).length
  : 0;
console.log(
  `[link-ios-addons] vendored  addon xcframeworks -> ${path.relative(appDir, out)}`
);
