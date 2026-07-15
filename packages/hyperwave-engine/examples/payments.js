// payments.js — the self-custodial WDK wallet (Tron Nile testnet). createPayments is
// async (WDK is ESM-only). Address derivation is offline; balances/send/burn hit the
// network. This example derives + prints the address and attempts a balance read (which
// needs network + a funded wallet to be interesting). Run:  bare examples/payments.js
const fs = require('bare-fs');
const { createPayments } = require('hyperwave-engine');

async function main() {
  const dir = '/tmp/hw-example-wallet-' + Date.now();
  const pay = await createPayments({
    storageDir: dir /*, seed: '<mnemonic>' */
  });

  // Derived offline from the seed persisted at <storage>/wallet.seed.
  console.log('wallet address:', pay.address);

  // balances() is a network call; tolerate offline / rate limits in the example.
  try {
    const bal = await pay.balances();
    console.log(
      'balance:',
      bal.trx,
      'TRX',
      bal.trx === 0 ? '(fund it at the Nile faucet)' : ''
    );
  } catch (err) {
    console.log('balance lookup skipped:', err.message);
  }

  // The money operations (need a funded wallet — shown, not run):
  //   await pay.send('T…recipient', 5);                       // { hash, fee }  real transfer
  //   await pay.burn(1, `hyperwave:${'w1'}:${pay.address}`);  // { hash, fee }  burn + on-chain memo
  //   await pay.verifyBurnTx(hash, { waveId: 'w1', from: pay.address, minTrx: 1 }); // { ok, reason? }
  //   await pay.transactions(10);                             // recent txs, both directions
  //
  // wallet.js also exports the fee flow composing these into a wave (see examples/wave.js for a createWave instance):
  //   const { FEE_TRX, payFee, confirmBurn, wireWallet } = require('hyperwave-engine');
  //   wireWallet(wave, pay);                                  // address (tips) + burn verifier (paid gate)
  //   const { hash, proof } = await payFee({ wave, payments: pay, waveId, reason: 'start' }); // burn FEE_TRX + sign attestation
  //   if (await confirmBurn(pay, waveId, hash)) { wave.announcePaid(proof); }

  pay.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('FAIL', err);
  Bare.exit(1);
});
