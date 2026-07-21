<p align="center">
  <img src="hyperwave-logo.png" alt="HyperWave" width="240" />
</p>

# HyperWave

**A global wave of moments, rebuilt as a peer-to-peer network experience.**

HyperWave turns a worldwide wave of moments into a global P2P relay. Peers join a
per-room [Hyperswarm](https://github.com/holepunchto/hyperswarm) topic; each peer's
public key deterministically maps to a fixed seat on a 256-bit ring — the ring _is_ the
participants around the world.

Anyone can **start a wave**: the initiator floods a start time and lap duration, and every
peer derives the **same angle-ordered schedule** locally and self-triggers its own moment —
no token, no per-hop messages. The ⚡ orange spark visible on every screen is rendered from that shared
schedule. As a peer's slot fires it posts a Moment into a per-wave **multicore CRDT** gallery
(each participant owns one [Hypercore](https://github.com/holepunchto/hypercore); every peer
merges the set locally and converges on a byte-identical gallery), with the newest Moment
featured in the ring centre. A dead peer's slot simply passes — the wave ends deterministically
on every screen at once.

With a built-in self-custodial wallet via
[WDK](https://docs.wdk.tether.io/) (for demo purpouses using TRON Nile Testnet)

- **Participation fees are burned** — initiator and joiners each send 1 TRX to Tron's
  black-hole address with an on-chain memo naming the wave. Skin in the game with no
  beneficiary: it's the anti-spam gate (peers verify the start burn on-chain before
  joining).
- **Gallery tips** — Tip a Moment 1 TRX straight to its owner's wallet.

Every peer runs the same code — the protocol is fully role-free (the initiator is an ordinary participant that just calls "start"). Every peer subscribed to a wave holds every participant's gallery core for it, so there is no indexer, no archivist, and no single point of failure; galleries are ephemeral per run. Waves run concurrently, and a peer holds cores only for the waves it subscribed to.

A submission for the **Tether Developers Cup** (DoraHacks). The cup's brief — a _global tournament moment_ — is realized here as a worldwide **wave of moments**: peers around the world capture a moment together as a bitcoin-orange wave sweeps the ring.

## Repo layout

| Path                                                                         | What                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/hyperwave-engine/`](packages/hyperwave-engine/)                   | The reusable Bare engine: ring geometry, the deterministic sweep, flooded gossip, multicore CRDT gallery, WDK wallet, fees. Unit + e2e tests.                                                                                                                                                                                      |
| [`electron/`](electron/) · [`renderer/`](renderer/) · [`workers/`](workers/) | Electron desktop shell at the repo root (forked from hello-pear-electron): ring UI, webcam lobby, gallery, wallet chip.                                                                                                                                                                                                            |
| [`mobile/`](mobile/)                                                         | Expo + react-native-bare-kit host running the same engine as a worklet.                                                                                                                                                                                                                                                            |
| Docs                                                                         | Engine: [`protocol.md`](packages/hyperwave-engine/docs/protocol.md) (on-wire spec) · [`usage.md`](packages/hyperwave-engine/docs/usage.md) (API). Apps: [`idea.md`](docs/idea.md) (the global wave of moments, plain language) · [`hosting.md`](docs/hosting.md) (app architecture). Project: [`docs/`](docs/) (index + research). |

## Quickstart

```bash
# bare commandline
npm i -g bare-runtime

# postinstall auto-fixes dep engines ranges for Bare (scripts/fix-bare-engines.js)
npm install

# optional sanity: all suites should pass
npm test

# optional end to end integration test
npm run test:e2e:local

# run the desktop app
npm start
```

## Demo

Run a full HyperWave demo on one machine: several peer windows, a paid wave with lobby
Moments, the ⚡ orange spark racing the ring, a converging gallery, real testnet fee **burns**, and
gallery **tips** — all on the Tron **Nile testnet** with self-custodial wallets. No
servers.

Each instance needs its **own `--storage` dir** (own identity, Corestore, wallet).

Every wallet that **spends** needs TRX: peers pay a 1 TRX fee to start/join a wave, and a
little more to tip Moments.

### 1. Setup

```bash
# Run first instance
npm start -- --storage demo/one
```

Get the first instance's address from its : .

Fund the first instance wallet. Open the wallet view by clicking on **💰**.

Then click the "Copy" button next to the address. Click "Get test TRX" to visit the free token faucet page.

Paste the address in the "Account Address" field and click 'Obtain' button.

The Balances refresh in the wallet view every ~15s. `⚠ unfunded` means 0 TRX.

```bash
# Run additional instances in separate terminals
npm start -- --storage demo/two
npm start -- --storage demo/three
```

Now fund the other instances from the first one, right in the app: on each of instance
two and three, open **💰** and **Copy** its address. Back on the funded first instance,
open **💰**, click **Send ▸**, paste the recipient address, enter an amount (e.g. `100`),
and hit **Send**. Repeat for the other address. Each transfer shows up in that wallet's
**Transactions** list with a clickable Tronscan link, and balances refresh automatically.

### 2. Run the wave

In any window, hit **⚡ Start the wave**: Status shows **"🔥 paying the start fee..."** — the initiator burns 1 TRX to Tron's black hole with an on-chain memo naming this wave, and only _then_ announces (the paid-wave anti-spam gate).

Other windows enter the **lobby**. The join button shows **"⏳ verifying payment..."**
until each peer has independently verified the initiator's burn on-chain, then
**"✋ Count me in"**. Joining burns that peer's own 1 TRX join fee.

Joined peers **frame their Moment during the lobby** (camera + countdown). At
the start the frame is captured automatically (or press 📸 early).

The **⚡ orange spark races the ring** on every screen. As it passes each
participant, their Moment posts and features in the ring centre — the gallery fills
in ring order on all windows.

**Tip**: when someone else's Moment is featured, press **💵 Tip 1 TRX** — to
transfer some tokens straight to that peer's wallet.

The wave **completes** at the same deterministic moment on every screen and every window returns to idle together.

## License

[Apache 2.0](LICENSE)
