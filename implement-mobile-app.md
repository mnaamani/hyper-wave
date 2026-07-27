# Bringing the mobile app to parity with the desktop app

**Status:** Phases 0–5 are DONE (2026-07-27) — see the per-phase notes below. Phase 6
(platform hardening: Android, tests, bootstrap pin, NSFW decision, docs) remains. Written 2026-07-25.
**Scope:** `mobile/` (Expo + `react-native-bare-kit`) and the shared worklet host
(`packages/hyperwave-engine/worklet/app.js`). The engine's protocol, wave FSM, feed
CRDT, and payment abstraction are **done and shared** — nothing in this plan requires a
protocol change.

Context: `CLAUDE.md` (load-bearing facts), `packages/hyperwave-engine/docs/protocol.md`
(authoritative spec), `docs/hosting.md` (the 3-process split + IPC seam), `mobile/README.md`
(current mobile status, itself stale — see Phase 0).

---

## 1. Where mobile actually is

`mobile/` is a **scaffold that has drifted**. It proves the important thing — the same engine
runs in a Bare worklet on iOS and interops with a desktop peer over the public DHT — but its
UI and host predate roughly every product decision of the last months.

What works today:

- `bare-pack` bundles the engine (+ Hyperswarm/Corestore/Hypercore) to `bundles/app.bundle.mjs`;
  41 native addon xcframeworks link via `scripts/link-ios-addons.mjs`; the worklet boots on the
  iOS simulator and speaks the same bare-rpc seam the desktop uses (`hyperwave-engine/lib/rpc`).
- `src/useEngine.js` boots the worklet, sends `init`, and maps a handful of engine messages into
  React state. `AppState` → `Worklet.update()` lifecycle is wired.
- `App.js` renders identity, peer count, phase, a gallery list, and two buttons.

What has drifted (all of it host/UI, none of it engine):

| Drift          | Current mobile                                         | Current product                                              |
| -------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| Theme          | ⚽ football, blue palette, "selfie"                    | ⚡ bitcoin, orange palette, "moment"                         |
| Wallet         | Tron/WDK injected in the worklet, "Tip 1 TRX"          | Cashu (ecash on a Lightning mint), unit `sat`                |
| Waves          | one wave, single `phase` string                        | concurrent waves, directory, browse-then-pick                |
| Wallet storage | `os.tmpdir()` — bearer ecash proofs in a purgeable dir | keychain-encrypted seeds, proofs outside the wiped store     |
| Commands used  | 5 of ~20                                               | full surface (subscribe, dm/note, redeem, fund, cash-out, …) |
| Capture        | none                                                   | webcam moment staged in the lobby                            |

So "parity" is mostly: **rebuild the host correctly, then build the UI that already exists on
desktop, in RN.**

---

## 2. Target: what parity means

A mobile peer should be indistinguishable from a desktop peer _on the wire and in the money_,
and equivalent in experience within mobile idiom:

1. **Same network position** — same directory topic policy (testnet vs `<base>:mainnet`), same
   swarm identity persistence, same ring seat.
2. **Same money** — Cashu wallet, burns for participation fees, 5-sat tips via `dm` + `note`,
   redeem, top up (user-specified amount), cash out to a bolt11 invoice, persisted proof ledger.
3. **Same wave model** — aware of many waves, subscribes only to what the user opens
   (`autoSubscribe: false`), lobby → capture → sweep → gallery per wave.
4. **Same participation** — camera moment captured in the lobby, staged, posted on the peer's
   sweep slot.
5. **Comparable UI** — ring with peers at their true angles, wave directory, lobby countdown,
   gallery with the featured moment, wallet screen.

Explicit **non-goals** for this plan: Pear/OTA updates on mobile (desktop-only mechanism),
Android release builds beyond "it runs", App Store / Play Store submission, background waves
(sockets suspend when backgrounded — foreground experience only).

---

## 3. Gap analysis (desktop feature → mobile work)

Desktop reference files in parentheses.

### Host layer

| #   | Feature                | Desktop                                                                     | Mobile now                             | Work                                                                      |
| --- | ---------------------- | --------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| H1  | Wallet injection       | Cashu (`workers/hyperwave.js`)                                              | Tron/WDK (`worklet/app.js`)            | Swap to `hyperwave-wallet-cashu`; keep Tron out of the bundle             |
| H2  | Network → topic policy | `topicForNetwork()` + `wallet`-event tap → `set-topic`                      | absent                                 | Port the same tap into the mobile host                                    |
| H3  | Subscription budget    | `autoSubscribe: false`                                                      | default (true)                         | Set false; drive subscribe/unsubscribe from the UI                        |
| H4  | Seed custody           | `safeStorage` keychain, seeds over IPC (`docs/secure-seed-storage.md`)      | none; engine writes plaintext into tmp | `expo-secure-store` → `init.config.{seed,swarmSeed}`                      |
| H5  | Durable storage        | proofs + seeds survive; only `<storage>/hyperwave` is wiped (`wave.js:339`) | everything under `os.tmpdir()`         | Resolve storage to a persistent app dir (iOS Documents, Android filesDir) |
| H6  | App-extra mints        | `APP_EXTRA_MINTS` → `walletOptions.knownMints`                              | absent                                 | Mirror (empty list is fine, but wire the seam)                            |

**H5 is the one that loses money.** Cashu proofs are bearer funds; `cashu-proofs.json` and
`cashu.seed` live at `<storageDir>/` (see `cashu-wallet.js:590-606`). On mobile that dir is
`os.tmpdir()`, which the OS may purge — a topped-up mobile wallet can silently vanish. Fix
before anyone funds a mobile peer with real sats.

### IPC / view-model layer (`src/useEngine.js`)

| #   | Gap                  | Detail                                                                                                                                                                                                                |
| --- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | Commands             | Missing `subscribe-wave`, `unsubscribe-wave`, `note`, `dm`, `redeem`, `fund-wallet`, `cash-out`, `set-wallet-options`, `fetch-transactions`, `refresh-wallet`, `set-topic`                                            |
| I2  | Per-wave state       | No `waveId` routing at all: one global `phase`, one flat `gallery`. Desktop keeps `waves: Map` + `feedByWave: Map` + an active wave (`renderer/app.js:113-115`)                                                       |
| I3  | Events unhandled     | `wave-announce`, `wave-verified`, `wave-unpaid`, `join-blocked`, `roster`, `wave-active`, `wave-idle`, `subscribed`, `holding`, `completed`, `dm`, `note`, `paying`, `error`, `engine-error`                          |
| I4  | Wallet meta          | No unit/mint/network tracking → no `networkMatches` filter (`renderer/lib/wallet-meta.js`)                                                                                                                            |
| I5  | Tip flow             | `tip(address, 1)` only. Real flow: `tip` → on success `dm` the P2PK token to the peer + `note` a stripped announcement; recipient `redeem`s on `dm` (`renderer/lib/gallery.js:75,178,183`; `renderer/app.js:529-549`) |
| I6  | Ended-wave lifecycle | No TTL/fade/unsubscribe of ended waves (`renderer/app.js:221-263`)                                                                                                                                                    |

### UI layer (`App.js`)

| #   | Feature                   | Desktop file                                                                              | Mobile work                                                                           |
| --- | ------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| U1  | Bitcoin re-skin           | `renderer/index.html` palette (`#f7931a`, `#0a0a0a`)                                      | Restyle; drop ⚽/TRX/"selfie" vocabulary                                              |
| U2  | Country onboarding + flag | `renderer/lib/countries.js`, `hud.js`                                                     | Picker screen → `set-tag`                                                             |
| U3  | Ring                      | `renderer/lib/ring.js` (423 lines: peers at true angles, sweep spark, flourish, confetti) | `react-native-svg` (recommended) or Skia                                              |
| U4  | Wave directory            | `renderer/lib/directory.js`                                                               | Bubble/list of announced waves, select → subscribe + activate                         |
| U5  | Lobby                     | `renderer/lib/lobby.js`                                                                   | Countdown, roster count, fee, join gated on `paid === 'verified'`                     |
| U6  | Camera capture            | `renderer/lib/proof.js`                                                                   | `expo-camera` → JPEG data URL + caption → `stage-entry`                               |
| U7  | Gallery                   | `renderer/lib/gallery.js` (321 lines)                                                     | Featured moment, hop-ordered, progress, tip button                                    |
| U8  | Scrubber                  | `renderer/lib/scrubber.js`                                                                | Drag the spark around the ring to browse (gesture handler)                            |
| U9  | Wallet screen             | `renderer/lib/wallet.js` (487 lines)                                                      | Balance, mint picker, **top up with user-specified amount**, cash out, ledger, redeem |
| U10 | QR                        | `renderer/lib/qr.js` + vendored bundle                                                    | `react-native-qrcode-svg` to show invoices; camera scan for cash-out invoices         |
| U11 | NSFW filter               | `renderer/lib/nsfw.js` (tfjs + nsfwjs embedded)                                           | See Decision D3 — likely deferred                                                     |
| U12 | HUD/toasts                | `renderer/lib/hud.js`                                                                     | Status line + toast surface                                                           |

### Platform / infra

| #   | Gap                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------- |
| P1  | Android addon linking (`link-ios-addons.mjs` has no Android counterpart; `npm run android` is unverified)                    |
| P2  | Camera permission strings (`NSCameraUsageDescription`, Android `CAMERA`)                                                     |
| P3  | No tests of any kind under `mobile/`                                                                                         |
| P4  | Docs stale: `mobile/README.md` says `apps/mobile`, "WDK wallet", "⚽"; `CLAUDE.md`'s mobile paragraph needs the same refresh |
| P5  | Cold public-DHT discovery ~20–35s with no bootstrap pin                                                                      |

---

## 4. Decisions

**D1 — Shared view-model: EXTRACT. Decided 2026-07-26.**

Desktop's `renderer/app.js` holds ~250 lines of _framework-agnostic_ logic: the wave directory
map, active-wave selection, the ended-wave TTL, the theme mapping (`payload` ↔ `{image,caption}`,
`tag` ↔ country), the tip choreography. That logic is extracted into a new dependency-free
package, **`packages/hyperwave-app-core`**, which both hosts import — desktop's `app.js` and
mobile's `useEngine.js`. The alternative (a second, RN-local implementation) was rejected: the
current mobile drift _is_ that outcome already observed, and one of the rules being duplicated
loses money if missed (see the `dm` invariant in §4.1). Full detail of the extraction is Phase 2.

### 4.1 What moves, and the invariants it must preserve

The package owns state + rules, never presentation. Each host keeps its own rendering and its own
transport (`ipc.js` on desktop, the worklet client on mobile) and feeds the store engine messages.

Moving in:

- the wave directory map (`waves`) + per-wave feed cache (`feedByWave`) — `app.js:113-114`
- active-wave selection + supersede-my-prior-wave — `selectWave` / `maybeAutoSelect`
- the ended-wave lifecycle (TTL → fade → `unsubscribe`) — `app.js:221-263`
- the per-event directory patch table — `DIRECTORY_PATCH`, `app.js:266-313`
- theme mapping (`withCountry`, `asMoment`) — `app.js:96-106`
- wallet meta + `networkMatches` filtering — `renderer/lib/wallet-meta.js`
- the tip choreography: `tip` → `dm` the token + `note` the announcement; `redeem` on inbound `dm`

Staying put (presentation, per host): `ring.js`, `gallery.js`, `lobby.js`, `proof.js`, `hud.js`,
`directory.js`, `scrubber.js`, and their RN counterparts.

Invariants the extracted module must carry over — each is a fixed bug, and each needs a test in
the new package (they are exactly what a re-implementation would have re-broken):

1. **Only `wave-announce` may create a directory entry** (`app.js:297-309`) — every other event
   updates a wave already known, or a late `roster` / echoed `unsubscribed` spawns a phantom
   by-less bubble.
2. **`dm` and `note` are wave-agnostic** (`app.js:564`) — a `dm` carries the P2PK-locked Cashu
   token and must be redeemed even when it arrives for a wave the user has navigated away from.
   Routing it "for the active wave only" silently destroys received sats.
3. **Stage the pending capture before switching waves** (`app.js:157`) — otherwise a wave that
   starts while the user browses elsewhere posts nothing.
4. **A network change deselects a now-cross-network active wave** (`app.js:358-366`).
5. **Ended waves are unsubscribed when dropped** (`app.js:232-234`) — this is what keeps the core
   budget O(subscribed).

Ordering rules that are presentation-coupled (`gallery.setActive()` before `handle()`;
`captureAndStage()` before reopening the gallery) stay in the hosts, but the store must expose
enough state for each host to honour them — note them in the package's README rather than
silently relying on call order.

**D2 — Rendering the ring.** `react-native-svg` (declarative, no new native build step, adequate
for ~100 nodes + one animated spark) vs `@shopify/react-native-skia` (canvas-like, closest to the
existing 2D code, better at confetti/flourish, heavier dependency). Recommend **svg**, with Skia
reserved for the flourish if it looks weak.

**D3 — NSFW filter on mobile.** Desktop embeds tfjs + nsfwjs (~large) in a renderer bundle.
On RN that means `tfjs-react-native` + a model asset + native deps. Options: defer entirely
(mobile shows unfiltered moments — a stated limitation), or run the filter only on entries when
the moment is featured. Recommend **defer to Phase 6**, and document it as a known asymmetry.

**D4 — Testnet vs mainnet on mobile.** Desktop defaults to testnut (auto-paying test mint). Mobile
should do the same, but a phone is the likeliest place someone taps "Top up" with a real mint.
Ensure the mint picker shows network clearly and the directory-topic split (H2) is in place
before any mainnet mint is offered.

---

## 5. Phased plan

Each phase ends in a demonstrable state. Sizes: **S** ≈ half a day, **M** ≈ 1–2 days,
**L** ≈ 3–5 days (one person, familiar with the codebase).

### Phase 0 — Unstick and re-baseline (S) — ✅ DONE

_Goal: the current scaffold builds and runs today, and its docs stop lying._

1. `npm install`, `npm run bundle`, `npm run ios` — confirm the simulator path still works on
   current Expo 55 / RN 0.83. Record breakages.
2. Fix stale references: `mobile/README.md` (`apps/mobile` → `mobile`, WDK → Cashu once Phase 1
   lands, ⚽ → ⚡), `App.js` topic constant, the `useEngine` doc comment.
3. Re-skin the scaffold to the bitcoin palette (U1) — cheap, and stops every later screenshot
   from looking like the old product.

**Done when:** a fresh clone reaches a running simulator app following only `mobile/README.md`.

### Phase 1 — Host parity (M) — ✅ DONE

_Goal: the mobile peer is the same network + money participant as desktop, even with a rough UI._

1. **H1** — `worklet/app.js` injects `createCashuWallet` from `hyperwave-wallet-cashu`
   (`bare-web-shims.js` already covers Bare's missing `fetch`/WebCrypto/TextEncoder). Add the
   package to `mobile/package.json` so `bare-pack` sees it; drop `hyperwave-wallet-tron` from the
   bundle. Measure the bundle delta (it was ~8 MB with WDK).
2. **H5** — storage split. `resolveStorage()` must return a **persistent** app dir. Get it from the
   RN side (`expo-file-system`'s document directory) and pass it in `init.storageDir` rather than
   guessing inside the worklet; keep the tmpdir fallback for the no-path case. Verify
   `cashu-proofs.json` survives an app restart.
3. **H4** — seeds. RN generates (once) a wallet mnemonic + swarm seed, stores them in
   `expo-secure-store`, and passes them as `init.config.seed` / `config.swarmSeed`. This mirrors
   `electron/main.js` exactly: the engine never persists an injected seed. Confirm the ring seat is
   stable across restarts (same swarm identity → same angle).
4. **H2/H3/H6** — port `topicForNetwork` + the `wallet`-event emit tap, `autoSubscribe: false`,
   and `knownMints` into the mobile host. Put `topicForNetwork` in `hyperwave-app-core` (D1) —
   it is app policy shared by both hosts, not engine logic — and have `workers/hyperwave.js` and
   the mobile host both call it. If Phase 2 hasn't landed yet, duplicate it temporarily and fold
   it in during the extraction.

**Done when:** a mobile peer with a funded Cashu wallet starts a paid wave that a desktop peer
joins, and the mobile wallet balance survives an app restart.

### Phase 2 — Extract `hyperwave-app-core`, then wire mobile to it (L) — ✅ DONE

_Goal: one brain, two hosts. Every engine command and event reachable from RN, with correct
per-wave state._

This is the D1 extraction. It runs in three steps, in this order — the desktop port comes
**before** mobile touches the package, so the extraction is validated against the app that
already works.

**2a — Create the package (S).** `packages/hyperwave-app-core`, zero dependencies, plain ESM+CJS
consumable (desktop renderer is ESM, RN is ESM, the package must not need a bundler step).
Surface, roughly:

```
createAppCore({ send })      // `send(type, args)` is the host's transport
  .handle(msg)               // feed it every engine message (state/event/feed/wallet/…)
  .subscribe(fn)             // fn(snapshot) on change
  .selectWave(waveId) / .startWave() / .join() / .tip(entry) / …
```

The store issues commands through `send` (so it can `subscribe-wave`/`unsubscribe-wave`/`redeem`
on its own), and exposes a snapshot the host renders. No DOM, no React, no timers the host can't
override (inject a clock so the ended-wave TTL is testable).

**2b — Port the desktop renderer onto it (M).** `renderer/app.js` shrinks to: transport wiring,
subscribe to the store, drive the view modules from snapshots. **Mechanical only — no behaviour
change in the same commit.** Verification is manual (run two desktop peers through a full wave:
start, join, capture, sweep, gallery, tip, redeem) plus the new package tests from 2c. Keep it
reviewable; if the diff starts growing features, stop and split.

**2c — Tests (S).** Cover the five invariants in §4.1 with a fake `send` + scripted engine
messages. This is the first test coverage this logic has ever had; it is also the regression net
for 2b, so write the tests against the extracted module before finishing the desktop port.

**2d — Wire mobile (M).** `useEngine.js` becomes thin: boot the worklet, pipe messages into the
store, expose the snapshot to React. Then:

- **I1** — full command surface (the store covers most; the hook exposes the rest).
- **I2/I3/I6** — arrive for free from the store.
- **I4** — wallet meta + `networkMatches` (in the store).
- **I5** — the tip flow, including `redeem` on an inbound `dm` (in the store, invariant 2).

**Done when:** desktop behaves identically on the extracted store (full wave, tip, redeem), the
package's invariant tests pass, and — with a deliberately plain UI — a mobile peer can browse
several concurrent waves, join one, be blocked with the right reason on another, tip a moment,
and receive + redeem a tip.

### Phase 3 — Core wave UX (L) — ✅ DONE

_Goal: it feels like HyperWave._

1. **U3** ring with peers at their true angles (angle derived locally from peer id — never trusted
   from gossip), the sweep spark, and the completion flourish.
2. **U4** wave directory; selecting a wave subscribes + activates it.
3. **U5** lobby: countdown, roster count, fee, join button gated on `paid === 'verified'`.
4. **U12** status line + toasts for the ~15 narration events desktop shows.
5. **U2** country onboarding → `set-tag`, flag in the header.

**Done when:** a mobile peer can watch a wave sweep the ring end to end, with the same narration
beats as desktop.

### Phase 4 — Capture + gallery (M) — ✅ DONE (U8 scrubber dropped; see below)

1. **U6** `expo-camera` preview during the lobby, capture → JPEG data URL (mind the entry byte
   caps in `protocol.md`) + caption → `stage-entry`; auto-capture at wave start, mirroring
   `proof.captureAndStage()`.
2. **U7** gallery: hop-ordered items, featured moment in the ring centre, progress, tip button.
3. **U8** scrubber gesture — DROPPED for now (the plan allows it): the ring is small on a phone
   and the moment list below it already lets you browse every moment by tapping. Revisit only if
   the gallery grows a full-screen mode.
4. **P2** permission strings.

**Done when:** a moment captured on the phone appears in a desktop peer's gallery, and vice versa.

### Phase 5 — Wallet screen (M) — ✅ DONE (cash-out melt unverified, see below)

**U9/U10**: balance, mint picker (`set-wallet-options`), **top up with a user-specified amount**
(the input just added to desktop — `renderer/lib/wallet.js`; same 1..1,000,000 sat gate), invoice
QR via `react-native-qrcode-svg`, cash out (paste **or camera-scan** a bolt11 invoice — a phone
should scan), the persisted ledger via `fetch-transactions`, and `redeem` for tips.

**Done when:** top up, tip, and cash out all work on device against a real mint, and the ledger
shows past sessions after a restart.

_Result:_ top up and the ledger are verified on the simulator against the live testnut mint (balance
rises; History shows entries from earlier app runs). Cash out is verified only on its FAILURE path
(the mint rejects a bogus invoice and the screen surfaces it) — a successful melt needs a real
payable bolt11 from an external Lightning wallet, which the repo's e2e doesn't cover either. The
mobile tip button calls the same `core.tip()` whose choreography was verified live on desktop, but
has not been exercised from the phone.

### Phase 6 — Platform hardening + docs (M)

1. **P1** Android: the `bare-link` CMake path, `npm run android` verified on an emulator.
2. **P3** tests: the `hyperwave-app-core` suite already landed in Phase 2c — extend it with the
   cases mobile turns up, wire it into the root `npm test`, and add a manual device checklist to
   `DEMO.md`.
3. **P5** pin a bootstrap peer via `config.bootstrap` for demos.
4. **D3** NSFW decision executed (implement or document the asymmetry).
5. **P4** docs: `mobile/README.md` rewritten, `CLAUDE.md` mobile paragraph updated, `TODO.md`
   mobile items reconciled.

---

## 6. Risks

- **Bundle size / cold start.** Cashu adds `@cashu/cashu-ts` + `@noble/*` to an already ~8 MB
  worklet bundle. Watch worklet boot time on a real device (simulator flatters it).
- **The desktop renderer refactor (Phase 2b) — the biggest risk in this plan.** `renderer/app.js`
  is the most-exercised code in the product and has no unit tests today. Mitigations, in order:
  write the invariant tests (2c) against the extracted module first; keep 2b mechanical with no
  behaviour change in the same commit; run a full two-peer wave before merging; land it on its own
  branch so a revert is one command. If 2b starts sprouting features, split it.
- **Wrong-shaped abstraction.** The store's API is being designed against desktop's needs, and
  mobile's UX may not want a directory panel or a scrubber. Keep the package to state + rules
  (no presentation opinions), and expect one API revision during 2d — budget for it rather than
  forcing mobile to contort.
- **iOS background suspension.** A wave that starts while the app is backgrounded is missed. State
  this as a limitation rather than fighting it; revisit only if a demo needs it.
- **Camera + entry size.** Desktop images are inline dataURLs; a phone camera frame is far larger
  than a webcam still. Downscale aggressively before staging or the envelope cap will reject it.
- **Two Hyperswarm instances.** If the RN side ever gains its own swarm, it must be passed into the
  engine (`createEngine({ swarm })`) — two instances in one process don't discover each other.

## 7. Suggested order of attack

Phase 0 → 1 first: pure host work, unblocks real-money testing, and fixes the proof-loss bug
(H5). Then Phase 2 — with D1 decided (extract), Phases 3–5 all build against
`hyperwave-app-core`, so it should not be deferred: every screen written before it exists is a
screen that gets rewired afterwards.

Phase 2 is also the one piece of this plan that improves the **desktop** app (its core logic
becomes tested and separable), so it is worth doing well even judged on its own.
