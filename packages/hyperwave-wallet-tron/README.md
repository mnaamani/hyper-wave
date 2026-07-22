# hyperwave-wallet-tron

**Tron** implementations of the
[`hyperwave-wallet`](https://www.npmjs.com/package/hyperwave-wallet) interface, built on
Tether's **[WDK](https://github.com/tetherto/wdk)** — a self-custodial, seed-derived wallet
for [`hyperwave-engine`](https://www.npmjs.com/package/hyperwave-engine). Two variants:

- **`TronWallet`** — the default: **native TRX** (no token contract). A TRX transfer pays its
  own tiny fee from the same balance, so a wallet that received TRX can immediately send.
  Multi-account (BIP-44). Type `tron-<network>` (e.g. `tron-nile`), fee `1 TRX`.
- **`TronUsdtWallet`** — TRC-20 **USDT** (opt-in alternative). Needs TRX for gas on top of the
  USDT balance. Type `tron-usdt-<network>`, fee `1 USDT`.

Participation fees are **burned** to Tron's black hole
(`T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb`, the unspendable all-zero EVM address) — nobody
profits. Tips are plain transfers.

WDK is ESM-only, so this CommonJS package bridges to it via dynamic `import()`.

## Install

```sh
npm install hyperwave-wallet-tron
```

## Use

A host injects the factory into the engine:

```js
const { createEngine } = require('hyperwave-engine');
const { createPayments } = require('hyperwave-wallet-tron'); // native TRX

const engine = createEngine({
  storageDir: '/tmp/hyperwave/a',
  config: { topicId: 'my-topic:v1' },
  deps: { createPayments }
});
```

For USDT, inject `createTronUsdtWallet` instead.

Wallets are **seed-derived**; a host supplies the seed via wallet options. To send, the wallet
must be **faucet-funded** — [nileex](https://nileex.io/join/getJoinPage) gives testnet TRX.

## Exports

- `TronWallet`, `createPayments`, `initTronAccount`, `toSun`, `fromSun`, `FEE_TRX`,
  `tronWalletType`, `BURN_ADDRESS`.
- `TronUsdtWallet`, `createTronUsdtWallet`, `tronUsdtWalletType`, `FEE_USDT`.

## Runtime

CommonJS; runs under [Bare](https://github.com/holepunchto/bare) (WDK's real target here) and
Node.

## Testnet only

Uses Tron **Nile** testnet with plain transfers — no smart contracts, no real value.

License: Apache-2.0
