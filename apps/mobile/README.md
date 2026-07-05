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

## Run it

Requires a **dev build** (not Expo Go — `react-native-bare-kit` is a native module) and the iOS
or Android toolchain. From the repo root, `npm install` once (workspace), then:

```bash
cd apps/mobile
npm run bundle          # bare-pack -> bundles/app.bundle.mjs  (run after any engine change)
npx expo install --fix  # align Expo package versions to the installed SDK
npm run ios             # or: npm run android   (prebuilds native + launches a dev build)
```

`npm start` / `npm run ios` / `npm run android` re-run `npm run bundle` first.

## Status (verified on the iOS 26.5 simulator)

Confirmed working end-to-end up to the native-addon boundary: the engine **bundles** for
Bare-on-mobile (`bare-pack` → 7.6 MB, incl. Hyperswarm/Autobase/WDK — `ws`'s optional native
deps are handled with `--defer bufferutil --defer utf-8-validate`), the Expo app **builds** (87
CocoaPods incl. `react-native-bare-kit`), **installs**, **launches**, and the **worklet boots**
and executes the engine bundle (Metro: `Bundled … 721 modules`).

It then **crashes on the first native addon**: `ADDON_NOT_FOUND: udx-native` — see below.

## What's left

### 1. Link the Bare native addons for iOS/Android (the blocker) 🔴

`react-native-bare-kit` ships only `BareKit.xcframework` (the Bare runtime) — **not** the native
addons. The engine needs at least **`udx-native`** (Hyperswarm's UDP transport) and
**`sodium-native`** (hypercore crypto), which have no iOS/Android slices, so the worklet's
`dlopen('udx-native…')` fails. `bare-pack --linked` correctly emits these as _linked_ addons
expecting the native host to provide them; they must be **cross-compiled for the target**
(iOS-simulator-arm64, iOS-arm64, Android ABIs) with `bare-make` and added as xcframeworks/`.so`s
to the native build — the same native-addon step Keet does. This is a real integration task, not
a config tweak, and gates everything networking-related. Everything above this line is done.

### 2. The rest (none of which touch the engine)

- **Rich UI** — the ring canvas, the rolling ⚽, and the centre-selfie player (desktop's
  `renderer/app.js`) reimplemented in RN (`react-native-svg` or Skia). This scaffold shows a
  plain status + gallery list.
- **Camera capture** — wire `expo-camera` to take the lobby selfie → JPEG data URL →
  `engine.stageSelfie(...)` (the worklet already handles the rest, incl. the gallery blob).
- **Secure wallet seed** — inject the seed from `expo-secure-store` via the init `config.seed`
  (the core already accepts it, `lib/pay.js`) instead of persisting a `wallet.seed` file.
- **Storage root** — confirm the writable path for `react-native-bare-kit`'s `bare-fs`
  (`STORAGE_DIR` in `useEngine.js`).
- **Discovery** — no local DHT on device; you're on the public DHT (~20–35s cold). Pin a
  validator via `config.bootstrap` / a well-known key to speed the demo.
- **Background lifecycle** — iOS/Android suspend sockets in the background; fine for a
  foreground "watch the wave" experience, needs thought for background.
