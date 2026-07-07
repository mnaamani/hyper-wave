---

# HyperWave - Design Document
**Global Digital Wave via P2P Baton Pass with Autobase Celebration & Tipping**

**Submission:** Tether Developers Cup (DoraHacks)  
**Theme:** Football & Global Tournament Moment  
**Stack:** Pear (Hyperswarm), WDK, Autobase, Hyperblobs

---

## 1. Executive Summary

HyperWave transforms the stadium “Mexican wave” into a permissionless, global, peer-to-peer relay. Participants join a match-specific Hyperswarm topic, are assigned a fixed position on the 256-bit DHT ring derived from their public key, and form a live directed graph.

A **cryptographic wave token races** around the ring at network speed (hopping peer-to-peer every ~50–100ms). When it passes a participant, that peer has a **proof window** to react—physically acknowledging the wave—before cryptographically signing their link in the chain and passing the baton to their successor.

After the race, the wave leaves a **permanent artifact**: an Autobase multi-writer timeline of selfies and captions from every validated participant. Anyone can browse the gallery and send **direct WDK micro-tips** to the faces they love.

The economics are interlocked: a participant’s sponsor reward is only unlocked when cryptographic proof shows their successor successfully continued the wave. This creates a cascade of selfish incentives to keep the relay alive.

---

## 2. Core Mechanics

### 2.1 The Ring
The DHT keyspace is the stadium. Your seat is automatic:

```
ringPosition = uint256(noisePublicKey)
angle        = ringPosition / 2^256 * 360°
```

No registration. No maps. No seat selection. Your cryptographic identity is your coordinate.

### 2.2 Swarm & Gossip
Each match spawns a deterministic topic:

```
topic = Blake2b("wavechain:match:<fixture-id>:<timestamp>")
```

Peers join via `hyperswarm.join(topic, { server: true, client: true })`. Through gossip, every peer builds a **sorted view of the ring** and knows their immediate **successor** (next live peer clockwise).

| Gossip Message | Purpose |
|---------------|---------|
| `presence` | Heartbeat + ring angle + wallet address |
| `ring-update` | Exchange slices of the sorted peer list |
| `dead-peer` | Propagate liveness failures for healing |
| `wave-proof` | Broadcast signed proof after token passes |

### 2.3 The Token Race (Fast Layer)
The wave token is a hot potato. It does **not stop** for humans.

**Per-hop flow:**
1. Receive token from predecessor
2. Verify chain signature so far
3. Append your **receipt signature** (L1 proof)
4. Forward to successor within ~50–100ms

If the successor does not ACK within 500ms, the sender consults their gossip-built ring map, marks the peer dead, and **skips ahead** to the next live peer.

**Timing math:**
- 200 participants: ~15–25 seconds per lap
- 500 participants: ~35–50 seconds per lap
- 2,000 participants: ~2–3 minutes per lap

The token accumulates a chain of cryptographic receipts as it races. This chain is the **backbone of payment interlocking**.

### 2.4 The Proof Window (Human Layer)
After the token passes you, your app enters a **proof window** (60–90 seconds):

1. App triggers: *"The wave passed you! Claim your link in the chain."*
2. User performs a lightweight physical action (e.g., wave phone, tap screen)
3. App captures a **selfie** (optional, for the gallery) and signs a `wave-proof` message
4. Proof is gossiped to the swarm and pushed directly to the Sponsor Validator

**Minimum proof delay:** The proof timestamp must be ≥ 1 second after the token receipt timestamp. This prevents instant bot relay without human-scale delay.

### 2.5 Interlocked Sponsor Rewards
The sponsor locks a bounty (e.g., 500 USDT) before the wave starts.

**The golden rule:**
> Peer N is only paid when cryptographic proof shows Peer N+1 successfully received and continued the wave.

**Unlock flow:**
- The Sponsor Validator walks the token chain.
- For each valid link (receipt at N → receipt at N+1), it queues a WDK micro-reward.
- If the wave breaks, the validator pays the **longest valid prefix** of the chain. Peers before the break are paid; the breakpoint peer is not.

**Why this works:**
- A wants B to succeed, because A’s payout depends on B’s proof.
- B wants C to succeed, because B’s payout depends on C’s proof.
- Everyone wants rich, accurate gossip to find responsive successors.

---

## 3. The Celebration Layer: Autobase Gallery

### 3.1 Authenticated Multi-Writer Log
After the race, participants who have a valid token receipt may write to the wave’s **Autobase**:

```json
{
  "type": "wave-selfie",
  "waveId": "uuid",
  "peerId": "B",
  "hopIndex": 42,
  "tokenReceiptSig": "<L1-signature-from-race-token>",
  "imageHash": "<blake2b-of-image>",
  "caption": "Vamos Brazil! 🇧🇷",
  "walletAddress": "<WDK-address>",
  "sig": "<ed25519>"
}
```

**Anti-spam gate:** The Autobase indexer validates that `tokenReceiptSig` appears in the official wave token chain. No receipt = no write.

The output view is a **deterministic, ordered timeline** of the wave: Alice at hop 0, Bob at hop 1, Carlos at hop 2… a global chain of strangers who moved together.

### 3.2 Peer-to-Peer Tipping
Anyone—participants or spectators—can browse the gallery and tip any face:

```
Viewer taps "❤️ Tip 0.10 USDT"
  → WDK wallet signs transfer
  → Direct wallet-to-wallet USDT transfer (Tron/Solana/ETH via WDK)
  → TxHash displayed in gallery
```

**Tip types:**
- **Reciprocal:** Tip the peer before/after you in the chain
- **Appreciation:** Tip a standout selfie (funny face, painted flag, great caption)
- **Patronage:** Sponsor or whale drops larger tips on memorable hops

**Why people tip:**
- The hop index makes relationships explicit: "We were linked in the wave."
- The selfie is content; the tip is applause.
- The bond + token receipt requirement raises the floor above spam, making the gallery feel authentic.

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        User Layer                            │
│  React Native / Pear Runtime                                 │
│  · Ring visualization (global pulse racing around ring)   │
│  · Race notification: "The wave is approaching!"              │
│  · Proof window UI: camera + caption + sign                   │
│  · Gallery browser + one-click WDK tipping                  │
│  · WDK wallet (self-custodial, multi-chain)                 │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                     Wave Engine                              │
│  · Successor resolver (sorted ring map from gossip)         │
│  · Token receiver / forwarder (fast race layer)             │
│  · Healing: skip dead peers via gossiped liveness state      │
│  · Proof assembler (L1 receipt + L2 dwell + optional selfie)  │
│  · Direct push to Sponsor Validator                         │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                    P2P Networking                              │
│  Hyperswarm (Holepunch)                                      │
│  · DHT topic discovery & NAT hole-punching                │
│  · Noise-encrypted duplex streams                           │
│  · Direct successor forwarding (token race)                 │
│  · Gossip broadcast (presence, ring-update, wave-proof)     │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                   Autobase Layer                             │
│  · Multi-writer input cores (one per peer)                  │
│  · Deterministic output view indexed by hop                 │
│  · Hyperblob storage for selfie images                      │
│  · Read access: public gallery for all swarm members        │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                   WDK Payment Layer                            │
│  · Self-custodial wallet generation                         │
│  · Bond lock on join (USDT multi-chain escrow)               │
│  · Sponsor bounty wallet / validator agent wallet            │
│  · Batch micro-payouts per validated hop (interlocked)      │
│  · Direct P2P tipping from gallery viewers to selfie peers │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. Message Protocol

All messages are JSON, signed with Ed25519, transmitted over Noise-encrypted Hyperswarm streams.

### `presence` (Gossip, every 10s)
```json
{
  "type": "presence",
  "peerId": "<noise-public-key>",
  "walletAddress": "<WDK-address>",
  "ringAngle": 145.2,
  "timestamp": 1719705600000,
  "sig": "<ed25519>"
}
```

### `ring-update` (Gossip)
```json
{
  "type": "ring-update",
  "peerId": "<my-peer-id>",
  "knownPeers": [
    { "peerId": "...", "angle": 33.7, "lastSeen": 1719705598000 },
    { "peerId": "...", "angle": 178.4, "lastSeen": 1719705601000 }
  ],
  "sig": "<ed25519>"
}
```

### `wave-token` (Direct, Race Layer)
```json
{
  "type": "wave-token",
  "waveId": "uuid",
  "originator": "<sponsor-validator-pubkey>",
  "lap": 1,
  "hops": [
    { "peerId": "A", "receiptSig": "...", "timestamp": 1719705612000 },
    { "peerId": "B", "receiptSig": "...", "timestamp": 1719705612080 }
  ],
  "currentIndex": 42,
  "skipped": [],
  "sig": "<ed25519-signed-by-sender>"
}
```

### `wave-proof` (Gossip + Direct to Validator)
```json
{
  "type": "wave-proof",
  "waveId": "uuid",
  "peerId": "B",
  "hopIndex": 1,
  "tokenReceiptSig": "<L1>",
  "proofDelayMs": 2300,
  "timestamp": 1719705615000,
  "sig": "<ed25519>"
}
```

### `wave-selfie` (Autobase Write)
```json
{
  "type": "wave-selfie",
  "waveId": "uuid",
  "peerId": "B",
  "hopIndex": 42,
  "tokenReceiptSig": "<L1-signature-from-race-token>",
  "imageHash": "<blake2b>",
  "caption": "Vamos Brazil! 🇧🇷",
  "walletAddress": "<WDK-address>",
  "sig": "<ed25519>"
}
```

### `dead-peer` (Gossip)
```json
{
  "type": "dead-peer",
  "waveId": "uuid",
  "peerId": "<dead-peer-id>",
  "reportedBy": "<my-peer-id>",
  "timeoutAt": 1719705618000,
  "sig": "<ed25519>"
}
```

---

## 6. Security & Attack Surface

| Attack | Defense | Residual Risk |
|--------|---------|---------------|
| **Drop token (griefing)** | Attacker voids own reward (unpaid without successor proof). | Irrational actors only. |
| **Premature skip** | Skipped peer submits grievance with recent heartbeat. Validator voids skipper’s hop. | Requires live gossip. |
| **Sybil ring flooding** | 1 USDT join bond per peer. Expected reward per hop < bond opportunity cost. | Without bond, system collapses. Bond is mandatory. |
| **Token fork** | Forking does not increase attacker payout. Validator pays one chain only. | Negligible. |
| **Gossip withholding** | A gains nothing by hiding successors; if wave breaks, A is unpaid. Incentive is to gossip *more*. | Low. |
| **Replay old token** | Unique `waveId` + originator nonce per wave. Receipt sig binds to specific payload. | Impossible. |
| **Fake selfie / spam** | Autobase write requires valid `tokenReceiptSig` from race chain. | Bond + race participation required. |
| **Gallery tip fraud** | `walletAddress` bound to original `presence` gossip. Validator enforces match. | Low. |
| **Validator eclipse** | Direct peer-to-validator push + redundant gossip ensures proof visibility. | Low. |

---

## 7. WDK Integration

| Feature | WDK Capability | Usage in HyperWave |
|---------|---------------|-------------------|
| **Wallet Creation** | TypeScript SDK, self-custodial | Each peer generates wallet on first app launch |
| **Bond Lock** | Multi-chain USDT transfer to escrow | 1 USDT locked on join; refunded or slashed by validator |
| **Sponsor Bounty** | WDK wallet / EVM escrow | Locked before `wave-start`; disclosed tx hash in token |
| **Interlocked Payout** | USDT batch transfer (Tron/Solana/ETH) | Per-hop reward sent only when successor proof is valid |
| **P2P Tipping** | Direct wallet-to-wallet USDT | Gallery viewers tip selfie posters instantly |
| **AI Validator** | `wdk-mcp` (MCP Server) | Optional: Sponsor Validator as autonomous agent holding wallet, signing payouts via MCP |

---

## 8. Hackathon MVP Scope

**In Scope (48–72h demo):**
- [ ] Hyperswarm topic join and peer discovery
- [ ] Ring visualization (peer dots on a circle, sorted by angle)
- [ ] Gossip protocol: `presence`, `ring-update`, `dead-peer`
- [ ] **Token race**: direct successor forwarding with receipt chain
- [ ] **Healing / skip**: timeout → next live peer from gossip map
- [ ] Proof window UI: countdown + physical action trigger
- [ ] `wave-proof` generation and direct push to validator
- [ ] WDK wallet creation and testnet USDT bond/payout
- [ ] Sponsor Validator node that walks chain and triggers batch payouts
- [ ] **Autobase gallery**: multi-writer selfie timeline (even if simplified to token-carried chain for demo)
- [ ] **One-click tipping** from gallery to peer wallet
- [ ] Demo with 3–5 devices (or emulators) racing a wave, posting selfies, and tipping

**Stretch Goals:**
- [ ] `wdk-mcp` AI Sponsor Validator
- [ ] x402 machine-to-machine payment for initiator-to-validator flow
- [ ] Lightning Network micro-tips for sub-cent appreciation
- [ ] Multi-match tournament leaderboard
- [ ] Geo metadata overlay on ring visualization

**Out of Scope (Post-Hackathon):**
- Full Chord successor routing at 50k+ scale
- Hardware attestation (TEE/Android Keystore)
- Decentralized validator set (single sponsor node is trusted for demo)
- Production-grade anti-sybil identity layer

---

## 9. Judging Criteria Alignment

| Criterion | How HyperWave Delivers |
|-----------|------------------------|
| **Technical Ambition** | Solves consensus-free coordination in an unreliable P2P mesh. Interlocked payment graph. Autobase multi-writer indexing. Gossip as game mechanic. |
| **User Experience** | Instantly familiar metaphor (stadium wave). Fast token race creates visual excitement. Gallery + tipping is a natural social loop. |
| **Real-World Utility** | Sponsors fund engagement and wallet onboarding. Fans earn and tip. The gallery is a permanent, shareable artifact of global coordination. |
| **Creativity** | DHT ring as game board. Proof interlocking. Token race + proof window separation. A human chain of selfies with native money. |
| **Real Use of Tether Platform** | WDK for bonds, interlocked payouts, and P2P gallery tips. Pears/Hyperswarm for all networking. Autobase for the social graph. Full-stack authenticity. |

---

## 10. The Pitch

> *"We built a global stadium wave on a DHT ring. A cryptographic token races peer-to-peer through thousands of fans in seconds. When it hits you, you pass it on—and your payment is locked until your successor proves they continued the chain. Afterward, the wave leaves a permanent timeline of every face that carried it. Scroll through the gallery of strangers who moved together, and tip the moments you love. Sponsors fund the wave. Fans fuel it. WDK powers the money at every hop."*

---

With some refinement:

I've researched the actual capabilities of WDK, Pear/Hyperswarm, and Autobase to ground my analysis. Here's my assessment and refinement of HyperWave.

---

# HyperWave: Analysis & Refinement

## Overall Verdict

This is a **strong, creative hackathon concept** with genuine thematic resonance (stadium wave → football tournament), an elegant core mechanic (DHT ring as game board), and a novel incentive structure (interlocked payments). The stack usage is authentic — you're actually using Hyperswarm for discovery, Autobase for multi-writer state, Hyperblobs for media, and WDK for payments in non-trivial ways.

However, there are several **technical issues** that will bite you during implementation, **scoping problems** that threaten the 48–72h timeline, and **design gaps** that need closing. Let me walk through each.

---

## 1. Critical Technical Issues

### 1.1 The Growing Token Problem (Must Fix)

Your `wave-token` message carries the **entire hops array** as it races:

```json
"hops": [
  { "peerId": "A", "receiptSig": "...", "timestamp": ... },
  { "peerId": "B", "receiptSig": "...", "timestamp": ... },
  // ... grows by 1 every hop
]
```

At 200 participants, this is ~200 entries × ~120 bytes ≈ **24 KB** per message by lap's end. At 2,000 participants, it's **~240 KB** — forwarded every 50–100ms. JSON serialization + Noise stream write + parse on the receiving end at that payload size will blow your timing budget and likely cause ACK timeouts, triggering cascading false "dead peer" detection.

**Refinement — Compact Chain Accumulator:**

Replace the full hops array with a rolling cryptographic accumulator:

```json
{
  "type": "wave-token",
  "waveId": "uuid",
  "originator": "<sponsor-validator-pubkey>",
  "lap": 1,
  "hopCount": 42,
  "prevChainHash": "<blake2b of all prior receipts up to hop 41>",
  "prevReceiptSig": "<last peer's receipt signature>",
  "thisReceiptSig": "<your receipt signature over (waveId, hopCount, prevChainHash, timestamp)>",
  "skipped": [],
  "sig": "<ed25519-signed-by-sender>"
}
```

Each peer computes `newChainHash = blake2b(prevChainHash + thisReceiptSig)`. The full receipt chain is reconstructed separately — each peer gossips their individual receipt to the validator, who assembles the complete chain. This keeps the hot-path message **constant-size (~400 bytes)** regardless of participant count.

### 1.2 Binary Encoding for the Hot Path

JSON parsing at 50–100ms/hop is wasteful. Pear/Hyperswarm's ecosystem uses **Compact Encoding** (Holepunch's binary serializer). For the `wave-token` message specifically, switch to Compact Encoding or even raw fixed-width binary. JSON is fine for gossip messages (every 10s) and Autobase writes (post-race), but the race layer should be lean.

**Refinement:**
```
Race layer (wave-token):  Compact Encoding (binary, ~200 bytes)
Gossip layer:             JSON (human-readable, low frequency)
Autobase writes:          JSON (structured, indexed)
```

### 1.3 Successor Resolution at Scale

Your gossip-based ring map assumes peers can maintain a **fully sorted view** of all participants. This works at 3–5 devices (your MVP) and is manageable at 200 peers. At 2,000 peers, exchanging full ring slices via `ring-update` messages becomes bandwidth-heavy and convergence is slow.

**For the MVP:** A full sorted list is fine. Each `ring-update` contains all known peers. With 5 devices, this is trivial.

**For the design doc (post-MVP):** Acknowledge that you'd move to **Chord-style finger tables** — each peer only needs O(log N) routing entries to find their successor, not the full ring. You already list this in "Out of Scope," which is correct. Just make sure the doc is explicit that the MVP uses **full-ring gossip** and the design scales to **O(log N) routing** later.

### 1.4 Autobase Write Timing

Your doc says participants write to Autobase **"after the race."** But Autobase requires peers to be **online and replicating** for their writes to propagate. If participants close the app after the wave ends (natural behavior — the exciting part is over), their selfie entries never reach the network.

**Refinement — Write During Proof Window:**

Move the Autobase write into the proof window flow (Section 2.4), not after the race:

```
Proof Window (60–90s):
  1. Physical action trigger
  2. Capture selfie → store in local Hyperblob
  3. Sign wave-proof → gossip to swarm + push to validator
  4. IMMEDIATELY write wave-selfie to Autobase (while still connected)
  5. Caption + wallet address included
```

This ensures writes happen while peers are still in the swarm. Additionally, the **Sponsor Validator** should also replicate the Autobase (as a persistent seed) so that even if all peers disconnect, the gallery survives.

### 1.5 Hyperblobs Integration is Underspecified

The architecture mentions Hyperblobs for selfie storage, but the protocol section doesn't connect the dots. Clarify:

```
Selfie Storage Flow:
  1. Peer captures selfie → stores as blob in local Hyperblobs instance
  2. Autobase wave-selfie entry includes: blobCoreKey + blobIndex
  3. Gallery viewer requests blob via Hyperswarm (blobCoreKey)
  4. Original peer (or validator as seed) serves the blob
```

Add `blobCoreKey` and `blobIndex` to the `wave-selfie` message schema. The validator should also replicate Hyperblobs to ensure availability after peers leave.

---

## 2. Design Gaps

### 2.1 Wave Lifecycle is Undefined

The doc never specifies:

| Question | Suggested Answer |
|----------|-----------------|
| **Who starts the wave?** | The Sponsor Validator originates the first `wave-token` with `lap: 1, hopCount: 0`. Announced via a `wave-start` gossip message containing the bounty tx hash. |
| **How many laps?** | For MVP: **1 lap**. Token completes one full circuit of the ring and returns to the validator. For production: configurable, with decreasing rewards per lap. |
| **When does it end?** | Token returns to originator (validator) OR token breaks (no live successor found within timeout). Validator closes the wave and processes payouts. |
| **What if the ring is too small?** | Minimum 3 peers required to start. Validator waits for `presence` count ≥ 3 before originating token. |

Add a `wave-start` and `wave-end` message type:

```json
{
  "type": "wave-start",
  "waveId": "uuid",
  "originator": "<validator-pubkey>",
  "bountyTxHash": "<on-chain-tx>",
  "bountyAmount": "500 USDT",
  "startTime": 1719705600000,
  "minPeers": 3,
  "maxLaps": 1,
  "sig": "<ed25519>"
}
```

```json
{
  "type": "wave-end",
  "waveId": "uuid",
  "originator": "<validator-pubkey>",
  "finalHopCount": 187,
  "breakPeer": null,
  "payoutTxHash": "<on-chain-batch-tx>",
  "sig": "<ed25519>"
}
```

### 2.2 The 1-Second Anti-Bot Delay is Not Security

> *"Minimum proof delay: The proof timestamp must be ≥ 1 second after the token receipt timestamp. This prevents instant bot relay without human-scale delay."*

This is trivially bypassable — a bot simply `await sleep(1001)` before signing. Don't present this as a security measure. For the hackathon, frame it honestly:

> *"The proof window introduces a human-paced rhythm to the wave. While not a cryptographic anti-bot measure, it creates the experiential cadence of a real stadium wave — each participant has a moment to react, celebrate, and be visible to the swarm."*

If you want real anti-bot for post-hackathon, consider: TEE attestation, proof-of-work bound to the receipt, or a challenge-response that requires sensor data (accelerometer gesture).

### 2.3 Bond Mechanism Needs Clarification

The doc says "1 USDT locked on join; refunded or slashed by validator." But WDK doesn't have a native escrow primitive — it's a wallet SDK, not a smart contract platform. You need to specify the mechanism:

**For MVP (testnet, trusted validator):**
```
1. Peer generates WDK wallet
2. Peer transfers 1 testnet USDT to validator's address (simple transfer)
3. Validator records bond in an internal ledger keyed by peerId + walletAddress
4. On wave completion: validator returns bond via WDK transfer (minus any slash)
5. This is custodial/trusted — acceptable for hackathon demo
```

**For production (decentralized):**
```
Bond locked in a smart contract on Tron (cheapest gas for USDT)
Contract releases bond on validator-signed proof
Contract slashes on validator-signed grievance
```

Be explicit about which model the MVP uses. The trusted-validator model is fine for a demo — just document it clearly.

### 2.4 Spectator Mode is Missing

Not everyone at a hackathon demo will want to lock 1 USDT and participate in the wave. But they should still be able to **watch the ring visualization** and **tip participants in the gallery**. Add:

```
Peer Modes:
  - PARTICIPANT: Joins ring, locks bond, races, proves, writes selfie
  - SPECTATOR: Joins topic as client-only, views ring + gallery, can tip
```

Spectators join the Hyperswarm topic with `{ server: false, client: true }`, don't appear in the ring map, don't receive tokens, but can read the Autobase gallery and send WDK tips. This dramatically increases the demo's audience reach.

---

## 3. MVP Scoping — You're Over-Scoped

Your current MVP has **11 in-scope items** for 48–72 hours. That's optimistic. Here's a triaged version that delivers a **complete vertical slice** for the demo:

### Tier 1 — Must Have (Demo Dies Without These)
1. ✅ Hyperswarm topic join + peer discovery (3–5 devices)
2. ✅ Ring visualization (peer dots on circle, sorted by angle)
3. ✅ `presence` + `ring-update` gossip (full-ring, no Chord)
4. ✅ Token race: direct successor forwarding with **compact chain hash** (not full hops array)
5. ✅ Proof window UI: countdown + tap-to-claim + selfie capture
6. ✅ Sponsor Validator: walks chain, triggers testnet USDT payouts
7. ✅ Autobase gallery: multi-writer selfie timeline (write during proof window)
8. ✅ One-click tipping from gallery

### Tier 2 — Should Have (Strengthens Demo Significantly)
9. 🟡 `dead-peer` gossip + skip-ahead healing
10. 🟡 WDK bond lock (testnet, trusted validator)
11. 🟡 `wave-start` / `wave-end` lifecycle messages

### Tier 3 — Nice to Have (If Time Permits)
12. 🔵 Ring visualization with live token position (animated pulse)
13. 🔵 Spectator mode
14. 🔵 Multi-lap support

**Cut from MVP entirely:**
- Full healing/skip logic — for 3–5 devices, if a peer drops, just restart the wave. Implement a simple "token timeout → validator re-originates" fallback.
- `wdk-mcp` AI validator — this is a stretch goal, don't touch it until Tier 1 is done.
- x402, Lightning, geo overlay — all post-hackathon.

### Recommended Build Order (48h)

```
Hour 0–8:   Hyperswarm join + presence gossip + ring visualization
Hour 8–16:  Token race (compact chain hash, direct forwarding, 3 devices)
Hour 16–24: Proof window UI + Autobase gallery write + selfie capture
Hour 24–32: WDK wallet creation + testnet USDT tip transfer (gallery)
Hour 32–40: Sponsor Validator (chain walk + batch payout on testnet)
Hour 40–44: Bond lock (simple transfer) + wave-start/end lifecycle
Hour 44–48: Demo rehearsal + bug fixes + recorded demo video
```

---

## 4. Protocol Refinements

### 4.1 Refined `wave-token` (Compact)

```json
{
  "type": "wave-token",
  "waveId": "uuid",
  "originator": "<validator-pubkey>",
  "lap": 1,
  "hopCount": 42,
  "prevChainHash": "<blake2b accumulator>",
  "senderPeerId": "A",
  "senderReceiptSig": "<A's sig over (waveId, hopCount, prevChainHash, timestamp)>",
  "timestamp": 1719705612080,
  "skipped": [],
  "sig": "<ed25519 by sender>"
}
```

Receiver (peer B):
1. Verify `senderReceiptSig` and `sig`
2. Compute `newChainHash = blake2b(prevChainHash + senderReceiptSig)`
3. Sign own receipt over `(waveId, hopCount+1, newChainHash, now())`
4. Forward to successor with `prevChainHash = newChainHash`

### 4.2 Refined `wave-selfie` (With Hyperblob Reference)

```json
{
  "type": "wave-selfie",
  "waveId": "uuid",
  "peerId": "B",
  "hopIndex": 42,
  "chainHash": "<accumulator value at this peer's hop>",
  "receiptSig": "<L1 signature>",
  "blobCoreKey": "<hypercore-key-of-blob-store>",
  "blobIndex": 7,
  "imageHash": "<blake2b-of-image>",
  "caption": "Vamos Brazil! 🇧🇷",
  "walletAddress": "<WDK-address>",
  "timestamp": 1719705650000,
  "sig": "<ed25519>"
}
```

### 4.3 Add `wave-start` and `wave-end`

As specified in Section 2.1 above. These are essential for lifecycle management.

---

## 5. Security Model — Honest Assessment

Your security table is well-structured but a few entries need recalibration:

| Attack | Your Claim | Reality Check |
|--------|-----------|---------------|
| **Drop token (griefing)** | "Attacker voids own reward" | ✅ Correct — but only if the attacker cares about the reward. A funded adversary could grief to sabotage a competitor's wave. The bond mitigates this. |
| **Sybil flooding** | "1 USDT bond makes it uneconomical" | ⚠️ Only true if per-hop reward < 1 USDT. If bounty is 500 USDT / 200 peers = 2.50/hop, a Sybil attacker who creates 5 identities (5 USDT cost) could capture 5 × 2.50 = 12.50. **Bond must exceed expected per-peer reward.** Set bond = 2× expected reward minimum. |
| **Premature skip** | "Skipped peer submits grievance" | ⚠️ This requires the skipped peer to still be online and gossiping. If they're genuinely slow (not dead), they might miss the grievance window. Add a **grace period** (e.g., skip is provisional for 10s; if skipped peer's heartbeat arrives, the skip is voided). |
| **Validator eclipse** | "Direct push + redundant gossip" | ⚠️ For MVP with a single trusted validator, this is moot. For production, you'd need a validator set with BFT consensus. Document this honestly. |

---

## 6. WDK Integration — Practical Notes

Based on the actual WDK documentation:

**What WDK gives you out of the box:**
- Self-custodial wallet creation (TypeScript SDK) ✅
- Multi-chain USDT transfers (Tron, Solana, Ethereum, Polygon) ✅
- Account management and balance queries ✅
- Swaps via integrated protocols ✅

**What WDK does NOT give you (you must build):**
- ❌ Smart contract escrow (bond locking) — you'd deploy your own contract or use a trusted validator
- ❌ Batch transfers — WDK does individual transfers; you'd loop
- ❌ Payment channels or streaming payments
- ❌ `wdk-mcp` as a turnkey AI validator — this would need custom integration

**Recommended WDK chain for MVP:** **Tron (TRX)**. Cheapest gas for USDT transfers, fast finality (~3s), and widely supported by WDK. Testnet USDT is readily available.

**Simplified MVP payment flow:**
```
1. Each peer: wdk.createWallet() → get Tron testnet address
2. Join bond: peer sends 1 testnet USDT → validator address (simple transfer)
3. Post-wave payout: validator sends reward USDT → each valid peer's address (loop of transfers)
4. Gallery tip: viewer's wallet sends 0.10 USDT → selfie peer's address (direct transfer)
```

No smart contracts needed for the MVP. The validator is trusted. Document this clearly.

---

## 7. Demo Strategy

For a hackathon demo, **the story matters as much as the tech**. Here's a recommended demo flow:

### Live Demo Script (5 minutes)

```
0:00–0:30  "Imagine a stadium wave, but global. No servers. No platform."
           Show ring visualization with 4 devices joining.

0:30–1:30  "The wave token launches — watch it race peer-to-peer."
           Token hops device → device. Ring lights up.
           Each device buzzes: "The wave passed you! Claim your link!"

1:30–2:30  "Each participant has 60 seconds to prove they were there."
           Participants tap to claim, take selfies, write captions.
           Selfies appear in the Autobase gallery in real-time.

2:30–3:30  "The wave completes. The validator walks the chain."
           Show validator console: walking receipts, verifying links.
           "Peer A is paid because Peer B continued the wave.
            Peer B is paid because Peer C continued the wave."
           Testnet USDT payouts fire.

3:30–4:30  "Now browse the gallery. A chain of strangers who moved together."
           Scroll through selfies in hop order.
           Tap "Tip 0.10 USDT" on a favorite → WDK transfer fires → tx hash appears.

4:30–5:00  "Sponsors fund the wave. Fans fuel it. WDK powers every hop.
            No servers. No platform. Just peers and money."
```

### Critical Demo Infrastructure
- **Pre-funded testnet wallets** on all devices (don't fumble with faucets live)
- **Pre-seeded Hyperblobs** with a fallback selfie in case camera fails
- **Validator running on a laptop** with visible console output (judges love seeing the chain walk)
- **Screen mirroring** for at least 2 devices + the gallery on a big screen
- **Recorded backup video** in case live networking fails (it will, at least once)

---

## 8. Summary of Changes

| Area | Change | Priority |
|------|--------|----------|
| Token message | Replace growing `hops[]` with compact chain hash accumulator | 🔴 Critical |
| Encoding | Use Compact Encoding for race-layer messages | 🟡 Should |
| Autobase timing | Write selfies during proof window, not after race | 🔴 Critical |
| Hyperblobs | Add `blobCoreKey` + `blobIndex` to selfie schema; validator replicates | 🟡 Should |
| Wave lifecycle | Add `wave-start` / `wave-end` messages; define laps and termination | 🔴 Critical |
| Anti-bot delay | Reframe as experiential cadence, not security | 🟢 Minor |
| Bond mechanism | Document as trusted-validator testnet transfer for MVP | 🟡 Should |
| Spectator mode | Add client-only peers for gallery viewing + tipping | 🟡 Should |
| MVP scope | Cut to 8 must-have items; defer healing to Tier 2 | 🔴 Critical |
| WDK chain | Use Tron testnet for cheapest, fastest USDT demo | 🟡 Should |
| Sybil economics | Bond must exceed 2× expected per-peer reward | 🟢 Minor |

---

## 9. What's Already Excellent

Don't lose these in the refinement:

- **The interlocked payment incentive** is genuinely novel and game-theoretically sound. "A is only paid when B proves they continued" is a clean, compelling mechanic.
- **The DHT ring as stadium seating** is a beautiful metaphor that makes the P2P architecture legible to non-technical judges.
- **Token race + proof window separation** (fast layer / human layer) is the right architectural split. The token doesn't wait for humans; humans prove after.
- **Gallery as permanent artifact** transforms a fleeting moment into shareable content with embedded money — this is the social loop that makes the project sticky.
- **Stack authenticity**: you're using each technology for what it's genuinely good at (Hyperswarm for discovery, Autobase for multi-writer state, Hyperblobs for media, WDK for money). No forced fits.

---

The design is strong. The main risks are **token message bloat** (fix the accumulator), **MVP over-scoping** (cut to 8 items), and **undefined wave lifecycle** (add start/end). Fix those three and you have a demoable, compelling hackathon project. Good luck at the Tether Developers Cup. 🏆

---

# 11. MVP Platform Decision: Desktop Electron (Pear)

**Decision:** The hackathon MVP ships as a **desktop Electron app** built on top of
[`holepunchto/hello-pear-electron`](https://github.com/holepunchto/hello-pear-electron),
not React Native / mobile. This is a deliberate scope choice to maximize demoability and
minimize the flakiest failure modes.

## 11.1 Why Desktop for the MVP

| Problem on mobile | How desktop Electron solves it |
|---|---|
| Real NAT hole-punching across 5 phones is the #1 live-demo failure | Run **N instances on one laptop** with `--storage <dir>` per instance. Local swarm, no NAT roulette. |
| Camera/permissions fumbling on device | `getUserMedia` webcam in the renderer is instant and reliable. |
| Slow build/flash cycle | `npm start` hot iteration; screen-record the whole demo on one machine. |
| Wallet funding/faucet fumbling | Pre-fund each instance's WDK wallet once, reuse across runs. |

The design still *describes* a global mobile experience — desktop is the MVP delivery
vehicle, and the P2P architecture is identical (Hyperswarm/Autobase/WDK all run the same).

## 11.2 What Changes vs. the Mobile Design

### The accelerometer is GONE — the selfie is the proof
Desktop has no accelerometer/gyroscope, so the **L2 Kinetic / L3 sensor layers are cut
for the MVP**. This is a feature, not a loss: the **Autobase webcam selfie chain becomes
the primary proof-of-humanity**, which §3 (Celebration Layer) already argued is stronger
than sensor data. A single webcam snap in the proof window now does triple duty:

- physical action (proof the human reacted),
- gallery content (the permanent artifact),
- proof-of-humanity (a live face at the token moment).

**Revised proof stack (MVP):**

| Layer | Name | Proof | Notes |
|-------|------|-------|-------|
| L1 | Receipt | `sign(H(tokenPayload), privKey)` | Unchanged. Cryptographic receipt of the token. |
| L2 | Chain | rolling `blake2b(prevChainHash + receiptSig)` accumulator | Keep the compact accumulator (§1.1) even on localhost. |
| L3 | Selfie | webcam capture → Hyperblob → `wave-selfie` Autobase write | Replaces the accelerometer. The humanity layer. |
| L4 | Forward | `sign(H(payload + receipt + successorId))` | Unchanged. Proves baton passed to a specific successor. |

Frame honestly: the selfie is not an unforgeable humanity oracle, but it raises the bar far
above a headless script and produces the shareable artifact that makes the demo land.

### Everything else is preserved
Ring-as-stadium, compact token accumulator, interlocked hop rewards, validator-as-swarm-peer,
Autobase gallery, WDK bond/payout/tipping — all unchanged.

## 11.3 Process Architecture (imposed by hello-pear-electron)

The template forces a clean three-process split. Map HyperWave onto it:

```
┌──────────────────────────── Renderer (Chromium) ────────────────────────────┐
│  UI only — never touches the swarm directly.                                 │
│  · Ring visualization (SVG/Canvas; live token pulse)                         │
│  · Proof-window modal + getUserMedia webcam capture                          │
│  · Gallery browser + one-click tipping + wallet balance                      │
│                          ▲  IPC bridge (events + commands)  │               │
└──────────────────────────┼──────────────────────────────────┼──────────────┘
                           │                                    ▼
┌──────────── Electron main (Node.js) ────────────┐   ┌─── Bare worker(s) ────────┐
│  · Window / lifecycle / Pear update bridge       │   │  All Holepunch P2P:       │
│  · IPC routing (renderer <-> worker)             │   │  · Hyperswarm join        │
│                                                  │   │  · Token race + gossip    │
│                                                  │   │  · Autobase + Hyperblobs  │
│                                                  │   │  · Corestore storage      │
│                                                  │   │  · WDK: wallet, bond,     │
│                                                  │   │    payout, tips (Tron     │
│                                                  │   │    testnet, no contracts) │
└──────────────────────────────────────────────────┘   └───────────────────────────┘
```

Rationale:
- **P2P in the Bare worker** — matches the template and keeps the swarm off the UI thread.
- **WDK in the same Bare worker** — WDK officially supports the Bare runtime
  (https://docs.wdk.tether.io/start-building/nodejs-bare-quickstart/), so payments live next
  to the swarm: `@tetherto/wdk` + `@tetherto/wdk-wallet-tron`, `WDK.getRandomSeedPhrase()` →
  `new WDK(seed).registerWallet('tron', WalletManagerTron, { provider })`, `wdk.dispose()` on
  shutdown. Wallet + swarm in one process means the validator's chain-walk and payout loop run
  where the chain was reconstructed — no extra IPC hop.
- **Renderer is a dumb terminal** — webcam frames and taps go out over IPC; ring/gallery
  state and tx hashes come back in. This is exactly the `bridge`/IPC pattern the template ships.

## 11.4 The Validator & Spectators as Windows

- **Sponsor Validator** = a peer instance run with a flag (e.g. `--role=validator`),
  ideally with a **visible log panel** showing: originate token → receipts arriving →
  chain walk → per-hop payout tx hashes. Judges love watching this.
- **Spectator** = an instance that joins the topic **client-only**
  (`{ server: false, client: true }`), renders ring + gallery, can tip, never receives a
  token. Trivial to add on desktop and great for the "audience" shot in the demo.

## 11.5 Local Multi-Instance Demo Recipe

```
# Terminal 1 — the validator/sponsor
npm start -- --storage /tmp/wave/validator --role=validator

# Terminals 2..N — participants (each its own identity + Corestore)
npm start -- --storage /tmp/wave/peerA
npm start -- --storage /tmp/wave/peerB
npm start -- --storage /tmp/wave/peerC

# Optional — a spectator
npm start -- --storage /tmp/wave/spectator --role=spectator
```

All instances join the same match topic and form one local swarm. Arrange the windows on
one screen, launch the wave from the validator, and record.

## 11.6 Revised MVP Build Order (Electron)

```
Step 1  Fork hello-pear-electron; confirm N instances launch with --storage and see each other on a topic.
Step 2  presence + ring-update gossip in the worker; ring visualization in the renderer over IPC.
Step 3  Token race: compact-accumulator wave-token, direct successor forwarding, validator originates.
Step 4  Proof window: renderer webcam capture -> Hyperblob in worker -> wave-selfie Autobase write.
Step 5  Gallery view (Autobase output) in the renderer; validator replicates Autobase+Hyperblobs as seed.
Step 6  WDK in worker: pre-funded Tron testnet wallets; validator chain-walk -> per-hop payout.
Step 7  One-click tipping from gallery (renderer -> main -> WDK transfer -> tx hash back to UI).
Step 8  Polish: token-pulse animation, validator log panel, spectator window; rehearse + record backup video.
```

Tier-2 (if time): `dead-peer` skip/healing, join bond, `wave-start`/`wave-end` lifecycle messages.

## 11.7 Open Questions to Resolve Before Coding

- **WDK runtime fit:** RESOLVED — WDK supports Bare, so it runs in the worker (§11.3).
  Still verify the Tron testnet provider URL and a testnet USDT faucet during the spike.
- **Role flag plumbing:** how `--role` / match-topic args reach the worker through the
  template's bridge (may need to extend the template's arg passing).
- **Autobase across N local writers:** RESOLVED — `spike/multiwriter/` verified discovery +
  multi-writer replication across 3 instances with separate `--storage` dirs (all converged on
  an identical view). The spike's swarm+Corestore+Autobase pattern ports directly into the worker.
