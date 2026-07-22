<p align="center">
  <img src="hyperwave-logo.png" alt="HyperWave" width="200" />
</p>

# HyperWave

**A global wave of moments shared in a peer-to-peer network experience.**

HyperWave is a desktop app for capturing a photo at the very same instant as people all
around the world. You open it, say where you are, and join a **wave**. When someone starts
the wave, a glowing orange spark races around a circle of everyone taking part — and as it
reaches each person, their photo snaps and drops into a shared gallery that everyone sees
fill up in real time. There's no server and no sign-up: the apps talk directly to each
other. A tiny built-in bitcoin wallet keeps it fair — you spend a few play-money "sats" to
join (so bots can't flood it), and you can tip the photos you like.

## Installing with pear

```sh
# Requires npx 
npx pear-install pear://pwfsihrajqdzscrheaegd5n98xfo8qik9q4cpixjdenjniri718y
```

## Install pre-compiled package

Download your platform's package from [releases](https://github.com/mnaamani/hyper-wave/releases) page.

## Running from source

```bash
# bare commandline
npm i -g bare-runtime

git clone https://github.com/mnaamani/hyper-wave && cd hyper-wave

# postinstall auto-fixes dep engines ranges for Bare (scripts/fix-bare-engines.js)
npm install

# run the desktop app
npm start
```

## How it works

HyperWave turns a worldwide wave of moments into a global P2P relay. Peers join a
per-room [Hyperswarm](https://github.com/holepunchto/hyperswarm) topic; each peer's
public key deterministically maps to a fixed seat on a 256-bit ring — the ring _is_ the
participants around the world.

Anyone can **start a wave**: the initiator floods a start time and lap duration, and every
peer derives the **same angle-ordered schedule** locally and self-triggers its own moment. The ⚡ orange spark visible on every screen is rendered from that shared
schedule. As a peer's slot fires it posts a Moment into a per-wave **multicore CRDT** gallery
(each participant owns one [Hypercore](https://github.com/holepunchto/hypercore); every peer
merges the set locally and converges on a byte-identical gallery), with the newest Moment
featured in the ring centre. A dead peer's slot simply passes — the wave ends deterministically on every screen at once.

Money runs on a built-in **self-custodial [Cashu](https://cashu.space) wallet** — Chaumian
ecash on a Lightning-connected mint (the demo default is the free, auto-paying `testnut` test
mint; unit: **sat**).

- **Participation fees are burned** — the initiator and every joiner lock a tiny ecash fee
  (2 sats) to an unspendable **NUMS pubkey** (a secp256k1 point with no known private key),
  tagged with the wave id. Skin in the game with no beneficiary: it's the anti-spam gate
  (peers verify the start burn before joining).
- **Gallery tips** — Tip a featured Moment a few sats (5 sats) in ecash straight to its owner.
  The bearer token is delivered directly to the recipient who redeems it.

## Repo layout

| Path                                                                         | What                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/hyperwave-engine/`](packages/hyperwave-engine/)                   | The reusable, payment-agnostic Bare engine: ring geometry, the deterministic sweep, flooded gossip, multicore CRDT gallery, the pluggable wallet interface + fee flows. Unit + e2e tests.                                                                                                                                              |
| [`packages/hyperwave-wallet-cashu/`](packages/hyperwave-wallet-cashu/)       | The desktop's default wallet: Chaumian ecash (cashu-ts) on a Lightning mint — NUMS-burned fees, P2PK-locked tips. Sibling `hyperwave-wallet-tron/` (TRX + USDT via WDK) and `hyperwave-wallet/` (the abstract interface).                                                                                                              |
| [`electron/`](electron/) · [`renderer/`](renderer/) · [`workers/`](workers/) | Electron desktop shell at the repo root (forked from hello-pear-electron): ring UI, webcam lobby, gallery, wallet chip.                                                                                                                                                                                                                |
| [`mobile/`](mobile/)                                                         | Expo + react-native-bare-kit host running the same engine as a worklet.                                                                                                                                                                                                                                                                |
| Docs                                                                         | Engine: [`protocol.md`](packages/hyperwave-engine/docs/protocol.md) (on-wire spec) · [`usage.md`](packages/hyperwave-engine/docs/usage.md) (API). Apps: [`idea.md`](docs/idea.md) (the global wave of moments, plain language) · [`hosting.md`](docs/hosting.md) (app architecture) · [`cashu.md`](docs/cashu.md) (the payment layer). |


## Running tests

```sh
# optional sanity: all suites should pass
npm test

# optional end to end integration test
npm run test:e2e:local
```

## Demo

Run a full HyperWave demo on one machine: several peer windows, a paid wave with lobby
Moments, the ⚡ orange spark racing the ring, a converging gallery, ecash fee **burns**, and
gallery **tips** — all with self-custodial **Cashu** wallets on a Lightning mint (the free,
auto-paying `testnut` test mint). No servers, no faucet, no real sats.

Each instance needs its **own `--storage` dir** (own identity, Corestore, wallet).

Every wallet that **spends** needs a balance: peers burn a 2 sat fee to start/join a wave,
and 5 sat to tip a Moment. Each instance funds itself with **⬆ Top up** — no faucet and no
addresses.

### 1. Setup

```bash
# Run first instance
npm start -- --storage demo/one
```

Open the wallet view by clicking **💰**. Each instance has its own self-custodial ecash
wallet (proofs stored locally). Click **⬆ Top up** to mint 100 sat at the active mint — the
default `testnut` mint auto-pays the invoice, so funding is instant with no real Lightning.

Balances show in **sat** and refresh every ~15s. `⚠ unfunded` means 0 sat.

```bash
# Run additional instances in separate terminals
npm start -- --storage demo/two
npm start -- --storage demo/three
```

Fund the other instances the same way — open **💰** and hit **⬆ Top up** on each. Each mints
its own ecash from the mint, so there's nothing to send between instances. (A different mint
per peer is fine; tips still redeem across mints.)

### 2. Run the wave

In any window, hit **⚡ Start the wave**: Status shows **"🔥 paying the start fee..."** — the initiator burns 2 sat to the unspendable NUMS key, tagged with this wave, and only _then_ announces (the paid-wave anti-spam gate).

Other windows enter the **lobby**. The join button shows **"⏳ verifying payment..."**
until each peer has independently verified the initiator's burn (a NUT-07 checkstate at the
mint), then **"✋ Count me in"**. Joining burns that peer's own 2 sat fee.

Joined peers **frame their Moment during the lobby** (camera + countdown). At
the start the frame is captured automatically (or press 📸 early).

The **⚡ orange spark races the ring** on every screen. As it passes each
participant, their Moment posts and features in the ring centre — the gallery fills
in ring order on all windows.

**Tip**: when someone else's Moment is featured, press **⚡ Tip 5 sat** — the ecash bearer
token is delivered privately to that peer, who redeems it into their balance.

The wave **completes** at the same deterministic moment on every screen and every window returns to idle together.

## License

[Apache 2.0](LICENSE)
