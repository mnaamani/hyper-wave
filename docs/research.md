# HyperWave — Research & Inspiration

The papers, protocols, and projects HyperWave draws on, with a note on what each one
contributed to the design. Deeper context for the choices documented in
[`protocol.md`](./protocol.md) and [`scalable-topology.md`](./scalable-topology.md).

## Distributed systems / topology

- **Chord: A Scalable Peer-to-peer Lookup Service for Internet Applications** — Stoica,
  Morris, Karger, Kaashoek, Balakrishnan (SIGCOMM 2001).
  <https://pdos.csail.mit.edu/papers/chord:sigcomm01/chord_sigcomm.pdf>
  The backbone of our scalable topology: the identifier ring, successor lists,
  predecessor, O(log N) finger tables, `findSuccessor` routing, and the
  stabilize/fixFingers maintenance loop are implemented (adapted) in `lib/chord.js` +
  `lib/chord-routing.js`. Our "seat on the ring derived from your key" is Chord's node id
  — doubling as the stadium seating chart.

- **Consistent Hashing and Random Trees** — Karger et al. (STOC 1997).
  <https://www.cs.princeton.edu/courses/archive/fall09/cos518/papers/chash.pdf>
  The idea underneath Chord's id space: hashing participants onto a circle so membership
  changes only perturb neighbours. It's why a peer's seat is stable and permissionless.

- **Epidemic Algorithms for Replicated Database Maintenance** — Demers et al. (PODC 1987).
  <https://dl.acm.org/doi/10.1145/41840.41841>
  The classic gossip paper. Our control-plane **flood** (`lib/flood.js`: relay on first
  sight of a `mid`, drop repeats) is textbook rumor mongering — it's how `wave-announce`
  / `wave-start` / `wave-end` blanket a partial mesh in a few rounds.

- **Epidemic Broadcast Trees (Plumtree)** — Leitão, Pereira, Rodrigues (SRDS 2007).
  <https://www.dpss.inesc-id.pt/~ler/reports/srds07.pdf>
  The refinement path for our flooding: prune the redundant flood edges into a spanning
  tree with gossip repair. Not implemented (plain flood is fine at our scale), but it's
  the known answer if flood traffic ever matters.

- **Kademlia: A Peer-to-peer Information System Based on the XOR Metric** — Maymounkov,
  Mazières (IPTPS 2002).
  <https://pdos.csail.mit.edu/~petar/papers/maymounkov-kademlia-lncs.pdf>
  The DHT design family behind Hyperswarm's HyperDHT, which gives us discovery ("who is
  on this match topic?") and NAT hole-punching for free.

## The Holepunch / Pear stack (the platform)

- **Hyperswarm** — <https://github.com/holepunchto/hyperswarm> — topic-based peer
  discovery over HyperDHT + Noise-encrypted duplex streams. All our networking.
- **Hypercore / Corestore** — <https://github.com/holepunchto/hypercore> — signed
  append-only logs + replication; the storage/replication substrate under the gallery.
- **Autobase** — <https://github.com/holepunchto/autobase> — multi-writer: many peers'
  logs deterministically merged into one view. The selfie gallery is one Autobase per
  wave, with our own deterministic `apply()` gates (signature check, one entry per peer,
  byte caps).
- **Protomux / compact-encoding** — <https://github.com/holepunchto/protomux> — channel
  multiplexing over one stream; our single JSON-over-`c.string` gossip channel rides it.
- **Bare** — <https://github.com/holepunchto/bare> — the small JS runtime the engine runs
  on (desktop worker, mobile worklet, tests).
- **hello-pear-electron** — <https://github.com/holepunchto/hello-pear-electron> — the
  Electron + Pear template the desktop app is forked from.
- **react-native-bare-kit** — <https://github.com/holepunchto/react-native-bare-kit> —
  Bare inside a React Native app; how the same engine runs on mobile.

## Payments

- **WDK (Wallet Development Kit)** — <https://docs.wdk.tether.io/> — Tether's
  self-custodial wallet SDK; runs under Bare, so the wallet lives in the same worker as
  the swarm. Seed phrase → per-chain accounts; we use `@tetherto/wdk-wallet-tron`.
- **Tron** — <https://tron.network/> (Nile testnet: <https://nileex.io/>) — the chain the
  MVP pays on: fast, cheap, and native-TRX transfers pay their own fee from the same
  balance (why we dropped TRC-20 USDT for the MVP).
- **Proof-of-Burn** — Karantias, Kiayias, Zindros (Financial Cryptography 2020).
  <https://eprint.iacr.org/2019/1096>
  Formalizes "destroying coins as a verifiable, beneficiary-less commitment". Our
  participation fees are exactly this: a transfer to Tron's unspendable black-hole
  address, memo-tagged to the wave, verifiable by anyone — skin in the game that enriches
  nobody.

## Cryptography

- **Ed25519: high-speed high-security signatures** — Bernstein, Duif, Lange, Schwabe,
  Yang (CHES 2011). <https://ed25519.cr.yp.to/ed25519-20110926.pdf>
  Every identity, hop receipt, attestation, and gallery entry is Ed25519-signed
  (via `hypercore-crypto` / libsodium).
- **BLAKE2: simpler, smaller, fast as MD5** — Aumasson, Neves, Wilcox-O'Hearn, Winnerlein
  (2013). <https://www.blake2.net/blake2.pdf>
  Our hash everywhere: ring topics, receipt hashes, and the chain accumulator.
- **The Noise Protocol Framework** — Perrin. <https://noiseprotocol.org/noise.html>
  The handshake/encryption under every Hyperswarm connection; also what gives us an
  authenticated remote identity per connection (the basis of our identity-binding checks).
- **Hash chains** (Lamport, "Password Authentication with Insecure Communication", 1981).
  <https://lamport.azurewebsites.net/pubs/password.pdf>
  The ancestor of our constant-size **chain accumulator**: folding each hop's signature
  into a rolling hash so the token stays tiny while still committing to the full hop
  history.

## The game itself

- **The Mexican wave (La Ola)** — Farkas, Helbing, Vicsek, "Social behaviour: Mexican
  waves in an excitable medium" (Nature 419, 2002).
  <https://www.nature.com/articles/419131a>
  A lovely aside: stadium waves really are a self-organising relay in an excitable
  medium, needing only ~25–35 people to trigger and travelling at a characteristic speed
  — no conductor. HyperWave is that phenomenon, moved onto a network: local rule
  ("react to your predecessor, pass to your successor"), global spectacle.
