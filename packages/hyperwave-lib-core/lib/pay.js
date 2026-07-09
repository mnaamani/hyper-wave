// Payment domain (WDK layer). A self-custodial Tron wallet per instance — used for the
// burned participation fees and gallery tips (no sponsor rewards). WDK is ESM-only, so this
// CJS module bridges to it via dynamic import(); it does real Tron Nile-testnet transfers
// (the spike/wdk de-risk confirmed this runs under Bare). No swarm here — the worker
// (hyperwave.js) / wave.js wire it in, mirroring ring/token/gallery as its own module.
//
// MVP uses **native TRX** as the payment currency (not TRC-20 USDT): no token contract, and
// a TRX transfer pays its own (tiny) fee from the same balance — so a wallet that received
// TRX can immediately send it, no separate gas token to fund.
const fs = require('bare-fs');
const b4a = require('b4a');

const NILE_PROVIDER = 'https://nile.trongrid.io';
const SUN = 1_000_000; // 1 TRX = 1e6 sun
// Tron's black hole (base58check of the all-zero EVM address, 41 + 20×00): no key exists,
// so TRX sent here is provably unspendable — the canonical burn. Used for the initiator's
// kick-off fee. (Zero-amount transfers are rejected by TransferContract, so a burn is a
// real small transfer; Tron also burns tx fees at the protocol level.)
const BURN_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

const toSun = (trx) => BigInt(Math.round(Number(trx) * SUN));
const fromSun = (raw) => Number(raw) / SUN;

async function createPayments({
  storageDir,
  seed: injectedSeed,
  provider = NILE_PROVIDER,
  log = () => {}
} = {}) {
  const { default: WDK } = await import('@tetherto/wdk');
  const { default: WalletManagerTron } = await import('@tetherto/wdk-wallet-tron');

  // Seed precedence: injected -> file -> generate+persist. A mobile host injects the seed from
  // secure storage (Keychain/Keystore) and never touches the filesystem; desktop persists it in
  // a file alongside (but outside) the per-run hyperwave store that wave.js wipes, so the wallet
  // is self-custodial and survives restarts.
  try {
    fs.mkdirSync(storageDir, { recursive: true });
  } catch {}
  const seedFile = storageDir + '/wallet.seed';
  let seed = injectedSeed && injectedSeed.trim();
  if (!seed) {
    try {
      seed = fs.readFileSync(seedFile, 'utf8').trim();
    } catch {}
  }
  if (!seed) {
    seed = WDK.getRandomSeedPhrase();
    fs.writeFileSync(seedFile, seed);
  }

  const wallet = new WalletManagerTron(seed, { provider });
  const account = await wallet.getAccount(0);
  const address = await account.getAddress(); // offline (derived from the seed)
  // Reuse WDK's own TronWeb (Bare-compatible; a standalone `require('tronweb')` pulls in
  // ethers/http which Bare lacks) to build the memo'd burn tx, which WDK then signs+sends.
  const tronweb = account._tronWeb || wallet._tronWeb;
  log('wallet ready', address);

  return {
    address,
    // { address, trx } in whole TRX. Network call to the provider.
    async balances() {
      const raw = await account.getBalance();
      return { address, trx: fromSun(raw) };
    },
    // Send `amountTrx` (whole TRX) to a Tron address; resolves { hash, fee }.
    async send(recipient, amountTrx) {
      const res = await account.sendTransaction({ to: recipient, value: toSun(amountTrx) });
      log('sent', amountTrx, 'TRX ->', recipient, 'hash', res.hash);
      return { hash: res.hash, fee: res.fee };
    },
    // Burn `amountTrx` (send to the black hole — unspendable by anyone), tagging the tx
    // with an on-chain `memo` so the burn is provably tied to its purpose/wave (readable by
    // anyone via gettransactionbyid). Builds the tx with the memo, then lets WDK sign+send.
    async burn(amountTrx, memo) {
      let tx = await tronweb.transactionBuilder.sendTrx(
        BURN_ADDRESS,
        Number(toSun(amountTrx)),
        address
      );
      if (memo) tx = await tronweb.transactionBuilder.addUpdateData(tx, memo, 'utf8');
      const res = await account.sendTransaction(tx); // prebuilt (has txID) -> WDK signs + broadcasts
      log('burned', amountTrx, 'TRX 🔥 hash', res.hash, memo ? `memo=${memo}` : '');
      return { hash: res.hash, fee: res.fee };
    },
    // Verify (on-chain) that `txHash` is a burn matching expectations — the anti-spam gate a
    // peer runs before joining a wave: the kick-off fee must really be paid. Checks (via
    // `getTransaction`, which reflects a broadcast tx within seconds — `getTransactionInfo`'s
    // block confirmation lags badly on Nile): TransferContract to the black hole, from
    // `expect.from`, amount ≥ `expect.minTrx`, and the memo commits `expect.waveId`. The tx
    // is signed + spends real TRX, so its existence is a sufficient stake for anti-spam.
    // Returns { ok, reason }. Missing tx / RPC error → { ok: false } (fail closed).
    async verifyBurnTx(txHash, expect = {}) {
      try {
        const tx = await tronweb.trx.getTransaction(txHash);
        const c = tx?.raw_data?.contract?.[0];
        if (c?.type !== 'TransferContract') {
          return { ok: false, reason: 'not-found-or-not-transfer' };
        }
        const v = c.parameter.value;
        const burnHex = tronweb.address.toHex(BURN_ADDRESS).toLowerCase();
        if ((v.to_address || '').toLowerCase() !== burnHex) {
          return { ok: false, reason: 'not-burned' };
        }
        if (expect.from) {
          const fromHex = tronweb.address.toHex(expect.from).toLowerCase();
          if ((v.owner_address || '').toLowerCase() !== fromHex) {
            return { ok: false, reason: 'wrong-sender' };
          }
        }
        if (expect.minTrx !== undefined && BigInt(v.amount || 0) < toSun(expect.minTrx)) {
          return { ok: false, reason: 'amount-too-low' };
        }
        // Memo is `hyperwave:<waveId>:<peerId>` — check it commits the waveId.
        const memo = tx.raw_data.data ? b4a.from(tx.raw_data.data, 'hex').toString() : '';
        if (expect.waveId && !memo.includes(expect.waveId)) {
          return { ok: false, reason: 'memo-mismatch' };
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: e.message };
      }
    },
    // Recent native-TRX transfers for this wallet, newest first — reads TronGrid's v1
    // account-transactions API through WDK's (Bare-compatible) TronWeb HTTP client, so it
    // surfaces funds/tips RECEIVED as well as the sends/burns we made (which the app already
    // logs from its own events). Native TransferContract only (no TRC-20). Normalized to
    // { hash, direction: 'in'|'out', amount (TRX), from, to, timestamp (ms), memo }. Returns []
    // on any error — the UI falls back to the session log + the "full history" Tronscan link.
    // Capped at the 10 most recent (the UI only shows 10).
    async transactions(limit = 10) {
      try {
        const res = await tronweb.fullNode.request(
          `v1/accounts/${address}/transactions?limit=${limit}&only_confirmed=true&order_by=block_timestamp,desc`,
          {},
          'get'
        );
        const myHex = tronweb.address.toHex(address).toLowerCase();
        const out = [];
        for (const tx of (res && res.data) || []) {
          const c = tx.raw_data && tx.raw_data.contract && tx.raw_data.contract[0];
          if (!c || c.type !== 'TransferContract') continue; // native TRX transfers only
          const v = (c.parameter && c.parameter.value) || {};
          const memo = tx.raw_data.data ? b4a.from(tx.raw_data.data, 'hex').toString() : '';
          out.push({
            hash: tx.txID,
            direction: (v.owner_address || '').toLowerCase() === myHex ? 'out' : 'in',
            amount: fromSun(v.amount || 0),
            from: v.owner_address ? tronweb.address.fromHex(v.owner_address) : '',
            to: v.to_address ? tronweb.address.fromHex(v.to_address) : '',
            timestamp: tx.block_timestamp || 0,
            memo
          });
        }
        return out;
      } catch (e) {
        log('transactions fetch failed:', e.message);
        return [];
      }
    },
    dispose() {
      try {
        if (wallet.dispose) wallet.dispose();
      } catch {}
    }
  };
}

module.exports = { createPayments, toSun, fromSun };
