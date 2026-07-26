# HyperWave mobile (Expo + Bare)

The mobile host for the shared HyperWave engine (`hyperwave-engine`): iOS/Android run the engine
inside a Bare worklet via [`react-native-bare-kit`](https://github.com/holepunchto/react-native-bare-kit).
The engine — the wave sweep, the CRDT moment gallery, the Cashu wallet — is the **same code** the
desktop app runs; only the host (this Expo app) and the UI differ.

The UI is still a scaffold; the roadmap to desktop parity is `../implement-mobile-app.md`.

## How it fits together

```
Expo RN app (this package)                 Bare worklet (hyperwave-engine)
  App.js ── useEngine() ──► FramedStream ⇄ IPC ⇄ FramedStream ──► worklet/app.js ──► createEngine
  (React UI)                (bare-rpc, JSON)                       (wave + gallery + Cashu wallet)
  src/custody.js
  (keychain seeds + persistent storage dir, injected in `init`)
```

- `bare-pack` bundles `../packages/hyperwave-engine/worklet/app.js` (+ its whole
  Hyperswarm/Corestore-Hypercore/cashu-ts require graph) into `bundles/app.bundle.mjs` (~3 MB).
- `react-native-bare-kit`'s `Worklet` boots that bundle inside the app; `src/useEngine.js` speaks
  the exact same bare-rpc seam the desktop renderer uses (`start-wave`, `subscribe-wave`,
  `stage-entry`, `tip`, `state`, `feed`, `wallet`, …), so the UI is the only new surface.
- **Host parity with the desktop worker** (`workers/hyperwave.js`): the Cashu wallet is injected in
  the worklet, the wallet's settlement network picks the directory topic (`<base>:mainnet` for
  mainnet, the base topic otherwise), and `autoSubscribe: false` means the app is merely _aware_ of
  announced waves until you open one (browse-then-pick → core budget O(subscribed)).

## Custody and durability

`src/custody.js` is the RN counterpart of `electron/main.js`'s secret store
(`../docs/secure-seed-storage.md`):

- The **wallet seed and swarm seed** are minted once and held in the OS keychain
  (`expo-secure-store`, this-device-only), then injected as `init.config.{seed,swarmSeed}`. The
  worklet never mints or persists a secret, and the ring seat (swarm identity → angle) is stable
  across restarts.
- The **storage dir** is the app's persistent document directory, passed as `init.storageDir`.
  This matters: Cashu proofs are _bearer funds_ and live at `<storageDir>/cashu-proofs.json`,
  outside the per-run `hyperwave/` Corestore the engine wipes on boot. (The old scaffold resolved
  storage under `os.tmpdir()`, which the OS may purge — a topped-up wallet could silently vanish.)
- The chosen mint is persisted plain (`<storageDir>/cashu.mint`) so a live switch survives a
  restart.

## Status: runs on the iOS simulator — cross-peer with a desktop peer verified

Verified end-to-end on the iOS simulator, **interoperating with a desktop peer over the public
DHT**: a headless desktop peer (`bare bin/wave.run.js` on the same topic) and the phone discovered
each other, the desktop kicked off a wave, and the desktop peers' moment cores **replicated into
the phone's CRDT gallery**. Same engine, same protocol, mobile ↔ desktop.

- `bare-pack` packs the whole engine (Hyperswarm/Corestore-Hypercore/cashu-ts), incl. the wallet's
  dynamic `import()`s (`ws`'s optional native deps handled with
  `--defer bufferutil --defer utf-8-validate`).
- The **native addons are linked** (see below): `udx-native`, `sodium-native`, `rocksdb-native`, …
  — 41 xcframeworks — so the worklet's `dlopen` succeeds and the P2P stack runs.
- The Expo app builds, installs, and launches; the RN UI drives the engine over the IPC seam.

## Run it

Requires a **dev build** (not Expo Go — `react-native-bare-kit` is a native module) and the iOS
toolchain. From the repo root, `npm install` once (workspace), then:

```bash
cd mobile
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
`mobile/` (which reaches the addons via `hyperwave-engine`) and writes into the hoisted
`react-native-bare-kit` — wired into `postinstall` (auto after every install) and `npm run ios`.

## What's left (none of which touch the engine)

Tracked in detail in `../implement-mobile-app.md`:

- **Shared view-model** — the per-wave directory/active-wave/tip logic currently duplicated in
  `src/useEngine.js` moves into a `hyperwave-app-core` package both hosts import (Phase 2).
- **Rich UI** — the ring at true peer angles, the sweep spark, the centre-moment player, the wave
  directory, the lobby countdown (`react-native-svg` or Skia) (Phase 3).
- **Camera capture** — `expo-camera` in the lobby → downscaled JPEG data URL + caption →
  `stage-entry` (Phase 4).
- **Wallet screen** — balance, mint picker, top up (invoice QR), cash out (scan a bolt11), the
  ledger, tip redemption (Phase 5).
- **Android addons** — `link:ios-addons` covers iOS; Android uses `react-native-bare-kit`'s CMake
  path — wire the equivalent addon step for `npm run android` (Phase 6).
- **Discovery** — no local DHT on device; you're on the public DHT (~20–35s cold). Pin a
  well-known bootstrap peer via `config.bootstrap` to speed a demo.
- **Background lifecycle** — `useEngine` wires RN `AppState` → `Worklet.update(state)`, so the Bare
  runtime suspends/resumes with the app. Sockets still suspend in the background: a wave that
  starts while the app is backgrounded is missed. Foreground experience only, by design.
- **NSFW filter** — desktop-only for now (tfjs + nsfwjs are a renderer bundle); a stated asymmetry.
