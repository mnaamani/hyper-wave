# HyperWave ⚽

**A permissionless, peer-to-peer stadium wave — with real skin in the game.**

HyperWave turns the stadium "Mexican wave" into a global P2P relay. Peers join a
match-specific [Hyperswarm](https://github.com/holepunchto/hyperswarm) topic; each peer's
public key deterministically maps to a fixed seat on a 256-bit ring — the ring _is_ the
stadium seating chart. No registration, no server.

Anyone can **kick off a wave**: a signed ⚽ token races peer-to-peer clockwise around the
ring (~250ms/hop, visible on every screen), each hop cryptographically receipted into a
constant-size chain. Participants frame a **selfie during the lobby**; as the ball passes
them it posts into a shared per-wave [Autobase](https://github.com/holepunchto/autobase)
gallery that converges on every peer, newest selfie featured in the ring centre.

Real (testnet) money flows through it, self-custodial via
[WDK](https://docs.wdk.tether.io/) on Tron Nile:

- **Participation fees are burned** — initiator and joiners each send 1 TRX to Tron's
  black-hole address with an on-chain memo naming the wave. Skin in the game with no
  beneficiary: it's the anti-spam gate (peers verify the kick-off burn on-chain before
  joining).
- **Gallery tips** — 💵 tip a selfie 1 TRX straight to its owner's wallet. The only way
  anyone makes money; a tip always reaches a wallet that paid in.
- **Optional raffle** — a wave's initiator can fund a prize; after the wave it draws one
  winner among gallery participants via an auditable **commit-reveal** draw (commits ride
  the burn memos on-chain) and pays from its own wallet, never itself.

There are **no peer roles and no sponsor rewards** — every peer runs the same code; the
only asymmetry is per-wave (the initiator archives its own wave's gallery and runs its
raffle). Waves self-heal around dead peers. Built for the **Tether Developers Cup**
(theme: football / global tournament moment).

## Repo layout

| Path                                                           | What                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/hyperwave-lib-core/`](packages/hyperwave-lib-core/) | The reusable Bare engine: ring, token race, gossip/Chord topology, Autobase gallery, WDK wallet, fees, raffle. Unit + e2e tests.                                                                                                                                  |
| [`apps/desktop/`](apps/desktop/)                               | Electron shell (forked from hello-pear-electron): ring UI, webcam lobby, gallery, wallet chip.                                                                                                                                                                    |
| [`apps/mobile/`](apps/mobile/)                                 | Expo + react-native-bare-kit host running the same engine as a worklet.                                                                                                                                                                                           |
| [`docs/`](docs/)                                               | [`architecture.md`](docs/architecture.md) · [`protocol.md`](docs/protocol.md) (on-wire spec) · [`scalable-topology.md`](docs/scalable-topology.md) (Chord over Hyperswarm) · [`idea.md`](docs/idea.md) (the idea, plain language) · [`raffle.md`](docs/raffle.md) |

## Quickstart

```bash
npm install                                  # once, at the repo root
npm start -- --storage /tmp/hyperwave/one    # one instance per --storage dir
npm start -- --storage /tmp/hyperwave/two    # open several → they form a ring
npm test                                     # engine unit suites (brittle, under Bare)
```

The rest of this README is the full local demo walkthrough.

---

# Local demo

Run a full HyperWave demo on one machine: several peer windows, a paid wave with lobby
selfies, the ⚽ racing the ring, a converging gallery, real testnet fee **burns**, and
gallery **tips** — all on the Tron **Nile testnet** with self-custodial wallets. No
servers.

## 0. Prerequisites

- **Node.js** ≥ 18 and npm.
- **Bare** (Holepunch runtime, used by tests/headless): `npm i -g bare-runtime` — the GUI
  itself doesn't need it, but the bootstrap node and headless tools run on it.
- Install:

```bash
npm install     # postinstall auto-fixes dep engines ranges for Bare (scripts/fix-bare-engines.js)
npm test        # optional sanity: all suites should pass
```

- **Internet access** — wallets talk to `https://nile.trongrid.io` (balances, burns,
  transfers, verification). The P2P layer itself is local if you use the bootstrap below.

## 1. Start a local DHT bootstrap (instant discovery)

Public-DHT discovery takes ~20–35s cold. A local bootstrap makes it ~1s:

```bash
bare packages/hyperwave-lib-core/lib/bootstrap.js
# prints e.g.:  BOOTSTRAP 127.0.0.1:49737     # note the <port>, keep this running
```

Export it (plus an isolated match topic so you never mingle with strangers on the
public default topic) in **every** terminal you'll launch from:

```bash
export HYPERWAVE_BOOTSTRAP=127.0.0.1:<port>
export HYPERWAVE_MATCH="hyperwave:test:v0"
```

## 2. Launch the instances

Each instance needs its **own `--storage` dir** (own identity, Corestore, wallet).

```bash
# Terminals 1..3
npm start -- --storage /tmp/hyperwave/one
npm start -- --storage /tmp/hyperwave/two
npm start -- --storage /tmp/hyperwave/three
```

Within a couple of seconds every window shows all the others as dots on the ring.

> Prefer more peers with fewer terminals? Any peer can also run headless:
> `WALLET=1 AUTOJOIN=1 AUTOSELFIE=1 bare packages/hyperwave-lib-core/lib/wave.run.js D /tmp/hyperwave/four`

## 3. Fund the wallets

Every wallet that **spends** needs TRX: peers pay a 1 TRX fee to start/join a wave, and a
little more to tip selfies. Fund any wallet that will kick off, join, or tip.

1. Read each instance's address from its **💰 chip** (or the worker log line
   `[wallet] wallet ready T...`). Seeds persist at `<storage>/wallet.seed`, so funding is
   a one-time step per storage dir.
2. Fund via the **Nile Testnet faucet** — https://nileex.io/join/getJoinPage — 2000 test
   TRX per address per day.
3. Shortcut: faucet **one** address, then fan out from it (first send to a fresh address
   costs ~1 TRX extra — account activation):

```bash
# from the funded instance's storage dir, send 20 TRX to another instance's address
WALLET=1 WALLET_SEND=<recipient-address>:20 bare packages/hyperwave-lib-core/lib/wave.run.js fund /tmp/hyperwave/one
```

Balances refresh in the 💰 chip every ~15s. `⚠ unfunded` means 0 TRX.
Explore balances/transactions on https://nile.tronscan.org/

## 4. Run the wave (what to expect)

1. Pick your **team** (flag) on first launch.
2. In any window, hit **⚽ Kick off the wave**:
   - Status shows **"🔥 paying the kick-off fee..."** — the initiator burns 1 TRX to
     Tron's black hole with an on-chain memo naming this wave, and only _then_
     announces (the paid-wave anti-spam gate).
3. Other windows enter the **lobby**. The join button shows **"⏳ verifying payment..."**
   until each peer has independently verified the initiator's burn on-chain, then
   **"✋ Count me in"**. Joining burns that peer's own 1 TRX join fee.
4. Joined peers **frame their selfie during the lobby** (camera + countdown). At
   kickoff the frame is captured automatically (or press 📸 early).
5. The **⚽ races the ring** (~250ms/hop) on every screen. As it passes each
   participant, their selfie posts and features in the ring centre — the gallery fills
   in ring order on all windows.
6. **Tip**: when someone else's selfie is featured, press **💵 Tip 1 TRX** — a real
   transfer straight to that peer's wallet; the toast shows the tx hash. Tipping is the
   only way anyone makes money — there are no sponsor rewards.
7. The wave **completes** back at the originator, which floods a signed `wave-end`, and
   every window returns to idle together.
8. Kill a peer window mid-race if you like — the wave **heals** around it (it forwards to
   the next reachable peer clockwise).

## 5. Verify the burns on-chain (the provable part)

Every fee is a real transfer to the unspendable black hole
`T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb`, memo-tagged `hyperwave:<waveId>:<peerId>` (plus a
`:<raffleCommit>` segment when the raffle is on — that's the on-chain commitment):

```bash
curl -s -X POST https://nile.trongrid.io/wallet/gettransactionbyid \
  -H 'Content-Type: application/json' -d '{"value":"<txHash-from-the-🔥-toast>"}' |
  python3 -c "import sys,json;d=json.load(sys.stdin);print(bytes.fromhex(d['raw_data']['data']).decode())"
# → hyperwave:<waveId>:<peerId>[:<raffleCommit>]
```

Or paste the hash into https://nile.tronscan.org. See [`docs/protocol.md`](docs/protocol.md)
§9 for the full mechanism, and §12 for how the raffle commit in the memo makes the draw
auditable.

## Headless demo (no GUI)

For a quick end-to-end check in two terminals (after step 1's exports; fund both wallets
first — same as step 3):

```bash
WALLET=1 START=1 AUTOJOIN=1 AUTOSELFIE=1  bare packages/hyperwave-lib-core/lib/wave.run.js A /tmp/hw/A
WALLET=1 AUTOJOIN=1 AUTOSELFIE=1          bare packages/hyperwave-lib-core/lib/wave.run.js B /tmp/hw/B
# expect: KICKOFF-BURNED → announcing (paid) → JOIN-BURNED → GALLERY size=2 on both
```

## Optional: add a raffle (a positive incentive)

The wave's initiator can draw a raffle after its wave — one winner among the gallery
participants gets a prize (commit-reveal draw; see [`docs/protocol.md`](docs/protocol.md)
§12 and [`docs/raffle.md`](docs/raffle.md)). Set `HYPERWAVE_RAFFLE_TRX` on the initiator:

```bash
# The initiator (START) pays a 3 TRX prize; joiners burn 1 TRX and are eligible for the draw
HYPERWAVE_RAFFLE_TRX=3 WALLET=1 START=1 AUTOJOIN=1 AUTOSELFIE=1 bare packages/hyperwave-lib-core/lib/wave.run.js A /tmp/hw/A
WALLET=1 AUTOJOIN=1 AUTOSELFIE=1                                bare packages/hyperwave-lib-core/lib/wave.run.js B /tmp/hw/B
# expect on A: RAFFLE-DRAW tickets=N → RAFFLE-WIN ... TRX -> <winner wallet> tx=...
# net for a winner: −1 (fee) +3 (prize)
```

> Testnet only — a paid-entry game of chance is legally a lottery in most jurisdictions.

## Troubleshooting

| Symptom                                   | Cause / fix                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Peers don't see each other for ~30s       | You're on the public DHT — set `HYPERWAVE_BOOTSTRAP` (step 1) in every terminal, or just wait.                                |
| Strangers/ghost dots on the ring          | You're on the shared default topic — set `HYPERWAVE_MATCH` everywhere.                                                        |
| `wallet init failed: INVALID_VERSION ...` | A dep's `engines` range Bare can't parse. `node scripts/fix-bare-engines.js`, restart. (Runs automatically on `npm install`.) |
| Kick-off stuck at "paying..."             | Initiator's wallet is unfunded (needs ≥ ~2 TRX), or no Nile connectivity. Check the 💰 chip.                                  |
| Join button stuck "verifying payment..."  | The joiner can't see the burn on Nile yet (a few s) or has no connectivity; it enables on `wave-verified`.                    |
| First send to a new wallet costs extra    | ~1 TRX account-activation fee on Tron — expected.                                                                             |
| Faucet limit reached                      | 2000 TRX/address/day — faucet a different address and fan out (step 3).                                                       |

## Tests

```bash
npm test                  # engine unit suites (brittle, under Bare)
npm run test:e2e:local    # 8-peer end-to-end wave on a local DHT (no wallet, deterministic)
npm run test:e2e:onchain  # enforced wave on Nile with real burns (needs funded-wallet secrets)
npm run lint              # prettier + lunte
```
