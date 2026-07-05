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

## What's left (this is a scaffold)

The engine + IPC wiring is real and complete; the following are the remaining mobile-native
pieces, none of which touch the engine:

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
