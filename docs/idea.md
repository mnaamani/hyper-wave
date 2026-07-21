# HyperWave — The Idea

_A worldwide wave of moments, built as a peer-to-peer network game — with real money on the line._

## The picture

Picture a ripple of light travelling around a huge circle of people spread across the
world: as it reaches each person, they capture a moment. Nobody is in charge. It works
because everyone knows where they stand on the circle and reacts to their neighbour.

HyperWave does exactly this on the internet, with no server and no company in the
middle:

- Everyone who opens the app for a given room joins the same peer-to-peer swarm.
- Each person automatically gets a fixed **place** on a giant circle. The place isn't
  chosen — it's derived from their cryptographic identity, so nobody can pick a spot,
  fake one, or stand twice.
- Someone starts a wave, which opens a short **lobby**: others pay the small fee, opt
  in, and frame their moment while a countdown runs. Opting in doubles as asking for your
  place in the wave's shared gallery — one step, no separate sign-up.
- When the lobby closes, the starter admits everyone who joined and broadcasts a single
  **start time**. Then the wave itself happens the way a real ripple does: nobody
  passes anything — **every phone and laptop fires its own moment** as the wave sweeps
  past its position on the circle. An orange spark races around the ring on every screen at
  once, perfectly in sync, because everyone computed the same choreography.
- As the wave reaches each participant, their **moment** (captured seconds earlier, in the
  lobby) pops into a shared gallery that everyone sees fill up in order around the ring,
  like a light travelling around the circle one place at a time.

When the sweep completes its lap, the wave is over — everywhere at once, a few seconds
after it started, whether ten people joined or ten thousand. It's choreography, not a
passed object: a lap of the world carried entirely by the participants themselves.

## Why it can't be faked

Every gallery entry is **signed**: to take a place in a wave's gallery, a participant signs
a statement binding their identity to that exact wave and that exact place, and every copy
of the app independently checks the signature before showing the entry. Nobody can post as
someone else, steal someone's place, or post twice — what you see in the gallery is what
actually happened, no referee needed.

The wave itself needs no trust at all: everyone derives the same schedule from the same
announced roster and start time, so there's nothing in flight to intercept or forge.

If someone's computer dies mid-wave, nothing gets stuck — their moment simply passes by,
like a gap in the ring, and the wave rolls on without missing a beat.

## The money (real, but testnet)

Every participant has a **self-custodial wallet** built in (via Tether's WDK, on the Tron
test network). No sign-ups, no custodian — the app generates and holds your keys. Three
simple money rules:

1. **Playing costs a small fee — and the fee is burned.** Starting a wave or joining one
   costs 1 TRX, sent to an address nobody can ever spend from, with a note on the
   blockchain saying which wave it paid for. Nobody profits from fees; they exist purely
   so that spamming waves and places costs real money. Before anyone joins a wave, their
   app checks the starter really paid — an unpaid wave is ignored by everyone.

2. **Tips are the only way to earn.** Anyone browsing the gallery can tip a moment they
   love — 1 TRX straight from their wallet to the capturer's wallet, peer to peer.
   The app makes sure a tip can only go to the wallet that actually paid that participant's
   entry fee, so tips always land with a real participant.

That's the whole economy: **pay to play (burned), tip to reward.** There are deliberately
no "sponsor rewards" for participating — earlier versions of the design had them, and they
turned out to be an open invitation to farm fake participants. Burning the fee removes
anything to steal.

**On the desktop the built-in wallet now defaults to Cashu — digital cash ("ecash") backed
by Bitcoin's Lightning network** — with the exact same rules. A fee is "burned" by locking a
few sats to a key nobody holds (the ecash equivalent of an unspendable address), stamped with
which wave it paid for; a tip is a little ecash token handed straight to the capturer, who
redeems it. Each participant picks which "mint" (the service that issues the ecash) they use,
and tips still work across different mints. The Tron wallet is still there as an option. It's
all testnet — play money, not real funds. (Details: `docs/cashu.md`.)

## Nobody is special

Every peer runs exactly the same app. There's no server, no operator, no admin, no
special "validator". The only asymmetry is temporary and earned: the person who starts a
wave looks after _that wave's_ gallery while they're online. Anyone can start another
wave — several can even run side by side.

## What it looks like

A desktop app, styled in Bitcoin black-and-orange with a ⚡ lightning motif (a mobile
version running the very same engine is still under development):

- A ring of dots — one per person online, each with their chosen country flag (where in
  the world they are).
- A **Start the wave** button. Pressing it pays the fee, then opens a short lobby
  where others can pay and opt in.
- During the lobby, your webcam frames your moment with a countdown — the photo is taken
  _before_ the wave runs, so the wave never has to wait for a human.
- An orange spark races around the ring on everyone's screen; moments pop into the centre
  as the wave passes each participant; a 💵 button under each moment sends a real tip.
- A 💰 chip shows your wallet balance the whole time.

## Why peer-to-peer matters here

The wave is a _crowd_ moment — it belongs to the crowd. Here that's literal: discovery,
messaging, the shared gallery, and the payments all happen directly between
participants (Hyperswarm for networking, Hypercore for the shared gallery, WDK for
wallets). Kill any single machine and the wave carries on without it. There is no backend
to shut down, throttle, or monetise the crowd through.

The design also scales past a small friendly group — but not by making one wave enormous.
Instead, many waves run **concurrently**, and each person only holds the photos for the
waves they actually opted into (you "subscribe" to the handful you care about, and ignore
the rest). Splitting the crowd across lots of small, self-contained waves — rather than one
giant ring where everyone stores everyone's photo — is what lets the same design stretch to
very large gatherings.

## Limitations

- **Testnet only.** The money is real in mechanism but test-value by design — no legal or
  regulatory work has been done to handle real funds.
- **Miss the lobby, watch the wave.** Everyone who wants a place has to opt in during the
  short lobby window; a latecomer still sees the whole wave and the gallery, but can't add
  a moment to that wave. (In exchange, the wave itself never stalls and takes a fixed few
  seconds no matter how big the crowd — there's no relayed object to get stuck or heal.)
- **Galleries are ephemeral.** Each run starts fresh; a wave's gallery lives as long as
  its starter stays online. A "past waves" archive is a possible future feature.

## Where to go deeper

- How it's put together: [`hosting.md`](./hosting.md)
- The exact wire protocol and crypto: [`protocol.md`](../../packages/hyperwave-engine/docs/protocol.md)
- Process/layer structure and the module map: [`hosting.md`](./hosting.md)
- Run it yourself: the [repo README](../../README.md)
