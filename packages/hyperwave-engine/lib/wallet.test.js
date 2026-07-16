// The Wallet interface (wallet.js): the abstract base class the engine depends on. A concrete
// wallet (e.g. TronWallet, tron-wallet.js) or any app-supplied implementation extends it.
// Runs under Bare:  bare lib/wallet.test.js   (or `npm test`)
const test = require('brittle');
const { Wallet } = require('./wallet');

test('Wallet is an abstract interface — unimplemented members throw', (t) => {
  const bare = new Wallet();
  t.exception(() => bare.type, 'type must be implemented');
  t.exception(() => bare.fee, 'fee must be implemented');
  t.exception(() => bare.address, 'address must be implemented');
  t.execution(() => bare.dispose(), 'dispose is a no-op by default');
});

test('a custom Wallet subclass is accepted by duck-type (implements the interface)', (t) => {
  class MyWallet extends Wallet {
    get type() {
      return 'my-chain';
    }
    get fee() {
      return 5;
    }
    get address() {
      return 'my-addr';
    }
  }
  const custom = new MyWallet();
  t.ok(custom instanceof Wallet, 'extends the base class');
  t.is(custom.type, 'my-chain');
  t.is(custom.fee, 5);
  t.is(custom.address, 'my-addr');
});
