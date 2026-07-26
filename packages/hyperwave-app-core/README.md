# hyperwave-app-core

The framework-agnostic **view-model** both HyperWave hosts drive — the Electron renderer
(`renderer/app.js`) and the React Native app (`mobile/src/useEngine.js`). It owns the app's STATE
and RULES; each host keeps its own rendering and its own transport to the engine.

Zero dependencies, plain **ESM**, no build step: a `file://` renderer imports it by path
(`../node_modules/hyperwave-app-core/index.js`) and Metro imports it by name. It never imports the
engine — it talks to it only through the injected `send`.

```js
const core = createAppCore({
  send: (type, args) => transport.call(type, args),
  now: () => performance.now(), // desktop shares the renderer's time base
  onBeforeSwitchWave: () => proof.captureAndStage()
});

core.subscribe((snapshot, kind) => paint(snapshot, kind));
core.handle(engineMessage); // feed it EVERY engine message
core.selectWave(waveId);
core.tip({ waveId, peerId, address, amount });
```

## What it owns

- the **wave directory** (every announced wave) + a per-wave **feed cache**
- **active-wave selection**, and superseding my own prior wave
- the **ended-wave lifecycle**: linger → fade → drop → `unsubscribe`
- **wallet metadata** + the same-network filter
- the **tip choreography**: `tip` → `dm` the bearer token + `note` the announcement; `redeem` an
  inbound `dm`
- the app's **theme mapping** (an entry `payload` ↔ a moment; a peer `tag` ↔ a country)

It owns no presentation: no DOM, no React, no fixed timers (inject `now`/`setTimer` — that's how the
ended-wave TTL is tested).

## Snapshot change kinds

`subscribe(fn)` calls `fn(snapshot, kind)`. A host may ignore `kind` and repaint everything, or use
it to repaint precisely:

| kind          | meaning                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `ring`        | the global peer ring (a `state` message)                                 |
| `waves`       | directory metadata only                                                  |
| `feed`        | a wave's feed cache                                                      |
| `wallet`      | wallet metadata, same network                                            |
| `network`     | the wallet's settlement network changed (the active wave still stands)   |
| `select`      | the user opened a wave — the host re-owns its main view                  |
| `auto-select` | MY new wave was auto-engaged; the host's own announce handling paints it |
| `deselect`    | the active wave went away (dropped, or became cross-network)             |

## Rules a host must honour

The core can't enforce these for the host:

1. **Feed every engine message to `handle(msg)` BEFORE the host's own handling of that message**, so
   the directory and active wave are current when the host paints. (The desktop registers the core's
   `ipc.on` listeners first; the mobile client calls `core.handle(msg)` at the top of its `onEvent`.)
2. **Presentation-coupled sequencing stays in the host** — e.g. the desktop's `gallery.setActive()`
   before `gallery.handle()`, and `captureAndStage()` before reopening the gallery. The snapshot
   carries enough state for the host to order its own painting.
3. **Stage a pending capture in `onBeforeSwitchWave`** — the core calls it synchronously before the
   active wave changes (invariant 3 below).

## The five invariants

Each is a bug that was fixed once in the desktop renderer, and each has a test here
(`lib/app-core.test.js`). A re-implementation re-breaks all five, which is why this package exists:

1. **Only `wave-announce` may CREATE a directory entry.** Every other event updates a wave already
   known, or a late `roster` / echoed `unsubscribed` spawns a phantom by-less wave.
2. **`dm` and `note` are wave-agnostic.** A `dm` carries a P2PK-locked Cashu token and must be
   redeemed even when it arrives for a wave the user has navigated away from. Routing it "for the
   active wave only" silently destroys received sats.
3. **The pending capture is staged BEFORE switching waves**, or a wave that starts while the user
   browses elsewhere posts nothing.
4. **A network change deselects a now-cross-network active wave** (its gallery + tip must go away).
5. **Ended waves are unsubscribed when dropped** — this is what keeps the core budget
   O(subscribed).

## Known duplication

`lib/topic.js` (the wallet-network → directory-topic policy) is the source of truth for that rule,
but the two Bare hosts that actually issue `set-topic` (`workers/hyperwave.js` and
`packages/hyperwave-engine/worklet/app.js`) are **CJS** and cannot `require()` this ESM package, so
they carry a small mirror of it. Keep them in sync; the test here pins the rule.

## Tests

```bash
bare test.js        # from this directory (or `npm test` from the repo root)
```
