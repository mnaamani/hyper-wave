# End-to-end tests

Black-box tests that run the **real app**: they spawn a local DHT bootstrap and N actual
`bare bin/wave.run.js` peer processes, drive a full wave, and assert on the outcome.
Complements the pure-logic unit suite (`app/*.test.js`, run by `npm test` under Bare).

**No roles — N equal peers.** There is no dedicated seed/validator process, and no
archivist: every peer holds every participant's gallery core and merges it locally. The
peers are identical; `p1` is just the wave **initiator** (kicks off once it sees the other
N-1 peers via `START=N-1`) — an ordinary participant that happens to call kick-off.

The harness runs under **Node** (for ergonomic process orchestration) and uses **brittle**
(the same TAP framework as the unit tests) for assertions. The peers under test are Bare — the
same binary the app ships.

## Two tiers

| Suite                     | What it exercises                                                                                                                                                     | Deps                                                  | When                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------- |
| **`wave.local.e2e.js`**   | discovery, the deterministic sweep across the roster, gossip flooding, multicore CRDT gallery convergence, survival when peers die mid-wave (a dead slot just passes) | none — local DHT, **no wallets / no on-chain**        | every push (CI)         |
| **`wave.onchain.e2e.js`** | paid-wave gate, real fee burns, on-chain kick-off verification, the per-peer join burn gate                                                                           | funded testnet wallets (secrets), Nile RPC, costs TRX | manual / nightly, gated |

The local suite is deterministic and secret-free, so it guards every change in CI
(`.github/workflows/ci.yml`). The on-chain suite is a real external-testnet integration test —
it needs funded wallet mnemonics as secrets and costs testnet TRX, so it stays gated
(`.github/workflows/e2e-onchain.yml`: manual dispatch + nightly).

## Running

```bash
cd app
npm run test:e2e:local               # 8 peers (default)
E2E_PEERS=4 npm run test:e2e:local   # fewer peers (faster / constrained box)

# on-chain tier — needs two funded Nile mnemonics; skips itself if unset:
E2E_ONCHAIN=1 \
  HYPERWAVE_E2E_SEED_1="word word …" \  # initiator P1 (kick-off burn; well-funded)
  HYPERWAVE_E2E_SEED_2="word word …" \  # joiner P2 (join burn)
  npm run test:e2e:onchain
```

Each scenario reads like what it tests, e.g. _"the wave completes when peers die mid-sweep"_.

## How the harness works (`harness.js`)

- **No sleeps.** `waitForEvent(name)` / `waitForLine(re)` / `waitForGallery(min)` resolve the
  instant the condition is met, or reject with the process's output tail on timeout — fast and
  non-flaky. Assertions run against the protocol's own structured events (`wave.run.js` prints
  `[name] EVENT {json}`), not
  brittle prose.
- **Reliable discovery.** `Cluster.start()` warms up the DHT before peers join, and the tests
  stagger launches — together that avoids the "first peer joins a half-formed DHT and is
  isolated" failure.
- **Clean teardown.** Peers are spawned in their own process group and killed by group
  (`bare` is a Node wrapper over a native child, so a plain PID kill would orphan the real
  process — and a "killed" peer would survive, breaking the kill/survival test).
