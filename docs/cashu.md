# Cashu payments (the desktop default)

HyperWave's payment layer is pluggable (the abstract `Wallet` interface,
`packages/hyperwave-wallet/lib/wallet.js`). The **desktop default** is **Cashu** —
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
Lightning-connected Cashu peer on the same network interoperates regardless of its
chosen mint** (the one exception — test vs mainnet — is enforced separately, from
mint identity, see below):

- **Burns self-verify per token.** A burn token carries its own mint URL, so a
  verifier loads _that_ mint — no cross-peer coordination, no canonical mint.
- **Tips bridge mints** via multimint swap (below).

The join-support gate still separates a Cashu wave from a Tron wave (a peer only
joins a wave whose `walletType` its wallet matches), but never mint-A from mint-B
**on the same network**.

### The one split the mint-agnostic type must NOT paper over: test vs main

`sat` on the free `testnut` mint is fake money; `sat` on a real Lightning mint is
real money — and a Cashu proof looks identical either way, so the network is
knowable only from _which mint_ it is. Keeping `walletType` generic must not let
those mix. So the split is enforced from the **mint identity carried by the burn
proof**, not from the wire type:

- Every paid wave's start burn (`paid.burnRef`) is a Cashu token that encodes its
  own mint URL. A receiving peer's paid-gate verifier (`CashuWallet.verifyBurnTx`)
  reads that mint (`getTokenMetadata().mint`) and classifies its network against
  the canonical list (`mint-networks.js` — `networkOfMint` / `crossNetworkMints`).
- If the burn's mint is on a **different known network** than the peer's own mint
  (test vs main), `verifyBurnTx` returns a **definitive** `wrong-network`
  rejection (not transient) — so `verifyStartProof` abandons the wave (it's never
  joinable/spectated on this peer). This is the filter: a testnet peer drops
  mainnet-settled announces/syncs, and vice versa. The check is offline (before
  any mint call), so a foreign-network wave costs nothing to reject.
- **Same network, different mint → still joinable.** The filter fires ONLY on a
  known test-vs-main mismatch. Two peers on _different_ mints that share a network
  (e.g. `testnut.cashu.space` and `nofee.testnut.cashu.space`, or `mint.minibits`
  and `mint.coinos.io`) are not cross-network: `crossNetworkMints` returns false,
  `verifyBurnTx` proceeds to load the burn's own mint and run the normal
  structural + NUT-07 checks, and the wave verifies. Nothing gates join on mint
  _equality_ — the join-support gate is `walletType` (generic `cashu` for every
  mint), so any two same-network mints fully interoperate. (Pinned by the
  `two mainnet mints → same network` / `two test mints → same network` cases in
  `mint-networks.test.js`.)
- **Unknown mints are permissive.** A mint not in the list (and not self-labelled
  `testnut`/`testnet`) classifies as `unknown` and is never the basis for a
  cross-network rejection — we exclude only networks we can positively identify,
  so a custom mint is never wrongly filtered.

### The display + tip filter (the renderer only shows same-network waves)

The paid-gate `wrong-network` rejection covers _joining_, but a peer can also
**spectate** a wave (subscribe without joining) and **tip** its gallery — and a
tip is a wave-independent wallet send, so nothing above stops a cross-network tip
(meaningless: a testnet token to a mainnet recipient, or vice versa). It also
doesn't cover a **live mint switch** — a wave verified under the old network stays
engaged after switching. So the renderer filters by network directly:

- Each wave is **tagged with its settlement network** by the engine, derived from
  its start burn via the wallet's sync `networkOf(burnRef)` (offline — decode the
  token's mint, classify it). It rides the `wave-announce` / `wave-active` /
  `wave-verified` engine events as `network` (null on unpaid/wallet-less waves).
- The wallet's **own** network rides the `wallet` message (`network`, from its
  active mint, alongside `mint`/`mints`).
- The renderer (`wallet-meta.js` `networkMatches`) hides any wave whose known
  network differs from the wallet's known network — so the directory shows only
  same-network waves, and the gallery/tip button never appear for a cross-network
  wave. My own waves and unknown-network waves always pass (permissive, mirroring
  `crossNetworkMints`).
- On a **live mint switch** the `wallet` message reports the new network; the
  renderer re-filters the directory and **deselects the active wave if it's become
  cross-network**, so its gallery + tip disappear immediately.

`mint-networks.js` is the **single source of truth** — it holds both the curated
mint list (`KNOWN_MINTS`, `{ url, label, network }`) and the `networkOfMint` /
`crossNetworkMints` classifier. The worker uses it natively (the paid-gate
filter). The sandboxed `file://` renderer can't `require` a CJS package, so
instead of duplicating the list there, **the worker relays it**: the Cashu wallet
exposes `get knownMints()` (the curated list + app extras), the engine surfaces it
on the `wallet` message as `mints`, and the renderer's picker renders that. So the
picker's label and the filter's classification come from one list — the SAME one
the wallet classifies against — and cannot drift.

An **app can add its own mints** in ONE place: `APP_EXTRA_MINTS` in
`workers/hyperwave.js` (`{ url, label, network }`), passed to the wallet as
`walletOptions.knownMints`. That single list feeds both the cross-network filter
(the wallet classifies burns against it) and the picker (the wallet reports it,
the engine relays it) — no second definition in the renderer.

The desktop wallet modal offers a **curated mint picker** (the account dropdown,
reused); switching sends `set-wallet-options {mint}` (a live re-wire) and main
persists the choice to `<storage>/cashu.mint`. The picker renders the
worker-relayed list (`KNOWN_MINTS` in `mint-networks.js`, above — not a separate
renderer list):

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
`address`), so even if seen it can't be stolen — but it's delivered **privately**
so the token and the tip relationship don't leak (see the privacy note below).

1. **Send** (`wallet.send(recipientPubkey, amount)`) produces the locked token.
2. **Deliver privately** — the token is unicast to the recipient over a
   **`wave-dm`** directed note (`{kind:'tip', token, amount}`), sent over a direct
   channel or via a `joinPeer` dial — it never touches the flood. Separately, a
   **stripped** `wave-note` (`{kind:'tip', amount}`, no token, no recipient) is
   flooded for the gallery's "a moment was tipped" social proof.
3. **Redeem** — the recipient's `dm` handler sends `redeem {token}`; the engine
   `receive()`s it (unlocks the P2PK with the identity key) into the proof store.
   A chain (Tron) tip is public on-chain anyway, so it keeps the full flooded
   `wave-note` and settles on-chain (the engine no-ops `redeem` there).

**Privacy note.** Cashu blinds who-paid-whom at the mint; flooding the bearer
token + `{to, amount}` over `wave-note` would re-open that at the network layer
(a public tip social-graph). The `wave-dm` directed delivery keeps the token and
the relationship off the mesh — only the two peers (and the blind mint) know.
Trade-off: unicast needs the recipient online + dialable (a flood reaches a
still-online non-neighbour more forgivingly). Delivery to an **offline** recipient
fails in either model (the token stays locked); a proper fix is a P2PK
refund-locktime so the tipper can reclaim an undelivered tip — a follow-up.

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
