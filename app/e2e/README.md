# End-to-end tests

Black-box tests that run the **real app**: they spawn a local DHT bootstrap and N actual
`bare workers/lib/wave.run.js` peer processes, drive a full wave, and assert on the outcome.
Complements the pure-logic unit suite (`app/*.test.js`, run by `npm test` under Bare).

The harness runs under **Node** (for ergonomic process orchestration) and uses **brittle**
(the same TAP framework as the unit tests) for assertions. The peers under test are Bare — the
same binary the app ships.

## Two tiers

| Suite                   | What it exercises                                                                                                                                       | Deps                                                  | When                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------- |
| **`wave.local.e2e.js`** | discovery, ring/token race across N hops, gossip flooding, gallery replication + seed archival, self-healing under churn, commit-reveal raffle **draw** | none — local DHT, **no wallets / no on-chain**        | every push (CI)         |
| _on-chain_ (planned)    | paid-wave gate, real burns, optimistic-admission + raffle **payout**, tips                                                                              | funded testnet wallets (secrets), Nile RPC, costs TRX | manual / nightly, gated |

The local suite is deterministic and secret-free, so it guards every change in CI
(`.github/workflows/ci.yml`). The on-chain suite is a real external-testnet integration test —
it needs seed phrases as CI secrets and costs testnet TRX, so it stays gated.

## Running

```bash
cd app
npm run test:e2e:local          # 8 peers (default)
E2E_PEERS=4 npm run test:e2e:local   # fewer peers (faster / constrained box)
```

Each scenario reads like what it tests, e.g. _"the wave heals when peers die mid-race"_.

## How the harness works (`harness.js`)

- **No sleeps.** `waitForEvent(name)` / `waitForLine(re)` / `waitForGallery(min)` resolve the
  instant the condition is met, or reject with the process's output tail on timeout — fast and
  non-flaky. Assertions run against the protocol's own structured events (`wave.run.js` prints
  `[name] TOKEN {json}`), not brittle prose.
- **Reliable discovery.** `Cluster.start()` warms up the DHT before peers join, and the tests
  stagger launches — together that avoids the "first peer joins a half-formed DHT and is
  isolated" failure.
- **Clean teardown.** Peers are spawned in their own process group and killed by group
  (`bare` is a Node wrapper over a native child, so a plain PID kill would orphan the real
  process — and a "killed" peer would survive, breaking the healing test).
