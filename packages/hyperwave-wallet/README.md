# hyperwave-wallet

The pluggable **payment interface** for [`hyperwave-engine`](https://www.npmjs.com/package/hyperwave-engine):
a single abstract `Wallet` base class. The engine composes its wallet-agnostic fee flows
(burned participation fees, gallery tips) over **any** conforming implementation, so a host
picks a payment mechanism without the engine knowing about currencies, chains, or mints.

**No dependencies.** Concrete implementations live in their own packages — e.g.
[`hyperwave-wallet-cashu`](https://www.npmjs.com/package/hyperwave-wallet-cashu) (Chaumian
ecash on a Lightning mint) and
[`hyperwave-wallet-tron`](https://www.npmjs.com/package/hyperwave-wallet-tron) (WDK: native
TRX / TRC-20 USDT).

## Install

```sh
npm install hyperwave-wallet
```

## The interface

`Wallet` is abstract — most members throw until a subclass overrides them. Amounts are in
the wallet's own native units. A concrete wallet implements:

| Member                        | Purpose                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `get type`                    | payment-mechanism id (e.g. `'cashu'`, `'tron-nile'`), rides paid waves so a joiner only joins one it can pay |
| `get unit`                    | display unit label (e.g. `'sat'`, `'TRX'`); default `'native'`                |
| `get fee`                     | the participation fee this wallet burns per wave                              |
| `get address`                 | this wallet's receive address (tips + attestation binding)                    |
| `get accountIndex`            | BIP-44 account index (default `0`)                                            |
| `accounts(count)`             | derive the first `count` accounts (offline) for an account picker             |
| `balances()`                  | `{ address, amount, unit }` spendable balance                                 |
| `send(recipient, amount)`     | pay another peer (a tip) → `{ hash, fee? }`                                   |
| `burn(amount, memo)`          | destroy the participation fee (no beneficiary), memo-tagged → `{ hash, fee? }` |
| `verifyBurnTx(burnRef, expect)` | verify a claimed burn → `{ ok, reason?, transient? }` (fails closed)         |
| `transactions(limit)`         | history, newest first                                                         |
| `dispose()`                   | release resources (default no-op)                                             |

```js
const { Wallet } = require('hyperwave-wallet');

class MyWallet extends Wallet {
  get type() {
    return 'my-currency';
  }
  get fee() {
    return 1;
  }
  get address() {
    return this.myAddress;
  }
  async send(recipient, amount) {
    /* ... → { hash } */
  }
  async burn(amount, memo) {
    /* ... → { hash } */
  }
  // ...override balances / verifyBurnTx / transactions
}
```

A host injects a factory returning a `Wallet` subclass into the engine:

```js
const { createEngine } = require('hyperwave-engine');

createEngine({
  storageDir: '/tmp/hyperwave/a',
  config: { topicId: 'my-topic:v1' },
  deps: { createPayments: (opts) => new MyWallet(opts) }
});
```

See the concrete packages above for full implementations.

## Runtime

CommonJS; runs under [Bare](https://github.com/holepunchto/bare) (and Node).

License: Apache-2.0
