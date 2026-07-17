// A `Wallet` implementation over Cashu (Chaumian ecash on a Lightning-connected
// mint). The participation fee is burned as ecash P2PK-locked to the canonical
// NUMS pubkey (nums.js) — irrecoverable, the black-hole analog — tagged with the
// seat memo `hyperwave:<waveId>:<peerId>` (mint-signed via BDHKE), so a burn is
// cryptographically bound to its wave. cashu-ts is ESM, so this CJS module
// bridges via dynamic import() (like tron-wallet.js over WDK) and installs the
// Bare web shims first (bare-web-shims.js). De-risked in spike/cashu/.
//
// Cashu is STATEFUL: unlike a Tron wallet, the balance IS the local proof set
// (proof-store.js), held per mint. The wallet mints/holds/burns at its HOME mint;
// tips can arrive on foreign mints (multimint swap to consolidate is PR-2). The
// mint is loaded lazily (first network op) so construction stays offline.
const fs = require('bare-fs');
const b4a = require('b4a');
const { Wallet } = require('hyperwave-engine');
const { installBareWebShims } = require('./bare-web-shims');
const { numsBurnPubkey } = require('./nums');
const { ProofStore } = require('./proof-store');
const { verifyBurnProofs, burnTags, p2pkLockPubkey } = require('./cashu-burn');

// The on-the-wire payment-mechanism id. Generic (NOT per-mint): every
// Lightning-connected Cashu peer interoperates regardless of its chosen mint —
// burns self-verify per token (each token carries its mint) and tips bridge
// mints via multimint swap. So the join-support gate only separates Cashu waves
// from Tron waves, never Cashu-mint-A from Cashu-mint-B. (plan Part 5)
const CASHU_WALLET_TYPE = 'cashu';
const CASHU_UNIT = 'sat';
const DEFAULT_FEE_SATS = 2;
// A free test mint (auto-pays mint quotes — no real Lightning) so a headless /
// dev run works with no funding. A real host passes `mint` (a curated,
// LN-connected mint). testnut ecash has no real value.
const DEFAULT_MINT = 'https://testnut.cashu.space';
// Domain-separated identity derivation: the wallet's secp256k1 P2PK key (its
// receive/tip address) is derived deterministically from the injected seed, so
// it's stable across restarts and distinct from the ring/swarm key.
const IDENTITY_DOMAIN = 'hyperwave:cashu:identity:v1';

/**
 * A self-custodial Cashu (ecash) wallet. Constructed by `createCashuWallet`
 * (which does the async cashu-ts import + identity derivation); do not `new` it.
 */
class CashuWallet extends Wallet {
  #cashu;
  #secp;
  #mintUrl;
  #identityPriv;
  #identityPub;
  #fee;
  #store;
  #log;
  #mint;
  #wallet;
  #loaded;

  /**
   * @param {Object} opts
   * @param {Object} opts.cashu - The imported cashu-ts module.
   * @param {Object} opts.secp - The imported noble secp256k1 module.
   * @param {string} opts.mintUrl - The home mint URL.
   * @param {string} opts.identityPriv - The identity private key (hex).
   * @param {string} opts.identityPub - The identity public key (hex) = address.
   * @param {number} opts.fee - The participation fee in sats.
   * @param {ProofStore} opts.store - The persistent proof store.
   * @param {(...args: any[]) => void} [opts.log] - Logger.
   */
  constructor({
    cashu,
    secp,
    mintUrl,
    identityPriv,
    identityPub,
    fee,
    store,
    log = () => {}
  }) {
    super();
    this.#cashu = cashu;
    this.#secp = secp;
    this.#mintUrl = mintUrl;
    this.#identityPriv = identityPriv;
    this.#identityPub = identityPub;
    this.#fee = fee;
    this.#store = store;
    this.#log = log;
    this.#mint = new cashu.Mint(mintUrl);
    this.#wallet = new cashu.Wallet(this.#mint, CASHU_UNIT);
    this.#loaded = false;
  }

  get type() {
    return CASHU_WALLET_TYPE;
  }

  get unit() {
    return CASHU_UNIT;
  }

  get fee() {
    return this.#fee;
  }

  get address() {
    return this.#identityPub;
  }

  /** The home mint URL (Cashu has no BIP-44 accounts — the "account" is the mint). */
  get mintUrl() {
    return this.#mintUrl;
  }

  // Load the home mint's keysets/keys once, lazily, so construction is offline.
  async #ensureLoaded() {
    if (!this.#loaded) {
      await this.#wallet.loadMint();
      this.#loaded = true;
    }
  }

  // Fund the wallet by minting `amountSats` at the home mint: request a bolt11
  // mint quote, wait for it to be paid, then mint the proofs into the store.
  // Resolves `{ amount, minted, invoice }` once minted (or when the poll times
  // out, minted:0). The bolt11 `invoice` is available the moment the quote is
  // created — long BEFORE payment — so `opts.onInvoice(invoice)` is called
  // immediately, letting a host show a QR right away while this keeps polling +
  // mints in the background. (A headless caller just `await`s and ignores
  // onInvoice — the blocking contract is unchanged.)
  async fund(amountSats, { onInvoice } = {}) {
    await this.#ensureLoaded();
    const quote = await this.#wallet.createMintQuoteBolt11(amountSats);
    if (onInvoice) {
      onInvoice(quote.request); // the invoice exists now — surface it before waiting
    }
    const paid = await this.#awaitQuotePaid(quote.quote);
    if (!paid) {
      return { amount: amountSats, minted: 0, invoice: quote.request };
    }
    const proofs = await this.#wallet.mintProofsBolt11(amountSats, quote.quote);
    this.#store.add(this.#mintUrl, proofs);
    this.#store.addHistory({
      kind: 'mint',
      amount: amountSats,
      to: this.#identityPub,
      memo: '',
      token: '',
      timestamp: null
    });
    this.#log('funded', amountSats, 'sat at', this.#mintUrl);
    return {
      amount: amountSats,
      minted: proofs.length,
      invoice: quote.request
    };
  }

  // Poll a mint quote until PAID/ISSUED (bounded). Auto-paying test mints settle
  // within a second; a real invoice settles when the payer scans + pays it — so
  // the window is generous (a paid quote resolves early, it doesn't wait it out).
  async #awaitQuotePaid(quoteId) {
    const states = this.#cashu.MintQuoteState;
    for (let attempt = 0; attempt < 90; attempt++) {
      const quote = await this.#wallet.checkMintQuoteBolt11(quoteId);
      if (quote.state === states.PAID || quote.state === states.ISSUED) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return false;
  }

  // A transient wallet bound to `mintUrl` (may differ from home) for verifying a
  // foreign burn token. Kept minimal — just enough to decode + checkstate.
  async #foreignWallet(mintUrl) {
    if (mintUrl === this.#mintUrl) {
      await this.#ensureLoaded();
      return this.#wallet;
    }
    const mint = new this.#cashu.Mint(mintUrl);
    const wallet = new this.#cashu.Wallet(mint, CASHU_UNIT);
    await wallet.loadMint();
    return wallet;
  }

  // The headline balance = ecash held at the ACTIVE mint (no network; the store IS
  // the balance). Burns/tips draw from the active mint, so this is what's spendable
  // right now — and it changes when the mint switches. Proofs held at OTHER mints
  // (e.g. a tip received on a foreign mint) aren't counted here until consolidate()
  // moves them home.
  async balances() {
    return {
      address: this.#identityPub,
      amount: this.#store.totalFor(this.#mintUrl),
      unit: CASHU_UNIT
    };
  }

  // Send `amountSats` to `recipientPubkey`: swap home proofs into a token
  // P2PK-locked to the recipient (only they can redeem). Returns { hash } where
  // `hash` is the encoded token (the bearer receipt the host delivers, e.g. in a
  // wave-note tip). The change stays in the store. Safe to broadcast — the P2PK
  // lock means only the recipient can redeem it.
  async send(recipientPubkey, amountSats) {
    const token = await this.#lockedSend({
      amount: amountSats,
      pubkey: recipientPubkey,
      tags: [],
      kind: 'send'
    });
    return { hash: token };
  }

  // Redeem a token that was P2PK-locked to THIS wallet's identity (a received
  // tip): swap it into proofs we control, held under the token's source mint (it
  // may be a foreign mint — consolidate() moves it home). Signs the P2PK lock
  // with our identity key. Returns { amount, mint }. Rejects a token not locked
  // to us (a clean error rather than a failed swap).
  async receive(token) {
    const mintUrl = this.#cashu.getTokenMetadata(token).mint;
    const wallet = await this.#foreignWallet(mintUrl);
    const keysetIds = (await wallet.mint.getKeySets()).keysets.map(
      (keyset) => keyset.id
    );
    const decoded = this.#cashu.getDecodedToken(token, keysetIds);
    for (const proof of decoded.proofs) {
      const lock = p2pkLockPubkey(proof.secret, this.#cashu);
      if (lock && lock !== this.#identityPub) {
        return { amount: 0, mint: mintUrl, error: 'not-locked-to-us' };
      }
    }
    const received = await wallet.receive(token, {
      privkey: this.#identityPriv
    });
    this.#store.add(mintUrl, received);
    const amount = Number(this.#cashu.sumProofs(received));
    this.#store.addHistory({
      kind: 'receive',
      amount,
      to: this.#identityPub,
      memo: '',
      token: '',
      timestamp: null
    });
    this.#log('received', amount, 'sat from', mintUrl);
    return { amount, mint: mintUrl };
  }

  // Multimint swap: move proofs held at a FOREIGN mint to the home mint over
  // Lightning (melt at the source paying a home-mint invoice, then mint at home),
  // so the whole balance is redeemable/cashable in one place. Requires BOTH mints
  // to have real Lightning connectivity (the source can pay the home invoice) —
  // it will NOT settle against fake test mints. Nets slightly less (LN routing +
  // mint fees). Returns { moved, fee } (moved = sats credited at home).
  async consolidate({ sourceMint } = {}) {
    await this.#ensureLoaded();
    const sources = sourceMint
      ? [sourceMint]
      : this.#store.mints().filter((mint) => mint !== this.#mintUrl);
    let moved = 0;
    let fee = 0;
    for (const source of sources) {
      const result = await this.#swapMintToHome(source);
      moved += result.moved;
      fee += result.fee;
    }
    return { moved, fee };
  }

  // Melt the proofs held at `sourceMint` and re-mint them at the home mint. The
  // home mint issues an invoice for the net amount; the source mint pays it.
  async #swapMintToHome(sourceMint) {
    if (sourceMint === this.#mintUrl) {
      return { moved: 0, fee: 0 }; // already home — nothing to swap
    }
    const sourceProofs = this.#store.get(sourceMint);
    const available = Number(this.#cashu.sumProofs(sourceProofs));
    if (available === 0) {
      return { moved: 0, fee: 0 };
    }
    const source = await this.#foreignWallet(sourceMint);
    // Mint at home for the net amount; a melt quote tells us the LN fee reserve,
    // so pick the largest amount whose (amount + fee_reserve) fits `available`.
    let mintAmount = available;
    let mintQuote = await this.#wallet.createMintQuoteBolt11(mintAmount);
    let meltQuote = await source.createMeltQuoteBolt11(mintQuote.request);
    if (meltQuote.amount + meltQuote.fee_reserve > available) {
      mintAmount = available - meltQuote.fee_reserve;
      if (mintAmount <= 0) {
        return { moved: 0, fee: 0 };
      }
      mintQuote = await this.#wallet.createMintQuoteBolt11(mintAmount);
      meltQuote = await source.createMeltQuoteBolt11(mintQuote.request);
    }
    const melt = await source.meltProofsBolt11(meltQuote, sourceProofs);
    this.#store.set(sourceMint, melt.change || []);
    const minted = await this.#wallet.mintProofsBolt11(
      mintAmount,
      mintQuote.quote
    );
    this.#store.add(this.#mintUrl, minted);
    const moved = Number(this.#cashu.sumProofs(minted));
    this.#store.addHistory({
      kind: 'consolidate',
      amount: moved,
      to: this.#mintUrl,
      memo: sourceMint,
      token: '',
      timestamp: null
    });
    this.#log('consolidated', moved, 'sat', sourceMint, '->', this.#mintUrl);
    return { moved, fee: meltQuote.fee_reserve };
  }

  // Burn `amountSats`: swap home proofs into a token P2PK-locked to the NUMS burn
  // key (nobody can spend it) tagged with `memo`. Returns { hash } = the encoded
  // burn token (rides burn.burnRef on the wire; an auditor verifies it).
  async burn(amountSats, memo) {
    const nums = await numsBurnPubkey();
    const token = await this.#lockedSend({
      amount: amountSats,
      pubkey: nums.pubkey,
      tags: memo ? burnTags(memo) : [],
      kind: 'burn',
      memo
    });
    this.#log('burned', amountSats, 'sat 🔥', memo ? `memo=${memo}` : '');
    return { hash: token };
  }

  // Shared swap-and-lock: take `amount` from home proofs, produce proofs locked
  // to `pubkey` (+ optional NUT-11 tags), persist the change, encode the locked
  // proofs as a token. Throws if the wallet holds too little (unfunded).
  async #lockedSend({ amount, pubkey, tags, kind, memo }) {
    await this.#ensureLoaded();
    const homeProofs = this.#store.get(this.#mintUrl);
    const result = await this.#wallet.ops
      .send(amount, homeProofs)
      .asP2PK({ pubkey, additionalTags: tags })
      .run();
    this.#store.set(this.#mintUrl, result.keep);
    const token = this.#cashu.getEncodedToken({
      mint: this.#mintUrl,
      proofs: result.send,
      unit: CASHU_UNIT
    });
    this.#store.addHistory({
      kind,
      amount,
      to: kind === 'burn' ? 'burn' : pubkey,
      memo: memo || '',
      token,
      timestamp: null // stamped by the host (Date.now unavailable in some hosts)
    });
    return token;
  }

  // Verify `burnRef` (an encoded cashu token) is a real burn matching `expect`.
  // Structural (P2PK-to-NUMS + memo commits waveId + amount) then NUT-07
  // checkstate (still UNSPENT under an unspendable lock = burned). The token
  // carries its own mint, so a per-peer mint needs no coordination. `expect.from`
  // is ignored — ecash is anonymous (see cashu-burn.js). Fails closed.
  async verifyBurnTx(burnRef, expect = {}) {
    try {
      const nums = await numsBurnPubkey();
      // The token carries its own mint (metadata read needs no keysets); load
      // that mint so a per-peer / foreign mint verifies with no coordination.
      const mintUrl = this.#cashu.getTokenMetadata(burnRef).mint;
      const wallet = await this.#foreignWallet(mintUrl);
      const keysetIds = (await wallet.mint.getKeySets()).keysets.map(
        (keyset) => keyset.id
      );
      const token = this.#cashu.getDecodedToken(burnRef, keysetIds);
      const structural = verifyBurnProofs({
        proofs: token.proofs,
        numsPubkey: nums.pubkey,
        expect,
        cashu: this.#cashu
      });
      if (!structural.ok) {
        return structural;
      }
      const states = await wallet.checkProofsStates(token.proofs);
      const allUnspent = states.every(
        (state) => state.state === this.#cashu.CheckStateEnum.UNSPENT
      );
      if (!allUnspent) {
        return { ok: false, reason: 'spent-or-pending' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  // Local ledger (the store's history) — newest first. No network.
  async transactions(limit = 10) {
    return this.#store.history(limit);
  }

  // Cashu has no BIP-44 address ladder; the single "account" is this identity.
  async accounts(_count = 1) {
    return [{ index: 0, address: this.#identityPub }];
  }

  dispose() {
    // The store persists on every mutation; nothing buffered to flush.
  }
}

/**
 * Derive the wallet's identity secp256k1 keypair deterministically from `seed`.
 * @param {Object} secp - The noble secp256k1 module.
 * @param {Function} sha256 - The noble sha256 hash.
 * @param {string} seed - The seed material (mnemonic or hex).
 * @returns {{identityPriv: string, identityPub: string}} The keypair (hex).
 */
function deriveIdentity(secp, sha256, seed) {
  let material = sha256(b4a.from(String(seed) + '|' + IDENTITY_DOMAIN));
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const pub = secp.secp256k1.getPublicKey(material, true); // compressed
      return {
        identityPriv: b4a.toString(b4a.from(material), 'hex'),
        identityPub: b4a.toString(b4a.from(pub), 'hex')
      };
    } catch {
      material = sha256(material); // scalar out of range — rehash (vanishingly rare)
    }
  }
  throw new Error('could not derive a valid Cashu identity key from the seed');
}

/**
 * Create a self-custodial Cashu wallet. An app injects this via createEngine
 * `deps.createPayments` to make Cashu its payment mechanism. Offline-constructible
 * (the mint loads lazily on the first network op).
 * @param {Object} [options] - Options.
 * @param {string} options.storageDir - Directory for the proof store + seed file.
 * @param {string} [options.seed] - Injected seed (mnemonic/hex); else read/generate a file.
 * @param {string} [options.mint] - The home mint URL (LN-connected). Defaults to a test mint.
 * @param {number} [options.fee] - Participation fee in sats (default DEFAULT_FEE_SATS).
 * @param {(...args: any[]) => void} [options.log] - Logger.
 * @returns {Promise<CashuWallet>} The ready wallet.
 */
async function createCashuWallet(options = {}) {
  const {
    storageDir,
    seed: injectedSeed,
    mint = DEFAULT_MINT,
    fee = DEFAULT_FEE_SATS,
    log = () => {}
  } = options;
  installBareWebShims();
  const cashu = await import('@cashu/cashu-ts');
  const secp = await import('@noble/curves/secp256k1.js');
  const { sha256 } = await import('@noble/hashes/sha2.js');

  try {
    fs.mkdirSync(storageDir, { recursive: true });
  } catch {}
  // Seed precedence: injected -> file -> generate+persist. Kept alongside (but
  // OUTSIDE) the wiped hyperwave store, like the Tron wallet's seed.
  const seedFile = storageDir + '/cashu.seed';
  let seed = injectedSeed && injectedSeed.trim();
  if (!seed) {
    try {
      seed = fs.readFileSync(seedFile, 'utf8').trim();
    } catch {}
  }
  if (!seed) {
    seed = b4a.toString(require('hypercore-crypto').randomBytes(32), 'hex');
    fs.writeFileSync(seedFile, seed);
  }

  const { identityPriv, identityPub } = deriveIdentity(secp, sha256, seed);
  const store = new ProofStore({
    file: storageDir + '/cashu-proofs.json',
    fs,
    log
  });
  log('cashu wallet ready', identityPub.slice(0, 12), 'mint', mint);
  return new CashuWallet({
    cashu,
    secp,
    mintUrl: mint,
    identityPriv,
    identityPub,
    fee,
    store,
    log
  });
}

module.exports = {
  CashuWallet,
  createCashuWallet,
  CASHU_WALLET_TYPE,
  CASHU_UNIT,
  DEFAULT_MINT
};
