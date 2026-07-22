<p align="center">
  <img src="hyperwave-logo.png" alt="HyperWave" width="200" />
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

Money runs on a built-in **self-custodial [Cashu](https://cashu.space) wallet** — Chaumian
ecash on a Lightning-connected mint (the demo default is the free, auto-paying `testnut` test
mint; unit: **sat**). No accounts, no smart contracts, testnet only.

- **Participation fees are burned** — the initiator and every joiner lock a tiny ecash fee
  (2 sat) to an unspendable **NUMS pubkey** (a secp256k1 point with no known private key),
  tagged with the wave id. Skin in the game with no beneficiary: it's the anti-spam gate
  (peers verify the start burn before joining).
- **Gallery tips** — Tip a featured Moment a few sats (5 sat) in ecash straight to its owner.
  The bearer token is delivered privately (off the flood) and the recipient redeems it.

The payment layer is **pluggable** — the engine ships no wallet and stays theme- and
money-agnostic; the desktop injects Cashu, while a Tron wallet (native TRX + TRC-20 USDT,
via [WDK](https://docs.wdk.tether.io/)) is an alternate wallet package a host can plug in
instead.

Every peer runs the same code — the protocol is fully role-free (the initiator is an ordinary participant that just calls "start"). Every peer subscribed to a wave holds every participant's gallery core for it, so there is no indexer, no archivist, and no single point of failure; galleries are ephemeral per run. Waves run concurrently, and a peer holds cores only for the waves it subscribed to.

A submission for the **Tether Developers Cup** (DoraHacks). The cup's brief — a _global tournament moment_ — is realized here as a worldwide **wave of moments**: peers around the world capture a moment together as a bitcoin-orange wave sweeps the ring.

## Repo layout

| Path                                                                         | What                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/hyperwave-engine/`](packages/hyperwave-engine/)                   | The reusable, payment-agnostic Bare engine: ring geometry, the deterministic sweep, flooded gossip, multicore CRDT gallery, the pluggable wallet interface + fee flows. Unit + e2e tests.                                                                                                                                              |
| [`packages/hyperwave-wallet-cashu/`](packages/hyperwave-wallet-cashu/)       | The desktop's default wallet: Chaumian ecash (cashu-ts) on a Lightning mint — NUMS-burned fees, P2PK-locked tips. Sibling `hyperwave-wallet-tron/` (TRX + USDT via WDK) and `hyperwave-wallet/` (the abstract interface).                                                                                                              |
| [`electron/`](electron/) · [`renderer/`](renderer/) · [`workers/`](workers/) | Electron desktop shell at the repo root (forked from hello-pear-electron): ring UI, webcam lobby, gallery, wallet chip.                                                                                                                                                                                                                |
| [`mobile/`](mobile/)                                                         | Expo + react-native-bare-kit host running the same engine as a worklet.                                                                                                                                                                                                                                                                |
| Docs                                                                         | Engine: [`protocol.md`](packages/hyperwave-engine/docs/protocol.md) (on-wire spec) · [`usage.md`](packages/hyperwave-engine/docs/usage.md) (API). Apps: [`idea.md`](docs/idea.md) (the global wave of moments, plain language) · [`hosting.md`](docs/hosting.md) (app architecture) · [`cashu.md`](docs/cashu.md) (the payment layer). |

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
