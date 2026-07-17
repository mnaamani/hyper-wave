# Cashu integration plan

Add a **Cashu** (Chaumian ecash over Lightning) payment mechanism to the
engine, make it the **desktop default**, let **each peer choose its own mint**,
and support **multimint swap** so tips are redeemable regardless of which mint
they arrived on. Also do a **currency-agnostic rename** of the Tron-flavoured
field/param names in `wallet.js`, `payments.js`, and `attest.js`.

De-risked by `spike/cashu/` (mint → burn → verify under Bare, all green).

## Goals

- `CashuWallet extends Wallet` in `packages/hyperwave-engine/`, injected as the
  desktop's default `createPayments`.
- Burn a participation fee as ecash **cryptographically bound to the seat**
  (`hyperwave:<waveId>:<peerId>` memo, mint-signed) — the black-hole analog is a
  **NUMS pubkey** nobody can spend.
- Per-peer mint choice; a curated list of public **Lightning-connected** testnet
  mints in the desktop UI.
- Tips are **redeemable across mints** via melt→mint (Lightning) multimint swap.
- Rename currency-specific names so the abstraction reads as generic value, not
  TRX.

## Non-goals / invariants (do not violate)

- **No gossip-protocol change** to message _kinds_, the Ed25519 envelope,
  framing, or flooding. Cashu rides existing opaque fields
  (`walletType`, `burn`, `address`, `fee`). The rename (Part 0) touches
  **attestation payload key names only** — a coordinated schema tweak, all peers
  update together (pre-release), documented in `protocol.md §5`.
- **Money model unchanged:** burned fees + tips; NO sponsor rewards.
- **Engine stays theme-agnostic.** The curated mint list lives in the desktop.
- **Testnet only.**

---

## Part 0 — Currency-agnostic rename (mechanical prep, ships first)

Pure rename; **no behavioural change**. The Ed25519 burn signature is over a
`|`-joined string of _values_ (`attest.js burnHash`), so renaming JS field names
does **not** change signature bytes as long as value order is preserved. What
_does_ change is the JSON **key names** of the burn/join attestation objects
carried inside `wave-join` / `wave-start` — a coordinated payload-schema rename
(fine: not yet deployed), leaving message kinds/envelope/framing untouched.

Add a new interface member `get unit()` (`'TRX'` / `'USDT'` / `'sat'`) so the
renderer can label amounts.

| Location                                               | Old                            | New                                             |
| ------------------------------------------------------ | ------------------------------ | ----------------------------------------------- |
| `wallet.js` `balances()` return                        | `{ address, trx }`             | `{ address, amount, unit }`                     |
| `wallet.js`                                            | —                              | add `get unit()` (abstract; default `'native'`) |
| `wallet.js` / `tron-wallet.js` `verifyBurnTx` `expect` | `{ waveId, from, minTrx }`     | `{ waveId, from, minAmount }`                   |
| `wallet.js` `verifyBurnTx` param                       | `txHash`                       | `burnRef`                                       |
| `attest.js` `BurnFields`                               | `txHash`                       | `burnRef`                                       |
| `attest.js` `BurnFields`                               | `tronAddress`                  | `payerAddress`                                  |
| `attest.js` `burnAuthorizes` tip check                 | `burn.tronAddress === address` | `burn.payerAddress === address`                 |
| `payments.js` `confirmBurn`                            | `minTrx: payments.fee`         | `minAmount: payments.fee`                       |
| `payments.js` `payFee` / `recordBurn` call             | `txHash`, `tronAddress`        | `burnRef`, `payerAddress`                       |
| `wave.js` `recordBurn` builder                         | `tronAddress: walletAddress`   | `payerAddress: walletAddress`                   |
| `feed.js` `mergeFeed` tip-address gate                 | `tronAddress`                  | `payerAddress`                                  |

Ripple: update `tron-wallet.js` + `tron-usdt-wallet.js` to return
`{ address, amount, unit }` from `balances()` and read `minAmount` in
`verifyBurnTx`. `BURN_ADDRESS`, `FEE_TRX`, `toSun/fromSun` stay (Tron-internal).

**Tests to update in the same commit:** `attest`, `messages`, `payments` (if
any), `tron-wallet`, `tron-usdt-wallet`, `engine`, `feed-crdt`/`feed.replication`
fixtures that reference `trx`/`tronAddress`. Desktop renderer: the `wallet` IPC
message field (`trx` → `amount` + `unit`) and the 💰 chip formatting
(`renderer/lib/wallet.js`, `app.js`).

Ship Part 0 as its own PR, all suites green, before any Cashu code.

---

## Part 1 — `CashuWallet` (engine)

New: `packages/hyperwave-engine/lib/cashu-wallet.js` (+ `nums.js`, promoted from
the spike). ESM cashu-ts bridged via dynamic `import()` (like WDK). Install the
Bare polyfills (`fetch`/`crypto`/`TextEncoder`/`TextDecoder`) once at wallet
init — promote `spike/cashu/polyfill.mjs` into the wallet module (or a small
`lib/bare-web-shims.js`).

### Cashu is stateful — the key structural difference from Tron

A Tron wallet is stateless (balance lives on-chain). **A Cashu wallet's balance
IS the set of unspent proofs it holds locally** — bearer tokens. Losing them =
losing funds. So:

- **Proof store**: persist proofs to `<storageDir>/cashu-proofs.json` (or a tiny
  keyed store). **Must live OUTSIDE `<storageDir>/hyperwave`** — that corestore
  is wiped on startup; the proof store must survive. Hold proofs **per mint**
  (`Map<mintUrl, Proof[]>`) so a peer can carry ecash from several mints (its
  own + tips received from foreign mints).
- **Identity keypair** (secp256k1) for P2PK receive/tips, derived from the
  injected seed (dedicated derivation path/domain, distinct from the swarm key).
  Its pubkey is the wallet `address`.
- **Home mint**: the peer's chosen mint URL (`walletOptions.mint`), where it
  mints/holds its primary balance and burns fees.

### Interface implementation (`Wallet` subclass)

- `get type()` → `'cashu'` (generic — see Part 5).
- `get unit()` → `'sat'`.
- `get fee()` → participation fee in sats (default e.g. 2; `walletOptions.fee`).
- `get address()` → the P2PK identity pubkey (hex).
- `async balances()` → `{ address, amount, unit: 'sat' }`, `amount` = sum of
  local unspent proofs across all mints (optionally validated via
  `checkProofsStates`).
- `async send(recipientPubkey, amountSats)` → produce a token **P2PK-locked to
  `recipientPubkey`** from the home mint's proofs; return
  `{ hash: <encodedToken>, fee }`. The token blob is the "receipt" (see Part 3
  for delivery). Consumes local proofs, persists the change.
- `async burn(amountSats, memo)` → **spends held proofs** into a proof
  P2PK-locked to the **NUMS burn pubkey** (`nums.js`, deterministic,
  domain `hyperwave:burn:v1`) with `additionalTags: [['hyperwave', memo]]`;
  returns `{ hash: <encodedBurnToken>, fee }`. Requires the wallet to already
  hold ≥ fee (mint-funded). No new minting inside burn.
- `async verifyBurnTx(burnRef, expect)` → Part 2.
- `async transactions(limit)` → local ledger of mints/sends/burns/receives
  (from the proof store's history), newest first, `[]` on error.
- `async accounts(count)` → default single account (Cashu has no BIP-44 address
  ladder); returns `[{ index: 0, address }]`. (Desktop multi-account picker
  becomes a **mint** picker instead — Part 4.)
- `dispose()` → flush the proof store.

### Factory

`createCashuWallet(options)` mirroring `createPayments`: takes
`{ storageDir, seed, log, mint, fee }`, installs shims, derives the identity
key, opens the proof store, returns a `CashuWallet`. Exported from `index.js`.

---

## Part 2 — Burn & verify (per-peer mint, self-contained)

The burn token **carries its own mint URL** (`decoded.mint`), so per-peer mints
need no coordination: an auditor reads the mint from the token itself.

`verifyBurnTx(burnRef, expect)` — `burnRef` = the encoded `cashuB` token:

1. Load the token's mint (network) to get keyset ids; `getDecodedToken`.
2. Structural (offline): `amount ≥ expect.minAmount`; every proof kind `P2PK`,
   `data === numsBurnPubkey()` (else `not-burned`), `hyperwave` tag commits
   `expect.waveId` (else `memo-mismatch`).
3. **Optionally** `verifyDLEQProof` (NUT-12) with the mint's keys — an _offline_
   proof the mint actually issued the proof (strengthens against a token that
   was never mint-signed, without trusting a live call).
4. On-mint (NUT-07) `checkProofsStates` → all `UNSPENT`. UNSPENT under an
   unspendable lock = value parked forever = burned. Else `spent-or-pending`.

Fails closed (`{ ok:false, reason }`) on any throw — same contract as Tron.
Called only on the start-proof gate + by tippers/auditors, **never on the
gossip ingest path** (unchanged: ingest is signature-only via `burnAuthorizes`).

The `attest.js` ring-key signature layer already binds `waveId|peerId|burnRef|
payerAddress` to the ring key with no chain concept, so seat/identity binding is
**doubly covered**: ring-sig (Part 0, unchanged semantics) + the mint-signed
on-token memo.

---

## Part 3 — Tips + multimint swap (the redeemability requirement)

### Delivery — reuse `wave-note`, no protocol change

A Cashu tip is a **bearer token that must reach the recipient** (unlike an
on-chain transfer the recipient just observes). The token is **P2PK-locked to
the recipient's pubkey**, so it is safe to broadcast — only the recipient can
redeem it. Carry it in the existing `wave-note` tip note (opaque, size-capped,
flooded to a wave's subscribers): `{ kind:'tip', to, peerId, amount, token }`.
~600 bytes, well under `MAX_FRAME_BYTES`. **This is the same primitive the
desktop already uses** (`wave-note` §Message Types) — additive payload field,
no engine/gossip change.

### Send (tipper)

`send(recipientPubkey, amount)` mints/swaps a token locked to
`recipientPubkey` from the tipper's home mint and returns the encoded token. The
desktop maps this into the tip note. Sending from the tipper's **own** mint
keeps `send` cheap (no cross-mint hop on the hot path).

### Redeem (recipient) — where multimint swap lives

On receiving a tip note, the recipient's wallet:

1. `receive(token)` — unlock the P2PK proof with its identity **privkey**,
   swapping it into plain proofs it controls **at the token's source mint**
   (stored under that mint in the per-mint proof store). Tip is now spendable,
   possibly at a foreign mint.
2. **Multimint consolidation (on-demand or background)** — move value to the
   home mint so the whole balance is redeemable/cashable in one place:
   `homeWallet.createMintQuoteBolt11(amount)` → `sourceWallet.meltProofsBolt11(
invoice, proofs)` (pay the invoice via the source mint's Lightning) →
   `homeWallet.mintProofsBolt11(amount, quote)`. Nets slightly less (Lightning +
   mint fees) — surface the fee. **Both mints must have Lightning connectivity**
   (why the desktop curates LN-connected mints).

Keep the design tolerant: proofs may sit at their source mint until the user
consolidates or cashes out; `balances()` sums across mints so the tip counts
immediately.

### Cash-out (out of scope for MVP, note it)

Melt any held proofs to an external Lightning invoice — a future desktop button.

---

## Part 4 — Desktop wiring

- **Default factory**: `apps/desktop/workers/hyperwave.js` injects
  `deps.createPayments = (opts) => createCashuWallet(opts)` and passes
  `walletOptions: { mint, fee }` in the `init` config. (Keep Tron reachable
  behind a build/config flag for fallback + the existing tests.)
- **Seeds**: unchanged — `electron/main.js` keeps injecting the encrypted wallet
  seed over the IPC pipe; the Cashu identity key derives from it.
- **Proof store**: `<storage>/cashu-proofs.json` (survives the corestore wipe).
  Non-secret-but-valuable — consider `safeStorage` encryption like the seeds
  (proofs are bearer funds). **Decision needed** (see open questions).
- **Mint picker** (replaces the multi-account picker in the wallet modal,
  `renderer/lib/wallet.js`): a curated dropdown of public **LN-connected**
  testnet mints (e.g. a small vetted list; `testnut` for the no-real-sats demo).
  Selecting one sends a new `set-mint` command → engine live-re-wires the wallet
  (mirror `set-account`) → persists to `<storage>/cashu.mint` (plain, non-secret;
  main reads it into `init`, writes it on change).
- **Top-up / funding UX**: to burn or tip, the wallet needs ecash. Add a
  "Top up" flow: `createMintQuoteBolt11(amount)` → show the **bolt11 invoice**
  (QR + copy) for the user to pay from any Lightning wallet → poll → `mintProofs`.
  For the frictionless demo, a `testnut`-style auto-paying mint needs no external
  payment. `DEMO.md` documents both.
- **Renderer labels**: 💰 chip shows `amount` + `unit` (`sat`); tip toast, burn
  toast unchanged except unit.
- **NSFW / gallery / sweep**: untouched.

---

## Part 5 — `walletType` gating & interop

- Cashu advertises the generic `walletType: 'cashu'`. The existing join-support
  gate (`wave.walletType !== myWalletType`) still separates Cashu waves from Tron
  waves, but **all Cashu peers interoperate regardless of mint** — burns are
  self-verifying per-token (Part 2) and tips bridge via multimint swap (Part 3).
- `fee` is in sats; a peer's `minFee` floor is in sats. A peer refuses a Cashu
  wave whose fee is below its floor (unchanged logic, sats units).

---

## Part 6 — Tests

Engine (brittle, under Bare; add suite to `test.js`):

- `cashu-wallet` (offline): identity derivation determinism; `nums`
  determinism + on-curve; `verifyBurnTx` structural branches driven by
  **fixture tokens** (honest, wrong-wave → `memo-mismatch`, low-amount →
  `amount-too-low`, wrong-lock → `not-burned`) — no network, using pre-captured
  `cashuB` strings.
- Rename regression: extend `attest` (BurnFields `burnRef`/`payerAddress`,
  `burnAuthorizes`), `payments`, `tron-wallet`, `tron-usdt-wallet`, `engine`,
  `feed-crdt` for the new key names.
- `engine` paid-flow: a stub `CashuWallet` (in-memory, deterministic) so the
  start/join burn orchestration is covered without a live mint.

Network (kept in `spike/cashu/` + optionally an opt-in e2e tier, not in the
default `npm test` — needs a live mint):

- The existing `spike.mjs` burn+verify (green).
- New `spike/cashu/multimint.mjs`: fund at mint A, tip locked to a recipient key,
  recipient `receive` at A then melt-A→mint-B, assert home-mint balance rises.

Lint/format: `npm run lint && npm run format`. Verify the desktop end-to-end
with `/verify` (two peers, a paid Cashu wave, a tip that redeems).

---

## Part 7 — Docs to update

- `packages/hyperwave-engine/docs/protocol.md` — payments section: the `cashu`
  walletType, burn semantics (NUMS domain string, memo tag), the renamed
  attestation keys (`burnRef`/`payerAddress`), verify path.
- `packages/hyperwave-engine/docs/usage.md` — injecting `createCashuWallet`.
- `apps/docs/idea.md` — money model in plain language (ecash burn + LN tips).
- `docs/README.md` — index this plan.
- `CLAUDE.md` — payment stack, wallet-type list, the rename, the wipe-vs-proof-
  store caveat.
- `TODO.md` — track the phases below.
- New `apps/docs/cashu.md` (or a protocol §) — mint choice + multimint swap +
  funding UX + trust model.

---

## Risks / open questions

- **Mint trust (custodial).** The paid-gate shifts from on-chain-auditable to
  **mint-attested**; a colluding mint could lie about `checkstate`. DLEQ (Part 2
  step 3) mitigates _issuance_ forgery offline but not a mint that double-spends
  its own burns. Acceptable within the existing "soft, publicly-detectable"
  gate, but **document the weaker guarantee**.
- **Proof-store safety.** Bearer funds on disk. Encrypt with `safeStorage` like
  the seeds? Handle crash-consistency (write-ahead / atomic replace) so a crash
  mid-swap can't lose proofs. **Decision needed.**
- **Cross-mint fees & failure.** Melt→mint can fail or underpay (routing). The
  redeem path must be retryable and must not lose proofs on partial failure.
- **Funding friction.** Real LN-connected mints need a real Lightning payment to
  top up; the demo leans on an auto-paying test mint. Confirm at least one vetted
  public testnet mint stays up, or self-host one.
- **Curated mint list** — which public LN testnet mints to ship, and vetting.

---

## Sequencing (PRs)

1. ✅ **Part 0 rename** — mechanical, all suites green. Ships alone. _(done)_
2. ✅ **Part 1+2 `CashuWallet` + burn/verify** — engine, unit tests, promoted
   spike modules (`nums.js`, `bare-web-shims.js`, `proof-store.js`,
   `cashu-burn.js`, `cashu-wallet.js`). Tron stays default. Network-smoked
   fund→burn→verify against testnut. _(done)_
   - Added `fund(amountSats)` to the wallet (mint quote → mint into the store),
     beyond the plan: a Cashu wallet must be able to receive to burn/tip, and it
     enables the end-to-end smoke. Real (non-auto-pay) mints return the bolt11
     `invoice` for external payment (the desktop QR flow is Part 4).
   - `fix-bare-engines` extended: also normalizes a `node` engines range that
     Bare's emulated node (20.0.0) fails to satisfy (cashu-ts needs `>=22.4.0`) —
     otherwise the desktop crashes under pear-runtime on cashu-ts import.
3. ✅ **Part 3 tips + multimint** (wallet level) — `send` (P2PK-lock to
   recipient), `receive` (P2PK-unlock a tip into the store, with an offline
   not-locked-to-us guard), `consolidate` (melt-at-source → mint-at-home). Pure
   `p2pkLockPubkey` guard unit-tested; `spike/cashu/multimint.mjs` smokes the
   tip send→receive roundtrip + guard over the network. _(done)_
   - **Cross-mint consolidation can't be smoked on fake mints** (testnut has no
     real Lightning to route between mints) — the code path is built and the
     no-op path verified; true settlement needs two LN-connected mints.
   - Tip **delivery** (carrying the token in a `wave-note`) is Part 4 (desktop).
4. ✅ **Part 4 desktop** — Cashu is the desktop default (worker injects
   `createCashuWallet`). Engine gained generic `set-wallet-options` / `fund-wallet`
   / `redeem` commands + `mint` in the wallet msg. Renderer: `wallet-meta.js`
   shared unit/mint/type; unit labels everywhere; the account `<select>` reused
   as a **mint picker**; the faucet button reused as **Top up** (fund-wallet);
   **tip redeem** (a Cashu tip token rides the tip wave-note's `hash`, the
   recipient `redeem`s it); chain-only UI hidden for Cashu. main.js persists the
   chosen mint (`cashu.mint`). _(done — GUI end-to-end still to verify on a
   display: two live desktop peers, a paid Cashu wave, a tip that redeems.)_
5. ✅ **Part 6/7** — a **headless two-peer paid-wave e2e** on Cashu
   (`npm run test:e2e:cashu`, gated `E2E_CASHU=1`) passes over a local DHT +
   testnut: fund → paid gate → paid join → feed converges to 2 (~37s). Docs done:
   protocol.md §2.3/§9 (rename + mechanism note), `apps/docs/cashu.md`, CLAUDE.md,
   idea.md, docs/README.md. _(done — the only remaining item is the **GUI**
   end-to-end on a display: two live desktop peers, a paid Cashu wave, a redeeming
   tip; can't run headless here.)_
