# HyperWave apps — hosting architecture

How the two app hosts (the desktop Electron shell and the mobile bare-kit worklet) wrap the
theme-agnostic engine, and the seam between the UI and the P2P worker.

HyperWave (the product) is a peer-to-peer "global stadium wave": peers join a match swarm, a
⚽ sweeps around a ring of participants (each peer fires its own moment on a shared,
deterministic schedule), each participant takes a selfie into a
shared gallery, their supported-country flag rides along — and real (testnet) money
flows through it: participation fees are **burned** on-chain (anti-spam, no beneficiary),
and viewers **tip** selfies directly. No sponsor rewards. No servers — discovery,
state, and storage are all peer-to-peer (Hyperswarm + Corestore/Hypercore), and payments are
self-custodial (WDK, Tron Nile testnet).

This document covers the **process/layer structure** of the apps. For the wire protocol and
state machine (the engine, enough to build a compatible client), see
[`protocol.md`](../../packages/hyperwave-engine/docs/protocol.md).

The repo is an **npm-workspaces monorepo**: the reusable Bare engine lives in
`packages/hyperwave-engine/` and boots unchanged under two hosts — the desktop Electron
app (`apps/desktop/`) and an Expo + react-native-bare-kit mobile app (`apps/mobile/`). Each
host is a ~20–40-line shim over the engine's host-agnostic entry, `lib/engine.js` `createEngine()`.

The engine is **theme-agnostic** — it knows only generic concepts (a **wave** that
**sweeps** a **ring**, an **entry** with an opaque **payload** in a per-wave **feed**, a
cosmetic **tag**). The football "stadium wave" is entirely in the desktop app's UI, which
maps its selfies/countries onto the engine's entries/tags at the IPC boundary. The engine
could host any turn-taking / coordinated-snapshot application unchanged.

## Processes & layers

```mermaid
flowchart TB
  subgraph Electron["Electron app (one per participant)"]
    subgraph Main["Main process — Node.js"]
      M["electron/main.js<br/>windows · media permission ·<br/>spawns Bare workers · IPC relay"]
    end
    subgraph Renderer["Renderer — Chromium (ESM)"]
      R["renderer/app.js + lib/*<br/>ring canvas · lobby · webcam ·<br/>gallery · hud · country picker"]
    end
    subgraph Worker["Bare worker (per --storage)"]
      W["workers/hyperwave.js → hyperwave createEngine()<br/>(engine.js → wave.js + wallet.js)<br/>discovery · gossip · the sweep ·<br/>lifecycle · CRDT feed ·<br/>WDK wallet · fee burns · tips"]
    end
    subgraph Updater["Bare worker (OTA, template)"]
      U["workers/updater.js<br/>pear-runtime auto-update"]
    end
  end

  R <-->|"IPC (FramedStream JSON):<br/>commands ↑ / events ↓"| M
  M <-->|"FramedStream over Bare.IPC"| W
  M <--> U

  W <-->|"Hyperswarm DHT<br/>Protomux gossip + Corestore replication"| Peers["Other peers' workers"]
```

**Why three processes?** It's the [`hello-pear-electron`](https://github.com/holepunchto/hello-pear-electron)
model: Chromium can't run the Holepunch P2P stack, so the networking lives in a **Bare**
worker (Holepunch's JS runtime), and the Electron **main** process brokers between the
sandboxed renderer and the worker.

The three-process split is **desktop-specific**. The engine itself is host-abstracted: on
mobile the same `hyperwave` boots as a single Bare **worklet**
(`packages/hyperwave-engine/worklet/app.js` under react-native-bare-kit, bundled by
`bare-pack`), driven by the React Native UI over the identical JSON IPC surface
(`apps/mobile/src/useEngine.js`) — no Electron main, no separate updater.

| Layer                                            | Runtime             | Module format | Responsibility                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | ------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Main** (`apps/desktop/electron/main.js`)       | Node.js (Electron)  | CJS           | Create the window; allow `media` (webcam); resolve + log the storage dir; spawn Bare workers via `PearRuntime.run`; relay IPC between renderer and workers; small helper IPC (`copy-text`, `open-external`, `isPackaged`). Template plus those additions.                                                                                                                                         |
| **Renderer** (`apps/desktop/renderer/`)          | Chromium, sandboxed | **ESM**       | All UI: ring `<canvas>`, lobby, webcam capture, gallery, HUD, country picker. No P2P, no crypto.                                                                                                                                                                                                                                                                                                  |
| **Worker** (`apps/desktop/workers/hyperwave.js`) | **Bare**            | CJS           | A thin (~40-line) host: wraps `Bare.IPC` in a `FramedStream` and calls `hyperwave`'s `createEngine()`. All protocol/state — Hyperswarm, gossip, the deterministic sweep, attestations, lifecycle, the CRDT feed, plus the WDK wallet (fee burns, tips) — lives in the **engine package** (`engine.js` + `wave.js` + `wallet.js`). WDK is ESM-only, so `wallet.js` bridges via dynamic `import()`. |
| **Updater** (`apps/desktop/workers/updater.js`)  | Bare                | CJS           | Template's OTA auto-update; unrelated to the wave.                                                                                                                                                                                                                                                                                                                                                |

(Module format is a deliberate mix — see [Module format](#module-format).)

## The one seam: worker ⇄ renderer

Everything crosses a single boundary — the IPC bridge. The worker emits **events**; the
renderer sends **commands**. The renderer never touches the network or keys.

The engine is **theme-agnostic**, so these messages use its generic vocabulary — an
`entry` with an opaque `payload`, a cosmetic `tag`, a `feed`. The football UI maps its
own concepts to these at the boundary (`renderer/lib/ipc.js` + `app.js`): a selfie
`{image, caption}` is just the entry payload; a country is just the tag.

```
renderer  ──(commands)──▶  worker
  { type: 'start-wave' }                              // burn start fee → announce + lobby
  { type: 'join-wave' }                               // verify wave paid → opt in + burn join fee
  { type: 'set-tag', tag }                            // cosmetic per-peer tag (app: country)
  { type: 'stage-entry', entry: { payload } }         // opaque payload (app: a {image, caption} selfie)
  { type: 'tip', to, amount }                         // real TRX to an entry owner
  { type: 'send-trx', to, amount }                    // plain transfer to any address (wallet Send form)
  { type: 'refresh-wallet' }                          // manual balance re-check (after funding)
  { type: 'fetch-transactions' }                      // pull the on-chain tx history (wallet view)

worker  ──(events)──▶  renderer
  { type: 'state',   me, peers[], connected, discovered }  // ring membership (every change)
  { type: 'event',   event, ... }                     // lifecycle + race events (protocol.md)
  { type: 'feed',    items[] }                        // ordered entries (every change)
  { type: 'wallet',  address, trx }                   // wallet chip (on ready + every 15s; { error } on init failure)
  { type: 'burn-result' | 'tip-result' | 'send-result', ... }  // fee/tip/send outcomes (toasts)
  { type: 'transactions', list[] }                    // on-chain history, both directions, newest first
```

Transport (desktop): `hyperwave.js` wraps `Bare.IPC` in a `FramedStream` and JSON-encodes
each message; `electron/main.js` relays the frames to/from the renderer, which uses the
preload `bridge` (`onWorkerIPC` / `writeWorkerIPC`). See `electron/preload.js`.

Transport (mobile): the worklet wraps `BareKit.IPC` in the **same** `FramedStream` + JSON
framing (`worklet/app.js`), driven from `apps/mobile/src/useEngine.js` over `Worklet.IPC` —
one message surface, two hosts. (The worklet additionally emits `engine-error` on an
unhandled rejection, since mobile has no console.)

## Design principle: where does logic live?

- **Protocol & authoritative state → worker.** Anything that defines correctness on the
  wire (discovery, the ring, the sweep schedule, lobby/roster, the attestations, the
  gallery + its write-gate) lives in the worker. Guards are _enforced_ here: e.g. "one
  wave at a time" is enforced by `wave.js`, not by hiding a button.
- **Presentation, user input, device APIs → renderer.** Canvas drawing, countdown
  animations, the webcam (`getUserMedia` — Chromium only), the gallery slideshow, and
  the flag rendering (`flagOf`) live in the renderer. The renderer holds only _derived_
  UI state (e.g. `waveActive` to hide a button); the worker remains the source of truth.
- **Borderline, intentionally renderer-side:** country **persistence** (`localStorage`)
  and the proof-window **capture timing** are user/UI preferences; the worker only stores
  the country _code_ and doesn't care when a selfie is taken (selfies are optional).

The worker computes ring **angles** (from peer public keys) and
sends them in `state`; the renderer consumes them for drawing and never recomputes them —
so there's no duplicated protocol logic across the seam.

> **Behind the seam:** the topology's only job is a **connected flood graph** —
> Hyperswarm's own topic mesh carries it (nothing is pinned). The wave itself is the
> sweep (`lib/sweep.js`): every peer derives its slot from the flooded roster.

## No roles — every peer is equal

There are no peer roles: every instance runs the same code and behaves identically. Every peer
participates fully (pays fees, joins waves, selfies, relays), and every peer's
`storageDir/hyperwave` store is **wiped on startup**, so galleries are ephemeral per run —
keyed by the random `waveId`, nothing persists across runs.

The gallery is a **multicore CRDT** — one Hypercore per participant, merged locally (no
indexer, no coordinator; see `protocol.md` §8) — so every participant already holds every
core and could serve the whole gallery. There is not even a per-wave asymmetry: the initiator
is an ordinary participant (posts its own selfie, publishes its own core, no indexer/admission
/retention role). A departing peer's selfie survives in everyone's view because they already
replicated it; the gallery is ephemeral once a new wave supersedes it, so nobody keeps cores
open across waves.

## Module map

```
packages/hyperwave-engine/   the reusable Bare engine (npm workspace)
  index.js           package entry: re-exports createEngine (engine), wave, pay, fees
  lib/
    engine.js        createEngine(): the host-agnostic engine — wires wave.js + wallet.js,
                     owns the command dispatch (start/join/tip/send-trx/stage-entry/set-tag/
                     refresh-wallet/fetch-transactions) and the fee flow; both hosts are
                     thin shims over this
    wave.js          orchestrator (composition root): transport + gossip dispatch + wave
                     lifecycle + the deterministic sweep; composes the stateful classes below
    ring.js          pure ring geometry (angleOf, angleOfId, liveRing)
    sweep.js         pure sweep slot math (sweepSchedule, mySlot): the identical angle-ordered
                     schedule every peer derives from the flooded (roster, t0, lapMs)
    messages.js      the gossip message seam: one factory + one shape validator per message
                     kind (send sites build through the factories; the receive edge validates
                     before any signature/state work) + the flooded/direct classification
    flood.js         Flood class: gossip-flood dedup (firstSight, oldest-first eviction) for
                     relayed lifecycle messages
    peer-table.js    PeerTable class: seats + direct channels (angle always derived
                     from the id; disconnects are authoritative)
    entry.js         EntryPipeline class: pairs the host-staged entry payload with my sweep
                     slot, posts exactly once per wave, owns the burn-ticket lifetime
    attest.js        pure attestation crypto (burn + join attestations:
                     signBurn/burnAuthorizes, signJoin/verifyJoin)
    feed.js          the pure CRDT merge (mergeFeed) + buildFeed ordering, applying the
                     join-attestation write-gate + payload byte cap + one-per-peer over a bag of ops
    feed-crdt.js     CrdtFeed class: the multicore CRDT feed — per-participant cores,
                     addWriter (open + download block 0 of a peer's core), postEntry (append
                     my one op to my own core), tick/merge into the view
    wallet.js        WDK wallet (Tron Nile, native TRX) + shared fee flow (burn memo,
                     payFee, confirmBurn, wireWallet): send, burn(+memo), verifyBurnTx,
                     transactions (on-chain history via TronGrid, both directions)
    *.test.js        brittle unit-test suites (aggregated by test.js)
  bin/               standalone dev CLIs (run under Bare)
    wave.run.js      headless wave host (one wave per process; WALLET=1)
    dht-local.js     local DHT for fast same-machine testing
  worklet/
    app.js           mobile bare-kit worklet entry (same createEngine() over BareKit.IPC)
  e2e/               end-to-end harness + suites (wave.local.e2e.js, wave.onchain.e2e.js)

apps/desktop/        the Electron shell (npm workspace)
  electron/
    main.js          Electron main: windows, storage-dir resolution, spawn workers, IPC relay
                     (+ media permission, copy-text/open-external helpers)
    preload.js       exposes window.bridge (IPC) to the renderer
  renderer/          ESM, browser
    index.html
    app.js           orchestrator: wire ipc events → views
    updater.js       OTA-updater renderer half (template)
    lib/
      ipc.js         worker channel: route state/event/feed/wallet/tip/burn/send/
                     transactions + command senders
      ring.js        all <canvas> drawing (ring, dots, flags, football, centre selfie)
      gallery.js     centre-selfie slideshow + collection progress + 💵 tip button
      lobby.js       lobby panel (countdown + join, gated on payment verification)
      proof.js       lobby webcam capture (staged selfie)
      scrubber.js    circular scrubber: drag the frozen ⚽ around the ring to browse the gallery
      hud.js         status line, Kick-off button, country picker + intro
      wallet.js      💰 wallet view modal: balance/address, copy/faucet, Send form (send-trx),
                     merged tx history (app events + on-chain transactions)
      explorer.js    Tronscan links (openAddress, txLink)
      countries.js   ISO country list + flag emoji
  workers/           Bare, CJS
    hyperwave.js     thin worker host: FramedStream over Bare.IPC → hyperwave createEngine()
    updater.js       template OTA updater (unrelated)

apps/mobile/         the Expo + react-native-bare-kit host (npm workspace)
  App.js             RN UI (speaks the same JSON IPC protocol)
  src/useEngine.js   boots the worklet bundle over Worklet.IPC
  (npm run bundle → bare-pack on the engine's worklet entry)

scripts/
  fix-bare-engines.js  postinstall: normalize dep engines ranges Bare's semver can't parse
```

## Module format

- **Bare workers are CJS** (`require`/`module.exports`) — idiomatic for Bare and the
  template, and the worker entry is loaded by `PearRuntime.run`.
- **The renderer is ESM** (`import`/`export`) — it works over `file://` in the Electron
  renderer.

Bare _can_ run ESM (`.mjs`), but the workers are kept CJS: converting is all-or-nothing
across the require/import graph (`require()` of an ESM module throws), and the ESM
worker-entry boot under `pear-runtime` is unverified. The mix (Bare=CJS, browser=ESM) is
intentional and conventional. On mobile the React Native side (`App.js`, `useEngine.js`)
is ESM, while the worklet entry itself stays CJS (the `bare-pack` bundle output is
`.mjs`).
