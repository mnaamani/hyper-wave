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
- Someone kicks off a wave, which opens a short **lobby**: others pay the small fee, opt
  in, and frame their selfie while a countdown runs. Opting in doubles as asking for your
  seat in the wave's shared gallery — one step, no separate sign-up.
- When the lobby closes, the starter admits everyone who joined and broadcasts a single
  **start time**. Then the wave itself happens the way a real stadium wave does: nobody
  passes anything — **every phone and laptop fires its own moment** as the wave sweeps
  past its position on the circle. A football ⚽ rolls around the ring on every screen at
  once, perfectly in sync, because everyone computed the same choreography.
- As the wave reaches each participant, their **selfie** (taken moments earlier, in the
  lobby) pops into a shared gallery that everyone sees fill up in seat order, like the
  crowd standing up one by one.

When the sweep completes its lap, the wave is over — everywhere at once, a few seconds
after it started, whether ten people joined or ten thousand. It's choreography, not a
passed object: a lap of the world carried entirely by the participants themselves.

## Why it can't be faked

Every gallery entry is **signed**: to take a seat in a wave's gallery, a player signs a
statement binding their identity to that exact wave and that exact seat, and every copy of
the app independently checks the signature before showing the entry. Nobody can post as
someone else, steal someone's seat, or post twice — what you see in the gallery is what
actually happened, no referee needed.

The wave itself needs no trust at all: everyone derives the same schedule from the same
announced roster and start time, so there's nothing in flight to intercept or forge.

If someone's computer dies mid-wave, nothing gets stuck — their moment simply passes by,
like an empty seat in a stadium wave, and the wave rolls on without missing a beat.

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

That's the whole economy: **pay to play (burned), tip to reward.** There are deliberately
no "sponsor rewards" for participating — earlier versions of the design had them, and they
turned out to be an open invitation to farm fake participants. Burning the fee removes
anything to steal.

## Nobody is special

Every peer runs exactly the same app. There's no server, no operator, no admin, no
special "validator". The only asymmetry is temporary and earned: the person who starts a
wave looks after _that wave's_ gallery while they're online. Anyone can start the next
wave.

## What it looks like

A desktop app (mobile version running the very same engine still under development):

- A ring of dots — one per person online, each with their chosen country flag.
- A **Kick off the wave** button. Pressing it pays the fee, then opens a short lobby
  where others can pay and opt in.
- During the lobby, your webcam frames your selfie with a countdown — the photo is taken
  _before_ the wave runs, so the wave never has to wait for a human.
- The ⚽ rolls around the ring on everyone's screen; selfies pop into the centre as the
  wave passes each player; a 💵 button under each selfie sends a real tip.
- A 💰 chip shows your wallet balance the whole time.

## Why peer-to-peer matters here

The wave is a _crowd_ moment — it belongs to the crowd. Here that's literal: discovery,
messaging, the shared gallery, and the payments all happen directly between
participants (Hyperswarm for networking, Hypercore for the shared gallery, WDK for
wallets). Kill any single machine and the wave carries on without it. There is no backend
to shut down, throttle, or monetise the crowd through.

The design also scales past a small friendly group: peers organise themselves so each one
only keeps connections to a handful of well-chosen neighbours around the circle (rather
than everyone connecting to everyone), which is what lets the same design stretch toward
very large rings.

## Limitations

- **Testnet only.** The money is real in mechanism but test-value by design — no legal or
  regulatory work has been done to handle real funds.
- **Miss the lobby, watch the wave.** Everyone who wants a seat has to opt in during the
  short lobby window; a latecomer still sees the whole wave and the gallery, but can't add
  a selfie to that wave. (In exchange, the wave itself never stalls and takes a fixed few
  seconds no matter how big the crowd — there's no relayed ball to get stuck or heal.)
- **Galleries are ephemeral.** Each run starts fresh; a wave's gallery lives as long as
  its starter stays online. A "past waves" archive is a possible future feature.

## Where to go deeper

- How it's put together: [`architecture.md`](./hosting.md)
- The exact wire protocol and crypto: [`protocol.md`](../../packages/hyperwave-engine/docs/protocol.md)
- Process/layer structure and the module map: [`architecture.md`](./hosting.md)
- Run it yourself: the [repo README](../../README.md)
