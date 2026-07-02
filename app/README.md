# HyperWave (desktop MVP)

Electron + Pear desktop app for the HyperWave P2P stadium wave. Forked from
[`holepunchto/hello-pear-electron`](https://github.com/holepunchto/hello-pear-electron).
Design: `../ideas/final-idea.md` (§11 = this desktop MVP).

## Architecture (as wired today)

- **`renderer/`** (Chromium, sandboxed) — UI only. Starts the worker via the preload
  `bridge`, receives `state` messages, draws the ring. Never touches the swarm.
- **`electron/main.js`** — unchanged from the template. Spawns Bare workers with
  `PearRuntime.run(specifier, [dir, ...])`; `--storage <dir>` becomes the worker's
  `Bare.argv[2]`, giving each instance its own identity + Corestore.
- **`workers/hyperwave.js`** (Bare) — bridges `lib/wave.js` to Electron IPC.
- **`workers/lib/wave.js`** — runtime-agnostic P2P engine (Node + Bare):
  - **Discovery + gossip:** Hyperswarm join (configurable `matchId`), Corestore replication,
    and presence + ring-update gossip over a Protomux channel multiplexed onto each
    connection. Live, sorted ring (liveness TTL) + each peer's **successor** (next clockwise).
  - **Token race:** `startWave()` mints a wave-token; each peer verifies the sender's Ed25519
    receipt, advances a **constant-size blake2b chain accumulator** (not a growing hops[]),
    signs its own receipt, and forwards to its successor; the token returns to the originator
    to complete the lap. Signing reuses the Hyperswarm keypair (= ring identity). A per-hop
    **dwell** (`hopDelayMs`, default 1200ms) paces the token so the wave visibly ripples around
    the ring and proof windows open in sequence instead of all at once.
  - **Gallery (Autobase):** the originator creates a per-wave Autobase and announces its key
    (gossip + in the token). Peers open it by key, request writer admission (`add-writer` — the
    anti-spam gate), and `postSelfie()` appends a `wave-selfie` entry (inline JPEG thumbnail +
    hop + receipt). All peers converge on one ordered gallery via replication over the existing
    connections. Hyperblobs is the scaling path (deferred; inline thumbnails for the MVP).
  - Pure helpers exported + unit-tested: `angleOf`, `liveRing`, `nextClockwise` (ring),
    `receiptHash`, `signReceipt`, `verifyToken`, `advanceChain` (token), `buildGallery` +
    `galleryConfig`/`readGallery` (gallery).
  - WDK (bond / payout / tipping) layers on top of this next.
- **`workers/main.js`** — the template's OTA updater worker, left intact.
- **`electron/main.js`** — one addition to the template: a `setPermissionRequestHandler` that
  allows `media` so the proof-window webcam works.

### Worker → renderer messages

```js
// ring state (on every change)
{ type: 'state',
  me:        { id, angle },
  peers:     [ { id, angle, lastSeen }, ... ],  // live, sorted clockwise
  successor: { id, angle } | null }              // next peer clockwise (wraps)

// token race events
{ type: 'token', event: 'started'  , waveId, by }
{ type: 'token', event: 'forwarded', waveId, hopCount, to }
{ type: 'token', event: 'holding'  , waveId, hopCount, holder, angle, receiptSig, chainHash }  // I hold it: opens proof window
{ type: 'token', event: 'position' , waveId, hopCount, holder, angle }  // another peer holds it: roll the ball there
{ type: 'token', event: 'completed', waveId, hops, chainHash, angle }
{ type: 'token', event: 'stalled'  , waveId, reason }

// gallery (Autobase view) — on every change / replication
{ type: 'gallery', items: [ { waveId, peerId, hopCount, caption, image /* dataURL */, ... }, ... ] }
```

### Renderer → worker commands

```js
{ type: 'start-wave' }                 // this peer becomes the originator
{ type: 'post-selfie', selfie: { waveId, hopCount, receiptSig, chainHash, caption, image } }
```

The ring UI draws a yellow "you" dot, green peer dots, and highlights the **successor** in orange
with a baton line. The token is a **⚽ football that rolls clockwise around the ring, holder to
holder, on every screen** (each peer broadcasts a `wave-pos` when it holds; every renderer
animates the ball there). **Kick off the wave** originates a token. When the ball reaches you, a
**proof-window modal** opens the webcam, counts down, and captures a selfie for the gallery — which
plays **one selfie at a time in the centre of the ring**, featuring each new arrival then
auto-cycling when idle.

## Run

```bash
npm install

# Each instance needs its own --storage dir (own identity + Corestore).
# Open several terminals / windows:
npm start -- --storage /tmp/hyperwave/one
npm start -- --storage /tmp/hyperwave/two
npm start -- --storage /tmp/hyperwave/three
```

Each window shows the DHT ring with a yellow "you" dot and a green dot per discovered peer.

> **Discovery latency:** cold discovery on a fresh public-DHT topic takes **~20–35s** the
> first time (server announce propagation). For the live demo, launch all instances ~30s before
> showing, or use the local DHT bootstrap below for instant same-machine discovery.

## Tests (no GUI)

Everything runs under **Bare** — the worker's real runtime (`bare`, not `node`). Node is only
used by Electron's main process. Run from `app/`:

```bash
# 1) Pure ring logic — successor + liveness TTL (deterministic, instant)
bare workers/lib/wave.logic.test.js

# 2) Token logic — receipts, chain accumulator, completion, tamper rejection (instant)
bare workers/lib/wave.token.test.js

# 3) Gallery ordering — buildGallery dedup/sort (instant)
bare workers/lib/wave.gallery.test.js

# 4) Gallery Autobase path — real apply/view, selfie append + read (in-process, instant)
bare workers/lib/wave.autobase.test.js

# 5) End-to-end — one wave per process (the real worker topology). AUTOSELFIE posts a
#    fake selfie in each proof window; both peers should converge on GALLERY size=2.
#    Public DHT: allow ~30-90s to discover (variable). Isolate with a match id.
export HYPERWAVE_MATCH="test-$(date +%s)"
START=1 AUTOSELFIE=1 bare workers/lib/wave.run.js A /tmp/hw/a
AUTOSELFIE=1 bare workers/lib/wave.run.js B /tmp/hw/b
```

### Fast local discovery (optional)

`createWave` accepts a `bootstrap` option (and `wave.run.js` reads
`HYPERWAVE_BOOTSTRAP=host:port`) to use a **local DHT** instead of the public one, for
near-instant same-machine discovery:

```bash
bare workers/lib/bootstrap.js          # prints "BOOTSTRAP 127.0.0.1:<port>", stays up
HYPERWAVE_BOOTSTRAP=127.0.0.1:<port> bare workers/lib/wave.run.js A /tmp/hw/a
HYPERWAVE_BOOTSTRAP=127.0.0.1:<port> bare workers/lib/wave.run.js B /tmp/hw/b
```

> Confirmed working on the dev Mac (it only failed inside the CI-style sandbox where loopback
> UDP holepunch is blocked). Use it to make the live demo instant instead of waiting ~30s.

## Notes

- `package.json#upgrade` must be a valid `pear://` link or `electron-forge start` refuses to
  boot. Minted with `pear touch`. Regenerate with `pear touch` and `npm pkg set upgrade=...`
  if needed.
- Two Hyperswarm instances in the **same** process don't reliably discover each other — always
  test/run one instance per process (which is how the app works anyway).
- **Shared topic:** all instances on the same `matchId` join one ring. The app currently uses a
  fixed default (`hyperwave:demo-match:v1`), so any instances running on the **public** DHT at
  the same time share a ring (a running window will join your test's ring and skew the
  successor). Isolate with `matchId` (engine option) / `HYPERWAVE_MATCH` (test harness), and/or
  use the local bootstrap. Per-match topics are the intended production model (final-idea §2.2).
- **Per-wave galleries:** each wave's gallery is a separate Autobase namespaced by its random
  `waveId` (`wave-gallery:<waveId>`), so a new wave/run starts with an empty gallery instead of
  showing selfies from previous waves/runs. Trade-off: old per-wave namespaces accumulate on
  disk under `--storage` (TODO: prune, or add a wave picker to browse past galleries).
