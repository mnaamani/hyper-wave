# HyperWave (desktop app)

Electron + Pear desktop host for the HyperWave P2P stadium wave. Forked from
[`holepunchto/hello-pear-electron`](https://github.com/holepunchto/hello-pear-electron).

This package is only the **shell**: window, renderer UI, and a thin Bare worker that boots
the shared engine (`hyperwave-lib-core`). Everything general lives in the docs:

- Project overview + quickstart: [`../../README.md`](../../README.md)
- Architecture (processes, IPC surface, module map): [`../../docs/architecture.md`](../../docs/architecture.md)
- On-wire protocol & state machine: [`../../docs/protocol.md`](../../docs/protocol.md)
- The idea, in plain language: [`../../docs/idea.md`](../../docs/idea.md)

## Run

```bash
npm install    # once, at the repo ROOT (workspace; postinstall fixes dep engines for Bare)

# From the repo root. Each instance needs its own --storage dir (own identity,
# Corestore, wallet). Open several for a local multi-peer demo.
npm start -- --storage /tmp/hyperwave/one
npm start -- --storage /tmp/hyperwave/two
```

Without `--storage`, a dev run (`npm start`) stores under `os.tmpdir()/pear/HyperWave` —
the resolved dir is logged at startup (`[main] storage dir: ...`). Wallets must be
**funded** to pay fees (Nile faucet: https://nileex.io/join/getJoinPage — the address is in
the 💰 chip / worker log). Full walkthrough incl. funding and local-DHT setup: the root
README.

> **Discovery latency:** cold discovery on a fresh public-DHT topic takes ~20–35s. For
> demos use a local DHT bootstrap (`bare packages/hyperwave-lib-core/bin/dht-local.js` +
> `HYPERWAVE_BOOTSTRAP=127.0.0.1:<port>`) for instant same-machine discovery.

## What's in this package

- **`renderer/`** (Chromium, sandboxed, ESM) — UI only. Starts the worker via the preload
  `bridge`, receives engine events, draws the ring. Never touches the swarm or keys.
  - `app.js` orchestrates; `lib/` holds `ipc.js` (worker channel), `ring.js` (canvas),
    `gallery.js` (centre-selfie slideshow + 💵 tip), `lobby.js` (countdown + join),
    `proof.js` (lobby webcam capture), `hud.js` (status, Kick-off, 💰 chip, country picker),
    `countries.js`.
- **`electron/main.js`** — the template plus: a `media` permission line (webcam),
  storage-dir resolution/logging, and small helper IPC (`copy-text`, `open-external`,
  `isPackaged`). Spawns Bare workers with `PearRuntime.run(specifier, [dir, ...])`;
  `--storage <dir>` becomes the worker's `Bare.argv[2]`.
- **`workers/hyperwave.js`** (Bare, CJS) — a ~40-line host: wraps `Bare.IPC` in a
  `FramedStream` and calls `hyperwave-lib-core`'s `init()`. All P2P/protocol/wallet logic
  lives in the engine package.
- **`workers/updater.js`** — the template's OTA updater worker, left intact.

The IPC message surface (commands/events between renderer and engine) is documented in
[`../../docs/architecture.md`](../../docs/architecture.md) — it's shared with the mobile
host, not desktop-specific.

## The UI

The ring draws a yellow "you" dot, green peer dots, the **successor** in orange with a
baton line, and a 💰 wallet chip. The token is a **⚽ football that rolls clockwise around
the ring on every screen**. **Kick off the wave** burns the fee, then announces. During the
**lobby**, opted-in peers frame their selfie on camera (countdown to kickoff; captured
automatically at kickoff or on 📸). As the ball passes each participant, their staged selfie
posts and features **in the centre of the ring**; a 💵 Tip button under the featured selfie
sends real testnet TRX to its owner.

## Notes (app-shell specifics)

- `package.json#upgrade` must be a valid `pear://` link or `electron-forge start` refuses
  to boot (mint via `pear touch`).
- **Bare + npm deps:** some packages declare `engines.node` ranges Bare's semver can't
  parse, which crashes module resolution under pear-runtime. The root `postinstall`
  (`scripts/fix-bare-engines.js`) normalizes them; re-run it manually if you ever patch
  `node_modules`.
- Engine behavior (per-wave galleries, storage wipe on startup, wallet seed persistence,
  match topics, no peer roles) is engine-level, not desktop-specific — see
  [`../../docs/architecture.md`](../../docs/architecture.md) and
  [`../../docs/protocol.md`](../../docs/protocol.md).

## Tests

There are no desktop-specific tests; the engine's unit + e2e suites live in
`packages/hyperwave-lib-core` and run from the repo root:

```bash
npm test                  # engine unit suites (brittle, under Bare)
npm run test:e2e:local    # 8-peer end-to-end on a local DHT
```
