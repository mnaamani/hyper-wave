# HyperWave mobile (Expo + Bare)

A **scaffold** that runs the shared HyperWave engine (`hyperwave-lib-core`) on iOS/Android by
hosting it in a Bare worklet via [`react-native-bare-kit`](https://github.com/holepunchto/react-native-bare-kit).
The engine — the wave race, gallery, and WDK wallet — is the **same code** the desktop app runs;
only the host (this Expo app) and the UI differ.

## How it fits together

```
Expo RN app (this package)                 Bare worklet (hyperwave-lib-core)
  App.js  ── useEngine() ──► FramedStream ⇄ IPC ⇄ FramedStream ──► worklet/app.js ──► createCore
  (React UI)                 (JSON messages)                        (wave + gallery + wallet)
```

- `bare-pack` bundles `../../packages/hyperwave-lib-core/worklet/app.js` (+ its whole
  Hyperswarm/Autobase/WDK require graph) into `bundles/app.bundle.mjs`.
- `react-native-bare-kit`'s `Worklet` boots that bundle inside the app; `src/useEngine.js` speaks
  the exact same JSON protocol the desktop renderer uses (`start-wave`, `tip`, `state`,
  `gallery`, `wallet`, …), so the UI is the only new surface.

## Status: ✅ runs on the iOS simulator

Verified end-to-end on the iOS 26.5 simulator — the engine identity renders on device
(`me a5655985 @ 232.6°`), i.e. the worklet booted, the native addons loaded, `createCore`
initialized, computed the ring angle, and pushed `state` over IPC to the React UI. What works:

- `bare-pack` packs the whole engine (Hyperswarm/Autobase/WDK) → 7.6 MB (`ws`'s optional native
  deps handled with `--defer bufferutil --defer utf-8-validate`).
- The **native addons are linked** (see below): `udx-native`, `sodium-native`, `rocksdb-native`,
  … — 41 xcframeworks — so the worklet's `dlopen` succeeds and the engine runs.
- The Expo app builds (87 CocoaPods incl. `react-native-bare-kit`), installs, and launches; the
  RN UI drives the engine over the IPC protocol.

## Run it

Requires a **dev build** (not Expo Go — `react-native-bare-kit` is a native module) and the iOS
toolchain. From the repo root, `npm install` once (workspace), then:

```bash
cd apps/mobile
npx expo install --fix     # align Expo package versions to the installed SDK (first time)
npm run ios                # bundle + link iOS addons + build/install/launch a dev build
```

`npm run ios` runs `npm run bundle` (bare-pack) and `npm run link:ios-addons` first. For a
standalone run with no Metro packager (the JS bundle is embedded), add `--configuration Release`:
`npx expo run:ios --configuration Release`.

### How the native addons get linked (the part that isn't obvious)

`react-native-bare-kit` ships only `BareKit.xcframework` (the Bare runtime), not the addons —
but the addon packages (`udx-native`, `sodium-native`, …) already **ship iOS prebuilds**.
`react-native-bare-kit`'s podspec has a `prepare_command` (`ios/link.mjs`) that runs `bare-link`
to package those prebuilds into `ios/addons/*.xcframework`, which it then vendors. Two monorepo
snags break the built-in version: CocoaPods **skips `prepare_command` for local path pods** (how
`node_modules` pods install), and that script scans from the **repo root**, which in an
npm-workspaces monorepo has no addon deps. So `scripts/link-ios-addons.mjs` runs `bare-link` from
`apps/mobile` (which reaches the addons via `hyperwave-lib-core`) and writes into the hoisted
`react-native-bare-kit` — wired into `postinstall` (auto after every install) and `npm run ios`.

## What's left (none of which touch the engine)

- **Rich UI** — the ring canvas, the rolling ⚽, and the centre-selfie player (desktop's
  `renderer/app.js`) reimplemented in RN (`react-native-svg` or Skia). This scaffold shows a
  plain status + gallery list.
- **Camera capture** — wire `expo-camera` to take the lobby selfie → JPEG data URL →
  `engine.stageSelfie(...)` (the worklet already handles the rest, incl. the gallery blob).
- **Confirm the wallet in the worklet** — the wave engine runs; verify WDK fully inits on device
  (the 💰 chip should populate). Then inject the seed from `expo-secure-store` via the init
  `config.seed` (the core already accepts it, `lib/pay.js`) instead of a `wallet.seed` file.
- **Storage root** — confirm the writable path for `react-native-bare-kit`'s `bare-fs`
  (`STORAGE_DIR` in `useEngine.js`).
- **Android addons** — `link:ios-addons` covers iOS; Android uses `react-native-bare-kit`'s CMake
  path (`react-native.config.js`) — wire the equivalent addon step for `npm run android`.
- **Discovery** — no local DHT on device; you're on the public DHT (~20–35s cold). Pin a
  validator via `config.bootstrap` / a well-known key to speed the demo.
- **Background lifecycle** — iOS/Android suspend sockets in the background; fine for a
  foreground "watch the wave" experience, needs thought for background.
