<p align="center">
  <img src="hyperwave-logo.png" alt="HyperWave" width="240" />
</p>

# HyperWave

**The stadium Mexican wave, rebuilt as a global peer-to-peer network experience.**

HyperWave turns the stadium wave into a global P2P relay. Peers join a
match-specific [Hyperswarm](https://github.com/holepunchto/hyperswarm) topic; each peer's
public key deterministically maps to a fixed seat on a 256-bit ring — the ring _is_ the
stadium seating chart.

Anyone can **kick off a wave**: a signed ⚽ token races peer-to-peer clockwise around the
ring visible on every screen, each hop cryptographically receipted into a
constant-size chain. As the ball passes each participant it posts a selfie into a shared per-wave
[Autobase](https://github.com/holepunchto/autobase) gallery that converges on every peer, with the
newest selfie featured in the ring centre.

With a built-in self-custodial wallet via
[WDK](https://docs.wdk.tether.io/) (for demo purpouses using TRON Nile Testnet)

- **Participation fees are burned** — initiator and joiners each send 1 TRX to Tron's
  black-hole address with an on-chain memo naming the wave. Skin in the game with no
  beneficiary: it's the anti-spam gate (peers verify the kick-off burn on-chain before
  joining).
- **Gallery tips** — Tip a selfie 1 TRX straight to its owner's wallet.
- **Optional raffle** — a wave's initiator can fund a prize; after the wave it draws one
  winner among gallery participants via an auditable **commit-reveal** draw (commits ride
  the burn memos on-chain) and pays from its own wallet, never itself.

Every peer runs the same code; the only asymmetry is per-wave (the initiator archives its own wave's gallery and runs its raffle). Waves self-heal around dead peers.

Built for the [Tether Developers Cup](https://dorahacks.io/hackathon/tether-developers-cup) (theme: football / global tournament moment).

## Repo layout

| Path                                                           | What                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/hyperwave-lib-core/`](packages/hyperwave-lib-core/) | The reusable Bare engine: ring, token race, gossip/Chord topology, Autobase gallery, WDK wallet, fees, raffle. Unit + e2e tests.                                                                                                                                  |
| [`apps/desktop/`](apps/desktop/)                               | Electron shell (forked from hello-pear-electron): ring UI, webcam lobby, gallery, wallet chip.                                                                                                                                                                    |
| [`apps/mobile/`](apps/mobile/)                                 | Expo + react-native-bare-kit host running the same engine as a worklet.                                                                                                                                                                                           |
| [`docs/`](docs/)                                               | [`architecture.md`](docs/architecture.md) · [`protocol.md`](docs/protocol.md) (on-wire spec) · [`scalable-topology.md`](docs/scalable-topology.md) (Chord over Hyperswarm) · [`idea.md`](docs/idea.md) (the idea, plain language) · [`raffle.md`](docs/raffle.md) |

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
selfies, the ⚽ racing the ring, a converging gallery, real testnet fee **burns**, and
gallery **tips** — all on the Tron **Nile testnet** with self-custodial wallets. No
servers.

Each instance needs its **own `--storage` dir** (own identity, Corestore, wallet).

Every wallet that **spends** needs TRX: peers pay a 1 TRX fee to start/join a wave, and a
little more to tip selfies.

### 1. Setup

```bash
# Run first instance
npm start -- --storage demo/one
```

Get the first instance's address from its **💰 chip** : click the copy button next to the address.

Fund the address via the **Nile Testnet faucet** — https://nileex.io/join/getJoinPage

Balances refresh in the 💰 chip every ~15s. `⚠ unfunded` means 0 TRX.

```bash
# Run additional instances in separate terminals
npm start -- --storage demo/two
npm start -- --storage demo/three
```

```bash
# From the funded instance's storage dir, send 20 TRX to another instance's address
WALLET=1 WALLET_SEND=<wallet-address-of-instance-two>:20 \
  bare packages/hyperwave-lib-core/lib/wave.run.js fund demo/one

WALLET=1 WALLET_SEND=<wallet-address-of-instance-three>:20 \
  bare packages/hyperwave-lib-core/lib/wave.run.js fund demo/one
```

### 2. Run the wave

In any window, hit **⚽ Kick off the wave**: Status shows **"🔥 paying the kick-off fee..."** — the initiator burns 1 TRX to Tron's black hole with an on-chain memo naming this wave, and only _then_ announces (the paid-wave anti-spam gate).

Other windows enter the **lobby**. The join button shows **"⏳ verifying payment..."**
until each peer has independently verified the initiator's burn on-chain, then
**"✋ Count me in"**. Joining burns that peer's own 1 TRX join fee.

Joined peers **frame their selfie during the lobby** (camera + countdown). At
kickoff the frame is captured automatically (or press 📸 early).

The **⚽ races the ring** (~250ms/hop) on every screen. As it passes each
participant, their selfie posts and features in the ring centre — the gallery fills
in ring order on all windows.

**Tip**: when someone else's selfie is featured, press **💵 Tip 1 TRX** — a real
transfer straight to that peer's wallet; the toast shows the tx hash. Tipping is the
only way anyone makes money — there are no sponsor rewards.

The wave **completes** back at the originator and
every window returns to idle together.

## License

[Apache 2.0](LICENSE)
