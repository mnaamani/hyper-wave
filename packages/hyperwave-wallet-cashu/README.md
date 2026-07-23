# hyperwave-wallet-cashu

A **Chaumian ecash (Cashu)** implementation of the
[`hyperwave-wallet`](https://www.npmjs.com/package/hyperwave-wallet) interface — self-custodial
bitcoin on a **Lightning-connected mint**, unit `sat`. This is the **desktop default** wallet
for [`hyperwave-engine`](https://www.npmjs.com/package/hyperwave-engine).

- **Participation fees** are burned as ecash P2PK-locked to a NUMS ("nothing-up-my-sleeve")
  pubkey — the unspendable black-hole analog — tagged with the seat memo (NUT-11). Verifiable
  as spent via NUT-07 (`verifyBurnTx`).
- **Tips** are bearer tokens the recipient redeems (`send` → `receive`).
- Any Lightning Cashu peer **interoperates regardless of mint** (`type` is the generic
  `'cashu'`).

Cashu is **stateful** — proofs are bearer funds held locally (`ProofStore`), so this wallet
persists proofs outside the engine's ephemeral store.

## Install

```sh
npm install hyperwave-wallet-cashu
```

## Use

A host injects the factory into the engine:

```js
const { createEngine } = require('hyperwave-engine');
const { createCashuWallet } = require('hyperwave-wallet-cashu');

const engine = createEngine({
  storageDir: '/tmp/hyperwave/a',
  config: { topicId: 'my-topic:v1', walletOptions: { mint: DEFAULT_MINT } },
  deps: { createPayments: createCashuWallet }
});
```

The dev default mint is the free auto-paying **testnut** mint
(`https://testnut.cashu.space`) — no real funds; call `wallet.fund(sats)` and it's paid
automatically. A real mint returns a bolt11 invoice to pay.

## Exports

- `createCashuWallet(options)` / `CashuWallet` — the `Wallet` implementation.
  Beyond the base interface it adds `fund(amountSats, { onInvoice })`,
  `receive(token)` (redeem a tip), and `consolidate({ sourceMint })` (sweep proofs into one
  mint).
- `CASHU_WALLET_TYPE` (`'cashu'`), `CASHU_UNIT` (`'sat'`), `DEFAULT_MINT`.
- `verifyBurnProofs`, `burnTags`, `p2pkLockPubkey`, `MEMO_TAG_KEY` (`cashu-burn` —
  pure structural burn verification).
- `numsBurnPubkey`, `NUMS_DOMAIN` (`nums` — the deterministic on-curve burn pubkey).
- `ProofStore`, `MAX_HISTORY` (per-mint ecash proof store).
- `installBareWebShims` (fetch/WebCrypto shims so cashu-ts runs under Bare).

See [`docs/cashu.md`](https://github.com/mnaamani/hyper-wave/blob/main/docs/cashu.md) in the
repo for the full money model.

## Runtime

CommonJS; runs under [Bare](https://github.com/holepunchto/bare) (the shims bridge cashu-ts's
web APIs) and Node.

## Testnet only

Ecash on a testnet Lightning mint; no real value. Do not point it at a production mint with
real funds.

License: Apache-2.0
