# Cashu payments (the desktop default)

HyperWave's payment layer is pluggable (the abstract `Wallet` interface,
`packages/hyperwave-engine/lib/wallet.js`). The **desktop default** is **Cashu** —
Chaumian ecash on a Lightning-connected mint — implemented in its own package,
**`packages/hyperwave-wallet-cashu/`** (the engine ships no wallet; a host injects
one via `createEngine({ deps: { createPayments: createCashuWallet } })`). The Tron
(TRX) + TRC-20 USDT wallets live in `packages/hyperwave-wallet-tron/`. This doc
covers the Cashu mechanism; the on-wire protocol is unchanged (see
`packages/hyperwave-engine/docs/protocol.md` §9).

## Why it fits the money model

The rules don't change: **burned participation fees + gallery tips, no sponsor
rewards, testnet only.** Cashu maps each concept onto ecash without touching the
gossip protocol — everything rides the existing opaque wire fields (`walletType`,
the `paid`/`burn` attestations, `address`, `fee`).

| Concept                                   | Tron                                            | Cashu                                                                                                             |
| ----------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Burn destination                          | black-hole address `T9yD14Nj…`                  | a **NUMS pubkey** (hash-derived secp256k1 point; no known private key) — ecash P2PK-locked to it is irrecoverable |
| Burn memo (`hyperwave:<waveId>:<peerId>`) | on-chain tx `data`                              | a **mint-signed NUT-11 tag** in the locking secret                                                                |
| `burnRef` (the burn reference)            | 64-char tx hash                                 | the serialized `cashuB` token (~600 B)                                                                            |
| `verifyBurnTx`                            | `getTransaction` (to==black hole, amount, memo) | decode + structural check + **NUT-07 checkstate** (still UNSPENT under an unspendable lock = burned)              |
| `walletType`                              | `tron-nile`                                     | `cashu` (**generic — not per-mint**)                                                                              |
| unit                                      | TRX                                             | sat                                                                                                               |

The NUMS burn key is derived deterministically from the frozen domain string
`hyperwave:burn:v1` (`hyperwave-wallet-cashu/lib/nums.js`), so every peer computes the identical key and
an auditor checks "is this burned?" by comparing against it.

## Each peer chooses its own mint

`walletType` is the generic `cashu` (not `cashu-<mint>`), so **every
Lightning-connected Cashu peer interoperates regardless of its chosen mint**:

- **Burns self-verify per token.** A burn token carries its own mint URL, so a
  verifier loads _that_ mint — no cross-peer coordination, no canonical mint.
- **Tips bridge mints** via multimint swap (below).

The join-support gate still separates a Cashu wave from a Tron wave (a peer only
joins a wave whose `walletType` its wallet matches), but never mint-A from mint-B.

The desktop wallet modal offers a **curated mint picker** (the account dropdown,
reused); switching sends `set-wallet-options {mint}` (a live re-wire) and main
persists the choice to `<storage>/cashu.mint`. The curated list (`CASHU_MINTS` in
`renderer/lib/wallet.js`):

- **testnut** (`testnut.cashu.space`) + **testnut · no fees**
  (`nofee.testnut.cashu.space`) — the free TEST mints (auto-pay, no real
  Lightning). The default; play money.
- **⚠ Minibits** (`mint.minibits.cash/Bitcoin`) and **⚠ Coinos**
  (`mint.coinos.io`) — real, reputable **mainnet** Lightning mints (verified via
  `/v1/info`: bolt11 mint+melt, NUT-07/11/12). Selecting one means **REAL sats** —
  Top up pays a real invoice, burns/tips move real funds. They're the only way to
  actually settle cross-mint tips (`consolidate`), which fake mints can't do. This
  sits in tension with the project's testnet-only rule, so they're clearly
  labelled and never the default.

## Cashu is stateful — the proof store

Unlike a chain wallet (balance lives on-chain), **a Cashu wallet's balance IS the
ecash proofs it holds locally** — bearer tokens; losing them loses funds
(`hyperwave-wallet-cashu/lib/proof-store.js`). Proofs are kept **per mint** and persisted to
`<storage>/cashu-proofs.json`, which **must live outside** `<storage>/hyperwave`
(that corestore is wiped on startup). Writes are atomic (tmp + rename).

> Open item: the proof store is currently plaintext. The desktop already
> encrypts the seeds with `safeStorage`; wrapping the proof file the same way is a
> follow-up (it holds bearer funds).

## Funding (top up)

A fresh Cashu wallet is empty, so it must be funded before it can burn a fee or
tip. `wallet.fund(sats)` requests a bolt11 **mint quote** and mints on payment:

- On an **auto-paying test mint** (`testnut.cashu.space`, the dev default) the
  quote settles on its own — instant, no real Lightning.
- On a **real LN mint** `fund` returns the bolt11 `invoice`; the desktop surfaces
  it (the "Top up" button → a prompt/QR) to pay from any Lightning wallet.

## Tips — send, deliver, redeem

A tip is ecash **P2PK-locked to the recipient's identity pubkey** (their
`address`), so it's safe to broadcast — only they can redeem it.

1. **Send** (`wallet.send(recipientPubkey, amount)`) produces the locked token.
2. **Deliver** — the token rides the existing `wave-note` tip
   (`{kind:'tip', to, peerId, amount, hash}`, `hash` = the token; ~950 B, within
   `MAX_NOTE_BYTES` 2048). No protocol change.
3. **Redeem** — the recipient sees the note addressed to it and sends
   `redeem {token}`; the engine `receive()`s it (unlocks the P2PK with the
   identity key) into the proof store. A chain tip settles on-chain instead, so
   the engine no-ops `redeem` there.

The mint charges a small swap fee, so a 5-sat tip nets ~4 sat.

### Multimint swap (redeemable across mints)

A tip may arrive on a foreign mint. `wallet.consolidate()` moves foreign-mint
proofs to the home mint over Lightning (**melt** at the source paying a home-mint
invoice, then **mint** at home), so the whole balance is redeemable in one place.
This needs both mints to have real Lightning connectivity — it cannot settle
against a fake test mint (testnut), so it's exercised in code + the no-op path but
not smoke-tested there.

## Trust model (weaker than on-chain — by design)

Cashu is **custodial**: you trust the mint. So the paid-gate shifts from
"publicly on-chain-auditable" to "**mint-attested**." A DLEQ proof (NUT-12) can
confirm the mint _issued_ a token offline, but a mint that lies about its own
`checkstate` could fake a burn. This sits within the protocol's existing
"soft, publicly-detectable" paid-gate trade-off — but it is a real reduction in
guarantee versus the Tron black hole, and worth stating plainly.

## Running it

- **Desktop:** Cashu is the default — `npm start -- --storage <dir>`. Use the
  wallet modal's mint picker + "Top up".
- **Headless engine:** `WALLET=1 WALLET_TYPE=cashu WALLET_FUND=200 bare
bin/wave.run.js A /tmp/hw/a` (from `packages/hyperwave-engine`).
- **Headless two-peer paid-wave e2e:** `npm run test:e2e:cashu` (from the engine
  package; gated behind `E2E_CASHU=1`, hits testnut over the network).
- **De-risking spikes:** `spike/cashu/spike.mjs` (mint → burn → verify) and
  `spike/cashu/multimint.mjs` (tip send → receive), both under Bare.

## Runtime note (Bare)

cashu-ts + `@noble/*` need `fetch` / WebCrypto / `TextEncoder` / `TextDecoder`,
which Bare doesn't ship; `hyperwave-wallet-cashu/lib/bare-web-shims.js` installs them from Bare
ecosystem shims before cashu-ts loads. cashu-ts is ESM, bridged from the CJS
wallet via dynamic `import()` (like WDK). Its `engines.node >=22.4.0` would trip
Bare's resolver (emulated node 20), so `scripts/fix-bare-engines.js` normalizes
it — otherwise the desktop crashes under pear-runtime on import.
