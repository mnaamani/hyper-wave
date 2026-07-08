# HyperWave — The Idea

_The stadium wave, rebuilt as a peer-to-peer network game — with real money on the line._

## The picture

Think of a stadium doing a Mexican wave: one section stands up, the next follows, and a
ripple of people travels around the whole arena. Nobody is in charge. It works because
everyone knows where they sit and reacts to their neighbour.

HyperWave does the same thing on the internet, with no server and no company in the
middle:

- Everyone who opens the app for a given match joins the same peer-to-peer swarm.
- Each person automatically gets a fixed **seat** on a giant circle. The seat isn't
  chosen — it's derived from their cryptographic identity, so nobody can pick a seat,
  fake one, or sit twice.
- Someone kicks off a wave, and a **football ⚽ races around the circle**, hopping from
  peer to peer, seat by seat — visible rolling around the ring on every screen at once.
- As the ball passes each participant, their **selfie** (taken moments earlier, while
  waiting in the lobby) pops into a shared gallery that everyone sees fill up in seat
  order, like the crowd standing up one by one.

When the ball makes it all the way around, the wave is complete: a lap of the world,
carried entirely by the participants themselves.

## Why it can't be faked

Every hop of the ball is **signed** by the peer that held it, and each signature is folded
into a small running fingerprint that travels with the ball (it stays tiny no matter how
many people take part). So a finished wave comes with proof of exactly who carried it and
in what order — no referee needed.

The selfie gallery has the same property: an entry is only accepted if it's signed by a
peer who really held the ball in that wave. What you see in the gallery is what actually
happened.

If someone's computer dies mid-wave, the ball doesn't get stuck — it simply skips to the
next live seat. The wave **heals itself**.

## The money (real, but testnet)

Every player has a **self-custodial wallet** built in (via Tether's WDK, on the Tron test
network). No sign-ups, no custodian — the app generates and holds your keys. Three simple
money rules:

1. **Playing costs a small fee — and the fee is burned.** Starting a wave or joining one
   costs 1 TRX, sent to an address nobody can ever spend from, with a note on the
   blockchain saying which wave it paid for. Nobody profits from fees; they exist purely
   so that spamming waves and seats costs real money. Before anyone joins a wave, their
   app checks the starter really paid — an unpaid wave is ignored by everyone.

2. **Tips are the only way to earn.** Anyone browsing the gallery can tip a selfie they
   love — 1 TRX straight from their wallet to the selfie-taker's wallet, peer to peer.
   The app makes sure a tip can only go to the wallet that actually paid that player's
   entry fee, so tips always land with a real participant.

3. **An optional raffle sweetens the pot.** Whoever starts a wave can attach a prize.
   After the wave, one participant is drawn at random and paid the prize — so joining
   costs 1 TRX but might win you several back. The draw is designed so nobody (including
   the person running it) can steer the result: every player locks in a secret number
   before the race and reveals it with their selfie, and the winner falls out of mixing
   all the revealed secrets together. The locked-in commitments are stamped into the
   fee-burn notes on the blockchain, so anyone can check the draw afterwards. The
   starter's own ticket can never win its own prize.

That's the whole economy: **pay to play (burned), tip to reward, raffle for luck.** There
are deliberately no "sponsor rewards" for participating — earlier versions of the design
had them, and they turned out to be an open invitation to farm fake participants. Burning
the fee removes anything to steal.

## Nobody is special

Every peer runs exactly the same app. There's no server, no operator, no admin, no
special "validator". The only asymmetry is temporary and earned: the person who starts a
wave looks after _that wave's_ gallery while they're online, and runs its raffle if they
funded one. Anyone can start the next wave.

## What it looks like

A desktop app (mobile version running the very same engine still under development):

- A ring of dots — one per person online, each with their chosen country flag.
- A **Kick off the wave** button. Pressing it pays the fee, then opens a short lobby
  where others can pay and opt in.
- During the lobby, your webcam frames your selfie with a countdown — the photo is taken
  _before_ the race, so the ball never has to wait for a human.
- The ⚽ rolls around the ring on everyone's screen; selfies pop into the centre as it
  passes each player; a 💵 button under each selfie sends a real tip.
- A 💰 chip shows your wallet balance the whole time.

## Why peer-to-peer matters here

The wave is a _crowd_ moment — it belongs to the crowd. Here that's literal: discovery,
messaging, the shared gallery, and the payments all happen directly between
participants (Hyperswarm for networking, Autobase for the shared gallery, WDK for
wallets). Kill any single machine and the wave routes around it. There is no backend to
shut down, throttle, or monetise the crowd through.

The design also scales past a small friendly group: peers organise themselves so each one
only keeps connections to a handful of well-chosen neighbours around the circle (rather
than everyone connecting to everyone), which is what lets the same design stretch toward
very large rings.

## Honest limitations

- **Testnet only.** The money is real in mechanism but test-value by design. A
  paid-entry prize draw is legally a lottery in most places, so the raffle must stay on
  testnet without proper legal work.
- **The wave is as fast as its slowest hop.** A ball that visits every seat in turn takes
  time proportional to the crowd; a truly instant "whole planet at once" wave would use a
  timed sweep instead of a relayed ball. That's a designed-for future step, not built.
- **Galleries are ephemeral.** Each run starts fresh; a wave's gallery lives as long as
  its starter stays online. A "past waves" archive is a possible future feature.
- **The raffle trusts its starter a little.** The draw math is publicly checkable, but
  the person funding the prize also controls who got into the gallery, so in a real-money
  version those two powers must be separated.

## Where to go deeper

- How it's put together: [`architecture.md`](./architecture.md)
- The exact wire protocol and crypto: [`protocol.md`](./protocol.md)
- Scaling the ring to large crowds: [`scalable-topology.md`](./scalable-topology.md)
- The raffle's fairness design: [`raffle.md`](./raffle.md)
- Run it yourself: the [repo README](../README.md)
