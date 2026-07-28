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
  (React UI)   │            (bare-rpc, JSON)                      (wave + gallery + Cashu wallet)
  src/components/ (MomentFeed, SweepBar, WaveList, Lobby, StatusLine, CountryPicker)
               └── hyperwave-app-core  (the view-model the desktop renderer drives too)
  src/custody.js
  (keychain seeds + persistent storage dir, injected in `init`)
```

The **rules** (wave directory, active wave, ended-wave lifecycle, wallet meta, tip choreography)
live in `hyperwave-app-core`, shared with the desktop renderer — `src/useEngine.js` is only
transport + React glue, and `src/components/` is only presentation.

**The phone does NOT draw the desktop's ring.** A 320pt circle on a 6" screen crowded out the
moments it was framing, so the mobile presentation is a full-bleed vertical feed (`MomentFeed`) —
one moment per page, swipe up for the next — with the header, wave strip, lobby and buttons
floating over it. The sweep the ring drew becomes a story-style segmented bar (`SweepBar`): one
segment per roster seat, in the same angle order the sweep fires in, filling left to right as the
wave rolls, glowing on completion. Like the desktop ring's spark, that fill is a local
fixed-duration REPLAY (`SWEEP_MS`) — the protocol itself races at network speed, so visual pacing
is a renderer concern. While a wave rolls, the feed AUTO-ADVANCES to each moment as it lands (the
wave is the scroll); the first manual drag hands control back to the user for that wave.

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
  restart; so is the chosen country (`<storageDir>/country`).
- **Uninstalling the app deletes its Cashu proofs** — they live in the app container, which iOS
  removes with the app (the keychain seeds survive, but the bearer funds don't). Cash out before
  uninstalling. Desktop has the same property for its storage dir.

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

`npm run ios` runs `npm run bundle` (bare-pack) and `npm run link:ios-addons` first.

`ios/` and `android/` are **generated and gitignored** — `app.json` is the source of truth for
native config (bundle id, permission strings like `NSCameraUsageDescription`, plugins). An existing
`ios/` is NOT re-synced from `app.json` on build, so after changing that config run
`npx expo prebuild --clean` (or edit the generated plist to match locally). Note that the iOS
Simulator caches a permission's purpose string per bundle id even across reinstalls, so a changed
string may keep showing the old text there. For a
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

## Manual device checklist

Automated tests cover the shared rules (`hyperwave-app-core`) and the engine; everything below is
what only a real run can tell you. Pair the phone with a desktop peer — the quickest partner is the
engine's headless CLI, which needs no GUI and funds itself:

```bash
cd packages/hyperwave-engine
WALLET=1 WALLET_TYPE=cashu WALLET_FUND=200 \
  AUTOJOIN=1 AUTOENTRY=1 bare bin/wave.run.js peer /tmp/hw-peer
```

The phone and the desktop must sit on the SAME base topic or they never discover each other.
`mobile/App.js`'s `TOPIC` is empty by default, so both sides use the engine's `DEFAULT_TOPIC`
(`hyperwave:demo:v1`) — matching the desktop host's own default. If you set `TOPIC` to isolate a
build, pass the same string to the desktop side as `HYPERWAVE_TOPIC`.

1. **Boot** — identity + ring angle appear in the status line; the wallet chip shows a balance and
   `testnet`.
2. **Restart** — same peer id and angle (keychain swarm seed), same balance (proofs on disk), and
   onboarding does NOT ask for the country again.
3. **Country** — tap the header flag: the picker reopens with a Cancel, backing out leaves the
   country unchanged, and picking a new one updates the flag on your seat and your next moment.
4. **Dismiss a wave** — long-press a chip in the strip: confirm, and it leaves the list for good
   (its cores are freed) and does NOT come back when the engine gossips about it again. "Keep"
   must leave it exactly as it was.
5. **Discovery** — the peer count rises within ~35s (public DHT).
6. **Start a wave** — `🔥 paying the start fee…`, then the chip shows `lobby · 2 sat · pending`,
   then `verified`.
7. **Capture** — the sheet opens with a live preview, the countdown runs, and it auto-captures
   before the lobby closes. Tap **Capture now** and **Skip** at least once each.
8. **Sweep** — the segment bar fills left to right, the feed auto-advances to each moment as it
   lands, `wave rolling — hop n`, then `✅ wave completed` and the bar glows. Swipe mid-wave: the
   auto-advance must stop and stay stopped for the rest of that wave.
9. **Gallery** — YOUR photo is a page in the feed (this is the piece the simulator cannot test),
   and it appears in the headless peer's feed (`FEED size=2` in its log). Once the lap has ended,
   the feed is YOURS: scroll up and down through every moment freely, and a moment landing late
   (cores still syncing) must not yank the page you're on.
10. **Tip** — tap ⚡ Tip on the peer's moment: balance drops ~6 sat, and the peer logs a `dm`
    carrying the token plus a stripped `note`.
11. **Receive a tip** — from a desktop peer, tip the phone's moment: `🎉 you got tipped`, and the
    balance rises after the automatic redeem.
12. **Wallet** — top up a custom amount; on a real (non-test) mint the invoice renders as a QR.
    **Hide this invoice** puts it away, and switching mints closes it too — an invoice belongs to
    the mint that issued it, so paying it after a switch would credit the mint you just left.
    Asking for a new top-up brings the QR back. Then scan a bolt11 with **Scan QR** and cash out;
    History lists the operations, and still does after a restart.
13. **Background** — background the app mid-lobby and return: sockets suspend, so expect to miss
    a wave that starts meanwhile (a stated limitation).

## What's left (none of which touch the engine)

Tracked in detail in `../implement-mobile-app.md`:

- **Capture on real hardware** — the capture sheet, the auto-capture, the byte-cap ladder and the
  staging path are implemented and the entry posts cross-peer, but the **iOS Simulator has no
  camera**: every frame there comes back empty, so the entry carries only a caption. Photographing
  a real moment (and with it the downscale ladder + EXIF strip) is unverified until it runs on a
  device.
- **Cash out against a real invoice** — the screen and the engine path are in place and the failure
  path is verified (the mint rejects a bad invoice and the error surfaces), but a successful melt
  needs a payable bolt11 from an external Lightning wallet.
- **An Android BUILD** — the addon linking is done (`npm run link:android-addons`, wired into
  `postinstall` and `npm run android`, and verified to vendor 88 `.so` files across 4 ABIs), but
  the APK has never been built here. Two environment prerequisites, both absent on the dev machine:
  a **JDK 17** (the RN gradle plugin requires that toolchain; with only JDK 21/26 present Gradle
  tries to auto-provision it and the plugin's pinned `foojay-resolver 0.5.0` crashes under Gradle 9
  with a misleading `JvmVendorSpec … IBM_SEMERU` error — the real message appears with
  `-Porg.gradle.java.installations.auto-download=false`), and an **Android system image / AVD**.
  With both installed: `JAVA_HOME=<jdk17> ANDROID_HOME=~/Library/Android/sdk npm run android`.
- **Discovery** — no local DHT on device; you're on the public DHT (~20–35s cold). Pin a
  well-known bootstrap peer via `config.bootstrap` to speed a demo.
- **Background lifecycle** — `useEngine` wires RN `AppState` → `Worklet.update(state)`, so the Bare
  runtime suspends/resumes with the app. Sockets still suspend in the background: a wave that
  starts while the app is backgrounded is missed. Foreground experience only, by design.
- **NSFW filter** — desktop-only for now (tfjs + nsfwjs are a renderer bundle); a stated asymmetry.
