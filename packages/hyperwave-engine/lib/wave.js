// HyperWave orchestrator — the composition root. Wires the transport (Hyperswarm +
// Protomux gossip) to the pure domains — ring geometry (ring.js), attestation crypto
// (attest.js), feed ordering (feed.js), sweep slot math (sweep.js) — and composes
// the stateful machines: PeerTable (seats/channels),
// Flood (gossip dedup), EntryPipeline (stage+slot pairing), and CrdtFeed
// (per-wave multicore CRDT feed). What remains here is the wave
// lifecycle FSM, the deterministic sweep, and the gossip dispatch that binds them.
// The payment layer (wallet.js, WDK) is injected by the worker via setWallet(): wallet
// address (for feed tips) + the on-chain burn verifier (the paid-wave anti-spam gate).
// Money model: burned fees (skin in the game) + feed tips; there are no sponsor rewards.
// Runs under Bare (the worker) or a Node harness. The Bare worker (hyperwave.js) bridges
// this to the renderer; wave.run.js drives it headlessly.
//
// Concurrent waves (protocol scaling.md Phase 1): the wave FSM is MULTIPLEXED — the engine
// runs `lobby → racing → idle` per wave, holding a Map<waveId, WaveState> instead of a
// singleton. Several waves can be engaged at once on the one topic; there is no longer a
// "one wave at a time" rule or a lower-waveId tie-break (those existed only to enforce the
// singleton). Every wave carries its own timers, EntryPipeline, and feed.
//
// Subscription layer (Phase 2): being AWARE of a wave (you saw its wave-announce) is distinct
// from PARTICIPATING in it (subscribed → you hold its feed cores + can join/post). A peer
// browses announced waves and subscribes to a chosen subset; an un-subscribed peer tracks the
// wave's existence (roster count, sweep) but opens NO cores — this bounds each peer's core
// budget to O(subscribed), not O(all waves). `subscribe`/`unsubscribe` open/close a wave's feed
// (feed lifecycle = join/leave). `autoSubscribe` (default true) subscribes on awareness, which
// preserves the single-wave demo UX; a host that wants true pick-and-choose sets it false.
//
// Scoped control gossip + sub-topics (Phase 3): the shared topic is a DIRECTORY (heartbeat
// liveness + tiny wave-announce — the browse surface, seen by everyone). Each wave's heavy
// control gossip (wave-join/start/sync) is SENT only to neighbours that advertised (via a one-hop
// `subs` message) they're subscribed to that wave, so a peer's control-plane traffic is
// O(subscribed). It all rides one Protomux channel per connection — the scoping is a send-side
// filter (`neighborSubs`), not separate channels. Subscribing also joins the wave's own sub-topic
// hash(prefix:topic:wave) so its participants discover each other off the O(N) directory mesh.
// Feed replication auto-scopes: a peer only opens (and so only replicates) cores for waves it
// subscribed to. A late/missed flood is always recovered by a wave-sync sent on mutual
// subscription. Result: a peer sees control traffic + feed for its subscribed waves + the
// directory → true O(subscribed).

const Hyperswarm = require('hyperswarm');
const Corestore = require('corestore');
const Protomux = require('protomux');
const cenc = require('compact-encoding');
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const fs = require('bare-fs');

const { angleOf, angleOfId } = require('./ring');
const { sweepSchedule, mySlot } = require('./sweep');
const {
  FLOODED_KINDS,
  MAX_WRITERS,
  validGossip,
  makeHeartbeat,
  makeSubs,
  makeWaveAnnounce,
  makeWaveJoin,
  makeWaveStart,
  makeWaveSync,
  makeWaveNote,
  makeDirectedNote
} = require('./messages');
const { Flood } = require('./flood');
const { RateLimiter, KeyedRateLimiter } = require('./rate-limiter');
const { CrdtFeed } = require('./feed-crdt');
const { PeerTable } = require('./peer-table');
const { EntryPipeline } = require('./entry');
const {
  signBurn,
  signJoin,
  verifyJoin,
  burnAuthorizes,
  startProofValid,
  signMessage,
  verifyMessage
} = require('./attest');

const DEFAULT_TOPIC = 'hyperwave:demo:v1';
const GOSSIP_PROTOCOL = 'hyperwave/gossip'; // the one Protomux channel per connection
// Phase 3 transport scoping. All gossip rides the single channel, but a wave's HEAVY control
// gossip (wave-join / wave-start / wave-sync) is only SENT to neighbours that told us (via a `subs`
// message) they're subscribed to that wave — so a peer's control-plane traffic is O(subscribed),
// not O(all waves). The tiny wave-announce still floods the whole directory (the browse surface).
// Each subscribed wave also joins its own Hyperswarm sub-topic hash(prefix:topic:wave) so its
// participants discover each other directly (off the O(N) directory mesh) at scale.
const WAVE_SUBTOPIC_PREFIX = 'hyperwave:wave:';
const HEARTBEAT_MS = 2000; // heartbeat cadence (liveness + tag)
const RINGUPDATE_MS = 4000; // seat-staleness + feed-pull maintenance cadence
const PEER_STALE_MS = 12000; // a peer whose last heartbeat is older than this is stale (dropped)
// Lobby: after "start", the wave is announced and peers get this long to opt in
// (get ready / opt in) before the sweep starts.
const LOBBY_MS = 15000;
// The sweep (protocol.md §6): the initiator's wave-start carries `t0` (epoch
// ms, a short lead so the flooded start reaches everyone before the first slot fires)
// and `lapMs`; every roster peer self-triggers at its own angle-ordered slot. Wall-clock
// is a CHOSEN constant regardless of N — no token, no per-hop round-trips, no healing
// (a dead peer's slot simply passes). Receivers clamp lapMs/t0 so a hostile start can't
// wedge a wave open.
const SWEEP_LEAD_MS = 3000;
const SLOT_MS = 400; // per-roster-member slot spacing target
const MIN_LAP_MS = 4000;
const MAX_LAP_MS = 60000;
const END_GRACE_MS = 2000; // after the last slot, before every peer returns to idle
// Cap on remembered message ids (flood dedup); the oldest ids are evicted first
// (flood.js), so a straggling duplicate of a very old message might re-flood once —
// harmless and very rare.
const GOSSIP_SEEN_CAP = 4096;
// Per-connection gossip rate limit (rate-limiter.js, protocol.md §11): a token bucket that drops a
// connection's over-budget frames BEFORE the parse + signature verify, capping the CPU a single
// peer can force us to spend on junk. Sized well above real traffic (a connection sees a heartbeat
// every 2s + bursty flood relays bounded by peers×waves — tens at most) but far below a blast:
// GOSSIP_BURST absorbs a legitimate spike (incl. the connect-time greeting), GOSSIP_RATE_PER_SEC is
// the sustained ceiling. Per-connection so throttling one noisy link never blackholes a message —
// the epidemic flood re-delivers a dropped relay from another neighbour.
const GOSSIP_BURST = 256; // bucket capacity (max burst)
const GOSSIP_RATE_PER_SEC = 64; // sustained frames/sec per connection
// Per-AUTHOR flood cap (rate-limiter.js KeyedRateLimiter, protocol.md §11): the complement to the
// per-connection limiter. A flooded message's authenticated `origin` is a third party at every
// relay hop, so the per-connection budget charges whoever RELAYS it, not the spammy author —
// letting one author's floods ride honest relayers outward. Keying a bucket on the (signed,
// unspoofable) `origin` makes every honest peer independently throttle that author, so an
// over-budget author's floods die instead of amplifying across the subgraph. Sized well above a
// legitimate author's flood rate (a wave costs its author ~3 originations — announce + own join +
// start — and re-floods dedup on `mid` before this is charged), so only a spammer hits it.
const FLOOD_ORIGIN_BURST = 64; // per-author flood burst
const FLOOD_ORIGIN_RATE_PER_SEC = 8; // sustained flood-originations/sec per author
const FLOOD_ORIGIN_MAX_AUTHORS = 4096; // bounded set of tracked authors (LRU-evicted)
// Hard per-wave roster cap: a wave seats at most this many participants; a peer arriving once the
// roster is full spectates (same as missing the lobby). It equals the wire cap (messages.MAX_WRITERS)
// so `wave.writers` never exceeds what a wave-start/wave-sync may legally carry — bounding that O(N)
// payload to a constant. The SWEEP stays deterministic regardless: its schedule derives from the
// single flooded wave-start (canonicalRoster of msg.writers), not each peer's local writers set.
// Scale is MANY concurrent bounded waves, not one unbounded wave (scaling.md).
const MAX_ROSTER = MAX_WRITERS;
// Max bytes for a single gossip frame at the receive edge. A frame larger than this is dropped
// before the JSON.parse + validation (so a hostile peer can't force a big parse / O(N)-writers
// walk). Sized comfortably above the largest LEGITIMATE frame — a full-roster wave-start is
// MAX_ROSTER × ~300 B ≈ 77 KB — with margin; matches the feed's MAX_PAYLOAD_BYTES convention. The
// roster cap is what makes this a safe CONSTANT (an unbounded roster would force an O(N) frame cap).
const MAX_FRAME_BYTES = 256 * 1024; // 256 KB
// Transport-level per-message cap, enforced by the vendored @hyperswarm/secret-stream patch
// (scripts/patch-secret-stream.js) BEFORE its ~16 MB allocUnsafe — the fix the receive-edge frame
// cap can't do (that runs after the transport already allocated). Applied per connection, but only
// on an engine-OWNED swarm: it caps every message on the stream (gossip + the shared Hypercore
// replication channel), and our largest legitimate message is a feed block (≤ MAX_PAYLOAD_BYTES
// 256 KB + Hypercore framing), so 1 MB is comfortable margin. NOT set on a host-supplied swarm —
// that swarm's OTHER protocols may use larger messages, so the host owns its cap there.
const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MB
// How long the initiator waits for its start burn to confirm + announce before aborting
// the wave back to idle (paid-wave gate). Generous: the burn broadcasts in ~2s but on-chain
// read-back can lag; must exceed the worker's confirmation poll budget.
const PAY_TIMEOUT_MS = 60000;
// A TRANSIENT start-burn verify failure (couldn't reach/decode the initiator's mint — common when
// it's a FOREIGN Cashu mint) is retried with linear backoff rather than rejecting the wave, so a
// momentary foreign-mint blip can't permanently kill an honest cross-mint wave (verifyStartProof).
const VERIFY_MAX_RETRIES = 3; // 3 retries at 1.5s / 3s / 4.5s ≈ 9s, well within the lobby window
const VERIFY_RETRY_MS = 1500;
// Envelope age bound (protocol.md §5.0): a message whose signed `ts` is older than this is
// dropped at the receive edge (and never relayed). This is a HARD cap on how long any flooded
// message can circulate — independent of `mid` dedup — so a routing loop / dedup-set bug can't
// amplify into unbounded flooding, AND a captured message can't be replayed later (its `ts` is
// signed, so it can't be refreshed without the author's key). Generous vs the wave lifecycle
// (lobby + lap ≤ ~75s) so slow propagation is fine; kills ancient replays.
const GOSSIP_MAX_AGE_MS = 300000; // 5 min
// Tolerance for a message whose `ts` is in the future (unsynchronized peer clocks).
const CLOCK_SKEW_MS = 60000; // 1 min
// A wave's kick-off (start) burn must be recent to adopt the wave — belt-and-suspenders beyond
// the message age bound: even a freshly-signed announce that reuses a very old burn is rejected.
// The burnTs is part of the signed burn tuple, so it can't be back-dated without the initiator's
// key. Generous clock-skew allowance (peers aren't time-synchronized).
const MAX_KICKOFF_AGE_MS = 300000; // 5 min
// Directed-note (wave-dm) dial fallback: how long to keep a joinPeer dial + its queued notes alive
// waiting for the connection, and how many notes to hold per peer (bounds a stuck dial). A note
// still undelivered when the dial times out is dropped (the recipient is unreachable).
const DM_DIAL_TIMEOUT_MS = 20000; // 20 s
const DM_MAX_QUEUED = 8; // per peer

/**
 * Short 8-char prefix of a hex id, for readable logs.
 * @param {string} hex Full hex id (peer id, wave id, core key…).
 * @returns {string} The first 8 hex characters.
 */
function shortId(hex) {
  return hex.slice(0, 8);
}

/**
 * Parse a HYPERWAVE_BOOTSTRAP-style "host:port[,host:port…]" list into Hyperswarm's
 * bootstrap option (a local DHT for instant same-machine discovery); falsy → null
 * (the public DHT). Shared by both engine hosts.
 * @param {string} str Comma-separated "host:port" list, or a falsy value.
 * @returns {Array<{host: string, port: number}>|null} Bootstrap nodes, or null for the public DHT.
 */
function parseBootstrap(str) {
  if (!str) {
    return null;
  }
  return str.split(',').map((hostPort) => {
    const [host, port] = hostPort.split(':');
    return { host, port: Number(port) };
  });
}

const SWARM_SEED_BYTES = 32; // hypercore-crypto.keyPair seed length

/**
 * Load (or first-time create + persist) the 32-byte seed that derives this peer's swarm keypair —
 * its ring seat AND the key that signs its burn + join attestations. Without a persisted
 * seed, Hyperswarm mints a fresh keypair each run, so the peer id (and its ring position) changes
 * on every restart. Persisted as hex at <storageDir>/swarm.seed — a sibling of wallet.seed and
 * OUTSIDE the per-run hyperwave store that createWave wipes — so the identity/seat is stable across
 * restarts. A host may inject a hex seed (e.g. mobile secure storage); an injected seed is used
 * verbatim and never written to disk. Independent of the wallet seed for KEY ISOLATION, not
 * privacy: a leaked wallet.seed (funds) shouldn't also hand over the ring signing identity, and
 * vice versa. (It buys no unlinkability — a fee burn is sent from the wallet with an on-chain memo
 * `hyperwave:<waveId>:<peerId>`, so any paid wave already ties the wallet address to the peerId.)
 * A missing/corrupt file is regenerated rather than fatal (a bad seed shouldn't brick startup —
 * worst case the seat moves once).
 * @param {string} storageDir Instance storage dir; the seed is persisted at <storageDir>/swarm.seed.
 * @param {string|null} [injectedSeed] Optional hex seed (e.g. mobile secure storage); used verbatim, never written.
 * @param {(...args: any[]) => void} [log] Logger.
 * @returns {Buffer} The 32-byte swarm identity seed.
 */
function loadOrCreateSwarmSeed(
  storageDir,
  injectedSeed = null,
  log = () => {}
) {
  const seedFile = storageDir + '/swarm.seed';
  let seed = null;
  if (injectedSeed && injectedSeed.trim()) {
    const parsed = b4a.from(injectedSeed.trim(), 'hex');
    if (parsed.length === SWARM_SEED_BYTES) {
      return parsed; // injected: used as-is, not persisted
    }
  }
  try {
    const parsed = b4a.from(fs.readFileSync(seedFile, 'utf8').trim(), 'hex');
    if (parsed.length === SWARM_SEED_BYTES) {
      seed = parsed;
    }
  } catch {}
  if (!seed) {
    seed = crypto.randomBytes(SWARM_SEED_BYTES);
    try {
      fs.mkdirSync(storageDir, { recursive: true });
      fs.writeFileSync(seedFile, b4a.toString(seed, 'hex'));
      log('swarm identity seed created:', seedFile);
    } catch (err) {
      log(
        'swarm seed persist failed (ephemeral identity this run):',
        err.message
      );
    }
  }
  return seed;
}

/**
 * @typedef {Object} CreateWaveOptions
 * @property {string} storageDir Instance storage dir (per-run hyperwave store + persisted swarm.seed).
 * @property {(msg: Object) => void} emit The single host sink: every observable change is raised as a typed message — `{ type: 'state', me, peers, connected, discovered }` on a ring change, `{ type: 'event', event, … }` for lifecycle/UI events, `{ type: 'feed', waveId, items }` on a feed update (tagged with the wave it belongs to, since several waves can update concurrently).
 * @property {(...args: any[]) => void} [log] Logger.
 * @property {Array<{host: string, port: number}>|null} [bootstrap] Local-DHT bootstrap nodes, or null for the public DHT.
 * @property {string} [topicId] Topic string (all peers on the same id share one ring).
 * @property {number} [lobbyMs] Lobby window length in ms (opt-in window before the race).
 * @property {number} [minFee] Local anti-sybil floor (default 0 = accept any): refuse to engage/join a paid wave whose initiator-set `fee` is below this. Only enforced when a wallet is wired (`enforcePaid`).
 * @property {number} [maxPeers] Hyperswarm connection cap (default 64; lower to force a partial mesh). Ignored when `swarm` is supplied.
 * @property {string} [swarmSeed] Hex seed for the swarm identity; distinct from the wallet seed (createPayments). Ignored when `swarm` is supplied.
 * @property {Object} [swarm] An existing Hyperswarm the host owns; the engine shares it (joins its topics + adds listeners) and NEVER destroys it — on close it only leaves those topics + detaches its listeners. Share the host's swarm when the app also uses Hyperswarm (one instance per process). When set, `maxPeers`/`bootstrap`/`swarmSeed` are the host's concern and are ignored.
 * @property {number} [maxMessageSize] Transport per-message byte cap (the vendored secret-stream patch), applied per connection on an engine-OWNED swarm only (0 disables). Default 1 MB — bounds the transport's ~16 MB allocation. Not applied to a host-supplied swarm (whose other protocols set their own cap).
 */

/**
 * @typedef {Object} WaveHandle
 * @property {{id: string, angle: number, tag: string|null}} me This peer's ring identity.
 * @property {() => string|null} startWave Announce a new wave + open its lobby; returns the new waveId. Concurrent starts are allowed (no singleton).
 * @property {(waveId: string) => string|null} subscribe Subscribe to a wave (hold its feed cores + receive its control gossip); returns the waveId, or null if unknown.
 * @property {(waveId: string) => void} unsubscribe Unsubscribe from a wave (free its cores; stay aware for the browse list).
 * @property {(waveId?: string) => string|null} join Opt into a lobby (the given wave, or the newest joinable one); implies subscribe; returns the joined waveId, or null on a no-op.
 * @property {(tag: string) => void} setTag Set the tag (cosmetic, rides the heartbeat).
 * @property {(entry: {payload?: *, waveId?: string}) => void} stageEntry Stage my opaque entry payload to post at my sweep slot (for the given wave, or the newest one I've joined).
 * @property {(input: {waveId: string, note: Object}) => boolean} note Broadcast an opaque note on a wave (a roster-member announcement); floods to its subscribers only if I'm a participant. Returns whether it was broadcast.
 * @property {(address: string|null, verifier?: Function, walletType?: string, fee?: number) => void} setWallet Wire the payment layer (address + on-chain burn verifier + wallet type + my fee — type and fee ride the waves I initiate).
 * @property {(waveId: string) => number|null} feeFor The initiator-set participation fee a wave requires (announced), or null if none — the host's fee flow burns exactly this.
 * @property {(proof: Object) => void} announcePaid Initiator: attach the confirmed start proof and announce (routed to the proof's waveId).
 * @property {(fields: Object) => Object} recordBurn Sign a fee-burn attestation (the paid-wave gate ticket) for its waveId.
 * @property {() => Promise<void>} close Tear down timers, swarm, galleries, and the store.
 */

/**
 * Create the HyperWave orchestrator: joins the topic swarm, runs the wave lifecycle
 * (lobby → sweep → feed) — multiplexed per wave over the topic mesh — and exposes the
 * command surface the host (worker/harness) drives.
 * @param {CreateWaveOptions} options
 * @returns {WaveHandle} The command + identity surface for this peer.
 */
function createWave({
  storageDir,
  emit,
  log = () => {},
  bootstrap = null,
  topicId = DEFAULT_TOPIC,
  lobbyMs = LOBBY_MS,
  // Local anti-sybil floor: refuse to engage/join a paid wave whose initiator-set fee is below
  // this (0 = accept any). Only meaningful once a wallet is wired (enforcePaid); a per-deployment
  // policy that stops a hostile initiator advertising fee≈0 to make sybil joins ~free.
  minFee = 0,
  // Hyperswarm's connection cap. 64 is Hyperswarm's own default; lower it (e.g. 16) to
  // force a genuine partial mesh below the peer count — the condition the flood is
  // designed for, and what a real large swarm looks like.
  maxPeers = 64,
  swarmSeed = null, // hex seed for the swarm identity; distinct from the wallet seed (createPayments)
  // Subscription policy (Phase 2). true → subscribe to every wave the moment we become aware of
  // it (open its cores; the single-wave demo UX + the headless CLI rely on this). false → stay
  // merely AWARE until the host calls subscribe()/join(), so a peer holds cores only for the
  // waves it chose — the O(subscribed) core budget.
  autoSubscribe = true,
  // An existing Hyperswarm the host already owns; share it instead of creating one (correct when
  // the app also uses Hyperswarm — one instance per process). The engine never destroys it.
  swarm: externalSwarm = null,
  // Transport per-message byte cap (secret-stream patch), applied per connection on an ENGINE-OWNED
  // swarm only. 0 disables. Raise it if the host runs another protocol with larger messages on a
  // swarm the engine owns (uncommon — a shared swarm is the usual reason, and that isn't capped).
  maxMessageSize = MAX_MESSAGE_BYTES
}) {
  // One host sink. Every observable change flows to the host through `emit(msg)` as a typed
  // message; these three build the envelopes the former onState/onEvent/onFeed trio used to. The
  // engine's `emit` and the seam's are the same single-notifier shape, so a message the wave emits
  // reaches the UI unwrapped. A feed update carries its `waveId` — with concurrent waves, several
  // feeds can update, and the host keys its view by wave.
  const emitState = (state) => emit({ type: 'state', ...state });
  const emitEvent = (event) => emit({ type: 'event', ...event });
  const emitFeed = (waveId, items) => emit({ type: 'feed', waveId, items });
  // The store is per-run (galleries are keyed by the random waveId, so nothing persists
  // meaningfully across runs); wipe it on startup to reclaim disk.
  const storePath = storageDir + '/hyperwave';
  try {
    fs.rmSync(storePath, { recursive: true, force: true });
  } catch {}
  const store = new Corestore(storePath);
  // The swarm: either an existing instance the HOST already owns (passed in), or one we create.
  // Sharing the host's swarm is the correct choice when the app is ALSO using Hyperswarm — two
  // Hyperswarm instances in one process don't reliably discover each other, so a host with its
  // own swarm should hand it here rather than let the engine open a second. When `swarm` is
  // provided the engine NEVER destroys it (the host owns its lifecycle — on close we only leave
  // the topics we joined + detach our listeners), and `maxPeers`/`bootstrap`/`swarmSeed` are the
  // host's concern (ignored here; identity is the shared swarm's keyPair).
  const ownsSwarm = !externalSwarm;
  let swarm;
  if (externalSwarm) {
    swarm = externalSwarm;
  } else {
    // Persisted swarm identity: derive the Noise keypair from a seed that survives restarts, so a
    // peer keeps the SAME id / ring seat / signing key across runs (loadOrCreateSwarmSeed). Passing
    // an explicit keyPair overrides Hyperswarm's fresh-per-run default. bootstrap: pass a local DHT
    // for instant same-machine discovery (tests / single-laptop demo); omit for the public DHT.
    const swarmKeyPair = crypto.keyPair(
      loadOrCreateSwarmSeed(storageDir, swarmSeed, log)
    );
    swarm = new Hyperswarm({
      keyPair: swarmKeyPair,
      maxPeers,
      ...(bootstrap ? { bootstrap } : {})
    });
  }

  const meKey = swarm.keyPair.publicKey;
  const me = {
    id: b4a.toString(meKey, 'hex'),
    angle: angleOf(meKey),
    tag: null
  };
  let walletAddress = null; // my wallet address (set by the host once the wallet is ready)
  let myWalletType = null; // my wallet's payment-mechanism id (rides my waves' announces)
  let myFee = null; // my wallet's fee — the fee I SET on the waves I initiate (rides their announces)
  let enforcePaid = false; // gate waves on a proven start burn (enabled once wallet is up)
  let verifyBurnOnChain = null; // on-chain burn check (set once the wallet is up, via setWallet)
  // Live peer bookkeeping (peer-table.js): seats + direct channels.
  const table = new PeerTable({ meId: me.id, staleMs: PEER_STALE_MS });
  const endedWaves = new Set(); // waves that finished — never re-adopt (prevents revival)
  const flood = new Flood({ cap: GOSSIP_SEEN_CAP }); // flood dedup for relayed control msgs
  // Per-author flood budget: caps how many distinct floods a single (authenticated) origin can push
  // through me before I stop relaying/processing them — the anti-amplification complement to the
  // per-connection rate limiter (protocol.md §11).
  const originFlood = new KeyedRateLimiter({
    capacity: FLOOD_ORIGIN_BURST,
    refillPerSec: FLOOD_ORIGIN_RATE_PER_SEC,
    maxKeys: FLOOD_ORIGIN_MAX_AUTHORS
  });
  // Phase 3 scoping state. neighborSubs: what each connected neighbour told us it's subscribed to
  // (via `subs`) — I forward a wave's join/start/sync only to neighbours whose set contains it.
  const neighborSubs = new Map(); // connId -> Set<waveId>
  const subTopics = new Set(); // waveIds whose sub-topic I've swarm.join()'d (subscribed waves)
  // Directed-note (wave-dm) delivery: when I want to unicast to a peer I have no direct channel to,
  // I swarm.joinPeer() to dial it and queue the note here; onConnection flushes the queue for that
  // peer. `dmDialed` tracks peers I joinPeer'd so close() can leavePeer them. Bounded per peer.
  const pendingDm = new Map(); // toId -> Array<{ waveId, note }> awaiting a connection
  const dmDialed = new Set(); // peer ids I swarm.joinPeer()'d for a directed note

  // Wave lifecycle, MULTIPLEXED: idle -> lobby -> racing -> idle, per wave. `waves` holds every
  // currently-engaged wave keyed by its id; each WaveState owns its own timers, EntryPipeline,
  // roster (writers), and paid-gate status. Concurrent waves coexist (no singleton, no
  // lower-waveId tie-break). During a wave's lobby, peers opt in; only its roster gets an entry
  // slot — everyone renders its sweep.
  const waves = new Map(); // waveId -> WaveState
  // Waves I hold the feed cores for (Phase 2 subscription layer). DECOUPLED from `waves`: a wave's
  // FSM ends (its WaveState is dropped) but its feed lingers as the idle gallery until the host
  // unsubscribes (or engine close) — so this outlives the WaveState, and unsubscribe() can free an
  // already-ended wave's cores. Feeds are NOT auto-closed at wave-end: entries from the final sweep
  // slots keep replicating (and latecomers keep pulling) past the deterministic end, so closing
  // there would race convergence. Lifecycle is join/leave (subscribe/unsubscribe), per scaling.md.
  const subscriptions = new Set(); // waveId
  // The roster (participant peerIds) per wave, kept ALIVE past the FSM's WaveState. `wave.writers`
  // is deleted with the WaveState at goIdle, but the wave-note gate (a roster-member broadcast, e.g.
  // a tip announcement) must still work while the idle gallery is browsable — tips happen post-wave.
  // So the roster is mirrored here, tied to the FEED lifetime (populated as writers are ingested,
  // freed with the cores on unsubscribe/close/closeWave), so it outlives the WaveState exactly as
  // the feed does. Used to gate BOTH originating a wave-note and relaying/processing one.
  const rosters = new Map(); // waveId -> Set<peerId>
  // When a revivable idle (lobby-timeout) abandons a wave I had JOINED, remember my join state so
  // a late wave-start can re-adopt the wave with my slot still arming + my entry still posting.
  // Keyed by waveId (concurrent waves each get their own memo). See REVIVABLE_IDLE_REASONS.
  const abandonedJoins = new Map(); // waveId -> { joinSig, burnProof }

  // Per-wave feed (feed-crdt.js): each participant owns one Hypercore and appends
  // its one entry; every peer opens the roster's cores (keys ride wave-join) and merges
  // locally — no indexer, no admission. It holds every concurrently-engaged wave's feed;
  // the accessors read the live per-wave WaveState (its EntryPipeline's burn proof + my join sig).
  const session = new CrdtFeed({
    store,
    me,
    onFeed: emitFeed,
    walletAddress: () => walletAddress,
    burnProof: (waveId) => waves.get(waveId)?.pipeline.burnProof ?? null,
    joinProof: (waveId) => waves.get(waveId)?.joinSig ?? null,
    log
  });

  // --- per-wave state helpers -------------------------------------------------

  /**
   * The newest lobby I can still opt into (joinable = in lobby, paid-verified, not yet joined) —
   * the default target when a host calls join() without a waveId. `waves` preserves insertion
   * order, so the last match is the most-recently-announced wave.
   * @returns {Object|null} The WaveState, or null if none is joinable.
   */
  function newestJoinableLobby() {
    const list = [...waves.values()];
    for (let i = list.length - 1; i >= 0; i--) {
      const wave = list[i];
      if (wave.phase === 'lobby' && !wave.joined && wave.paid === 'verified') {
        return wave;
      }
    }
    return null;
  }

  /**
   * The newest wave I've joined — the default target when a host stages an entry without a
   * waveId (the wave whose sweep will post it).
   * @returns {Object|null} The WaveState, or null if I've joined none.
   */
  function newestJoinedWave() {
    const list = [...waves.values()];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].joined) {
        return list[i];
      }
    }
    return null;
  }

  // --- ring / peer table -----------------------------------------------------
  /** Recompute the live ring and push `{ me, peers, connected, discovered }` to the host (emitState). */
  function pushRingState() {
    emitState({
      me,
      peers: table.liveRing(),
      connected: [...table.senderIds()].length,
      // DHT-discovered count (may exceed live seats): hosts gate start triggers on
      // this — a seat needs a live connection, but "the roster exists" only needs
      // the DHT to have seen the peers.
      discovered: swarm.peers.size
    });
  }

  /**
   * Set the tag this peer supports; rides the heartbeat + entry entries (cosmetic).
   * @param {string} code Supported-tag code (falsy clears it).
   */
  function setTag(code) {
    me.tag = code || null;
    pushRingState();
  }

  // The heartbeat: pure liveness + tag, one hop to every connection (tiny ×
  // ≤maxPeers every HEARTBEAT_MS is noise). Peers don't gossip ring structure — the
  // sweep needs no successors. The envelope (origin/ts/sig) is stamped by originate().
  /** @returns {Object} A `heartbeat` gossip message (pre-envelope): my tag (pure liveness). */
  function myHeartbeat() {
    return makeHeartbeat({ tag: me.tag });
  }

  /**
   * Is a message's signed timestamp within the acceptable window — not older than
   * GOSSIP_MAX_AGE_MS (the replay / circulation bound) and not implausibly in the future
   * (CLOCK_SKEW_MS, for unsynchronized clocks)?
   * @param {number} ts The message's author timestamp (ms).
   * @returns {boolean} True if the message is fresh enough to accept + relay.
   */
  function freshEnough(ts) {
    const now = Date.now();
    return ts <= now + CLOCK_SKEW_MS && ts >= now - GOSSIP_MAX_AGE_MS;
  }

  /**
   * Central inbound-gossip dispatcher (one Protomux channel per connection carries every kind).
   * Shape-gates, then verifies the uniform envelope (signature by `origin` + age bound), then
   * identity-binds direct kinds, then routes. wave-announce floods the whole directory;
   * wave-join/wave-start flood only the subscribed subgraph (relayWave); wave-sync + subs are
   * one-hop. `origin` is the author on every kind; wave-sync's `by` is the wave initiator.
   * @param {Object} msg Parsed gossip message (has a `kind`).
   * @param {string} fromId Hex id of the Noise-authenticated connection it arrived on.
   */
  function handleGossip(msg, fromId) {
    // Shape gate (messages.js): unknown/malformed messages (incl. a missing envelope) drop here.
    if (!validGossip(msg)) {
      return;
    }
    // Envelope authenticity: `sig` is a valid Ed25519 by `origin` over the whole message. This is
    // the ONE shared check for every kind — a flooded message is trusted by this, not by the
    // connection it arrived on (its `origin` is a third party at relay hops). Reject forgeries
    // BEFORE relaying, so a bad message can't be amplified.
    if (!verifyMessage(msg)) {
      return;
    }
    // Age bound: drop (and never relay) a message whose signed `ts` is too old / too far future.
    if (!freshEnough(msg.ts)) {
      return;
    }
    // Identity binding for DIRECT kinds (heartbeat / subs / wave-sync): the author must be the
    // Noise-authenticated peer that sent it — otherwise a peer could fake another's liveness /
    // subscriptions. Flooded kinds legitimately carry a third-party `origin` (authenticated above).
    if (!FLOODED_KINDS.has(msg.kind) && msg.origin !== fromId) {
      return;
    }
    if (msg.kind === 'heartbeat') {
      table.upsert(msg.origin, Date.now(), msg.tag);
      pushRingState();
      return;
    }
    if (msg.kind === 'subs') {
      recordNeighborSubs(fromId, msg.subs);
      return;
    }
    if (msg.kind === 'wave-sync') {
      handleWaveSync(msg);
      return;
    }
    if (msg.kind === 'wave-dm') {
      handleDirectedNote(msg);
      return;
    }
    // Flooded control kinds (announce / join / start): process once, relay on first sight.
    if (FLOODED_KINDS.has(msg.kind)) {
      if (!flood.firstSight(msg.mid)) {
        return; // already seen -> drop (stops loops)
      }
      // Per-author flood cap: charge this distinct flood (checked AFTER dedup, so it counts genuine
      // originations, not re-sightings) against its authenticated `origin`'s budget. An over-budget
      // author's excess floods are dropped here — never relayed, never processed — so a spammy
      // author can't amplify across the subgraph on honest relayers' backs (protocol.md §11).
      if (!originFlood.allow(msg.origin, Date.now())) {
        return;
      }
      if (msg.kind === 'wave-announce') {
        // the tiny announce floods the whole directory (browse surface). The connect-time catch-up
        // forwards a stored announce verbatim (same signed frame + mid), so a re-flood of it dies
        // within one hop by the same dedup — no separate catch-up path needed.
        relayDir(msg, fromId);
        handleWaveAnnounce(msg);
        return;
      }
      // A wave-note is a roster-member broadcast: relay + process it ONLY if `origin` is a
      // credentialed participant of the wave (in wave.writers). A peer that doesn't know the wave,
      // or whose author isn't on the roster, drops it (no relay, no process) — so a non-participant
      // can't inject notes onto a wave, and the flood dies at the edge of who can vouch for it. The
      // envelope sig already proved `origin` is the real author; this adds "and it's a participant".
      if (msg.kind === 'wave-note') {
        // Gate on the feed-lifetime roster (not the FSM WaveState, which is gone once the wave goes
        // idle) — so a tip note broadcast while browsing the idle gallery is still relayed/processed.
        if (!isRosterMember(msg.waveId, msg.origin)) {
          return;
        }
        relayWave(msg.waveId, msg, fromId);
        handleWaveNote(msg);
        return;
      }
      // join / start flood only among the wave's subscribers (O(subscribed), not O(topic)).
      relayWave(msg.waveId, msg, fromId);
      if (msg.kind === 'wave-join') {
        handleWaveJoin(msg);
      } else {
        handleWaveStart(msg);
      }
    }
  }

  /**
   * A neighbour told us its subscription set (on connect + on change). Record it (so we scope which
   * waves' join/start/sync we forward there), and catch it up: for every wave it just revealed it's
   * subscribed to that I'm also subscribed to and hold state for, unicast it a wave-sync.
   * @param {string} fromId The neighbour's connection id.
   * @param {string[]} subs The neighbour's subscribed wave ids.
   */
  function recordNeighborSubs(fromId, subs) {
    const previous = neighborSubs.get(fromId) || new Set();
    const next = new Set(subs);
    neighborSubs.set(fromId, next);
    for (const waveId of next) {
      if (!previous.has(waveId) && subscriptions.has(waveId)) {
        syncPeer(fromId, waveId); // newly-mutual subscription → catch the neighbour up
      }
    }
  }

  /**
   * A peer told us a wave's state when we joined mid-lobby / mid-race (unicast on connect).
   * @param {Object} msg A wave-sync message.
   */
  function handleWaveSync(msg) {
    if (!canAdopt(msg.waveId)) {
      return;
    }
    // anti-spam: adopt a synced wave (lobby OR racing) only with a valid start proof. A
    // *racing* sync is gated too — else a hostile peer could unicast a fabricated racing
    // wave-sync on connect to force a newcomer into a bogus wave, bypassing the paid gate.
    // The signed burn-proof can't be forged for a key the attacker lacks.
    if (enforcePaid && !validStartProof(msg.paid, msg.waveId, msg.by)) {
      return;
    }
    // local anti-sybil floor: don't engage a wave whose initiator-set fee is below my minimum.
    if (belowFloor(msg.fee)) {
      return;
    }
    if (msg.phase === 'racing') {
      let wave = waves.get(msg.waveId);
      if (!wave) {
        enterLobby({
          waveId: msg.waveId,
          by: msg.by,
          dur: 0,
          silent: true,
          walletType: msg.walletType,
          fee: msg.fee
        });
        wave = waves.get(msg.waveId);
      }
      if (msg.walletType && !wave.walletType) {
        wave.walletType = msg.walletType;
      }
      if (msg.fee && !wave.fee) {
        wave.fee = msg.fee;
      }
      if (msg.paid) {
        wave.startProof = msg.paid;
      }
      wave.paid = 'verified';
      // learn every participant's feed core (self-contained: the sync carries the writers,
      // so a mid-race newcomer doesn't depend on having seen the wave-joins)
      for (const cred of msg.writers || []) {
        ingestWriter(wave, cred);
      }
      beginSweep(wave, {
        rosterIds: canonicalRoster(msg.by, msg.writers),
        t0: msg.t0,
        lapMs: msg.lapMs
      });
      return;
    }
    let wave = waves.get(msg.waveId);
    if (!wave) {
      enterLobby({
        waveId: msg.waveId,
        by: msg.by,
        dur: msg.lobbyMsLeft,
        walletType: msg.walletType,
        fee: msg.fee
      });
      wave = waves.get(msg.waveId);
    }
    if (msg.walletType && !wave.walletType) {
      wave.walletType = msg.walletType;
    }
    if (msg.fee && !wave.fee) {
      wave.fee = msg.fee;
    }
    if (enforcePaid && msg.paid && !wave.startProof) {
      wave.startProof = msg.paid;
      verifyStartProof(msg.waveId, msg.paid);
    }
    for (const cred of msg.writers || []) {
      ingestWriter(wave, cred);
    }
    emitEvent({ event: 'roster', waveId: wave.id, count: rosterCount(wave) });
  }

  /**
   * A wave was announced (flooded) — open its lobby.
   * @param {Object} msg A wave-announce message.
   */
  function handleWaveAnnounce(msg) {
    // anti-spam: an enforced peer ignores any announce lacking a validly-signed start
    // proof (unpaid/spam waves are invisible). Then it verifies the burn on-chain.
    // (`origin` is the initiator — it signed both the envelope and the start burn.)
    if (enforcePaid && !validStartProof(msg.paid, msg.waveId, msg.origin)) {
      return;
    }
    if (!canAdopt(msg.waveId)) {
      return;
    }
    // local anti-sybil floor: ignore a wave whose initiator-set fee is below my minimum. (The
    // announce still relayed to the directory upstream — I just don't engage it myself.)
    if (belowFloor(msg.fee)) {
      return;
    }
    enterLobby({
      waveId: msg.waveId,
      by: msg.origin,
      dur: msg.lobbyMs,
      walletType: msg.walletType,
      fee: msg.fee
    });
    const wave = waves.get(msg.waveId);
    if (!wave) {
      return;
    }
    if (msg.walletType && !wave.walletType) {
      wave.walletType = msg.walletType;
    }
    if (msg.fee && !wave.fee) {
      wave.fee = msg.fee;
    }
    // remember the signed announce verbatim so I can catch up a peer that connects later (I
    // forward this exact frame — its `mid` dedups any re-flood within one hop)
    wave.announceMsg = msg;
    if (enforcePaid && msg.paid && !wave.startProof) {
      wave.startProof = msg.paid;
      verifyStartProof(msg.waveId, msg.paid);
    }
  }

  /**
   * A peer opted into a wave's lobby (flooded) — learn its feed core + count it into the
   * roster. Only DURING THE LOBBY: the roster freezes into the schedule at lobby close, so a
   * late join can't take a seat it can never fill. When enforcing, the join must present a
   * valid burn (paid gate — every peer checks, deterministically).
   * @param {Object} msg A wave-join message.
   */
  function handleWaveJoin(msg) {
    const wave = waves.get(msg.waveId);
    if (!wave || wave.phase !== 'lobby') {
      return;
    }
    // origin is the joiner (envelope); the burn + join attestation bind to it.
    if (enforcePaid && !burnAuthorizes(msg.burn, msg.origin, msg.waveId)) {
      return;
    }
    ingestWriter(wave, {
      peerId: msg.origin,
      writerKey: msg.writerKey,
      joinSig: msg.joinSig
    });
  }

  /**
   * The initiator finalized the roster and started the sweep (flooded). Gate on the same
   * start proof as the announce, so a forged wave-start can't conjure a race.
   * @param {Object} msg A wave-start message.
   */
  function handleWaveStart(msg) {
    // origin is the initiator — it signed the envelope and the start burn.
    if (enforcePaid && !validStartProof(msg.paid, msg.waveId, msg.origin)) {
      return;
    }
    if (!canAdopt(msg.waveId)) {
      return;
    }
    // local anti-sybil floor: don't adopt a race whose initiator-set fee is below my minimum.
    if (belowFloor(msg.fee)) {
      return;
    }
    let wave = waves.get(msg.waveId);
    if (!wave) {
      enterLobby({
        waveId: msg.waveId,
        by: msg.origin,
        walletType: msg.walletType,
        fee: msg.fee
      });
      wave = waves.get(msg.waveId);
    }
    if (msg.walletType && !wave.walletType) {
      wave.walletType = msg.walletType;
    }
    if (msg.fee && !wave.fee) {
      wave.fee = msg.fee;
    }
    if (msg.paid) {
      wave.startProof = msg.paid; // carry it so we can re-sync newcomers
    }
    // the flooded writers make wave-start self-contained: a peer adopting here (that missed
    // the wave-joins) still learns every participant's feed core
    for (const cred of msg.writers || []) {
      ingestWriter(wave, cred);
    }
    beginSweep(wave, {
      rosterIds: canonicalRoster(msg.origin, msg.writers),
      t0: msg.t0,
      lapMs: msg.lapMs
    });
  }

  /**
   * A roster member broadcast a note on a wave (flooded, roster-gated by the caller). Surface it to
   * the host as a `note` event; the app owns the opaque `note` payload's meaning.
   * @param {Object} msg A wave-note message (origin = the participant who sent it).
   */
  function handleWaveNote(msg) {
    emitEvent({
      event: 'note',
      waveId: msg.waveId,
      from: msg.origin,
      note: msg.note
    });
  }

  /**
   * A peer sent me a DIRECTED note (wave-dm), unicast over a direct connection. The envelope sig is
   * already verified and the identity rule (handleGossip) already forced sender==origin, so this is
   * an authenticated 1:1 message. Ignore it unless it's actually addressed to me (`to`), then surface
   * it as a `dm` event. No roster gate: a directed note may come from a non-participant (e.g. a
   * spectator tipping) — authenticity is the envelope, delivery is 1:1 + rate-limited, so it's bounded.
   * @param {Object} msg A wave-dm message (origin = the sender, to = me).
   */
  function handleDirectedNote(msg) {
    if (msg.to !== me.id) {
      return; // not addressed to me (misrouted) — drop
    }
    emitEvent({
      event: 'dm',
      waveId: msg.waveId,
      from: msg.origin,
      note: msg.note
    });
  }

  // --- gossip transport (one channel per connection; wave gossip scoped by subs) ----
  // Every message I ORIGINATE is sealed with the uniform envelope here (origin = me, ts = now,
  // sig by my ring key) — the single signing choke point. Relays forward the sealed frame
  // VERBATIM (no re-sign), so a flooded message's `origin`/`sig` stay the originator's across
  // every hop. `me` is always the origin at origination (a relay is not an origination).

  /**
   * Seal an outgoing message with the uniform envelope (origin/ts/sig) and return it.
   * @param {Object} msg The factory-built message (kind + payload; mid already set on flooded).
   * @returns {Object} The same object, now carrying origin + ts + sig.
   */
  function originate(msg) {
    msg.origin = me.id;
    msg.ts = Date.now();
    msg.sig = signMessage(swarm.keyPair, msg);
    return msg;
  }

  /**
   * Seal an outgoing FLOODED message: stamp a unique `mid` (remembered so it can't loop back into
   * me), then apply the envelope. `mid` is set before signing, so the signature covers it.
   * @param {Object} msg The factory-built flooded message.
   * @returns {Object} The sealed message (mid + origin + ts + sig).
   */
  function originateFlood(msg) {
    msg.mid = b4a.toString(crypto.randomBytes(8), 'hex');
    flood.firstSight(msg.mid);
    return originate(msg);
  }

  /**
   * JSON-encode + send an (already-sealed) message over every connection's gossip channel. Used
   * for the heartbeat + relaying / directory floods.
   * @param {Object} obj The sealed gossip message to broadcast.
   */
  function broadcast(obj) {
    const str = JSON.stringify(obj);
    for (const [, send] of table.senderEntries()) {
      try {
        send(str);
      } catch {}
    }
  }

  /**
   * Originate a DIRECTORY flood (a wave-announce): seal it (mid + envelope) and broadcast to every
   * neighbour. Receivers relay it (relayDir) across the mesh. Returns the sealed frame so the
   * initiator can store it for connect-time catch-up.
   * @param {Object} obj The message to flood.
   * @returns {Object} The sealed message.
   */
  function floodDir(obj) {
    const sealed = originateFlood(obj);
    broadcast(sealed);
    return sealed;
  }

  /**
   * Relay a directory flood to my other neighbours (all except the sender; dedup handles echoes).
   * @param {Object} msg The already-seen message to relay.
   * @param {string} fromId Hex id of the connection it arrived on (excluded).
   */
  function relayDir(msg, fromId) {
    const str = JSON.stringify(msg);
    for (const [id, send] of table.senderEntries()) {
      if (id === fromId) {
        continue;
      }
      try {
        send(str);
      } catch {}
    }
  }

  /**
   * Originate a SCOPED wave flood (wave-join / wave-start): stamp a mid and send only to neighbours
   * that told us (via `subs`) they're subscribed to this wave — so a peer never receives control
   * gossip for a wave it didn't subscribe to. Relayed on by relayWave.
   * @param {string} waveId The wave the message belongs to.
   * @param {Object} obj The message to flood.
   */
  function floodWave(waveId, obj) {
    const str = JSON.stringify(originateFlood(obj));
    for (const [id, send] of table.senderEntries()) {
      if (neighborSubs.get(id)?.has(waveId)) {
        try {
          send(str);
        } catch {}
      }
    }
  }

  /**
   * Relay a scoped wave flood to my other subscribed neighbours (all except the sender).
   * @param {string} waveId The wave the message belongs to.
   * @param {Object} msg The already-seen message to relay.
   * @param {string} fromId Hex id of the connection it arrived on (excluded).
   */
  function relayWave(waveId, msg, fromId) {
    const str = JSON.stringify(msg);
    for (const [id, send] of table.senderEntries()) {
      if (id === fromId) {
        continue;
      }
      if (neighborSubs.get(id)?.has(waveId)) {
        try {
          send(str);
        } catch {}
      }
    }
  }

  /** Tell every neighbour my current subscription set (on connect + on subscribe/unsubscribe). */
  function broadcastSubs() {
    broadcast(originate(makeSubs({ subs: [...subscriptions] })));
  }

  /**
   * Unicast a wave-sync (the self-contained catch-up snapshot: phase / writers / sweep timing /
   * paid proof) to one neighbour for one wave. Sent when we learn a neighbour is mutually
   * subscribed — so late joins + missed floods are always recovered by a sync.
   * @param {string} toId The neighbour's connection id.
   * @param {string} waveId The wave to catch it up on.
   */
  function syncPeer(toId, waveId) {
    const send = table.senderOf(toId);
    const wave = waves.get(waveId);
    if (!send || !wave) {
      return;
    }
    send(
      JSON.stringify(
        originate(
          makeWaveSync({
            waveId: wave.id,
            phase: wave.phase,
            by: wave.by,
            writers: [...wave.writers.entries()].map(([peerId, cred]) => ({
              peerId,
              writerKey: cred.writerKey,
              joinSig: cred.joinSig
            })),
            t0: wave.t0,
            lapMs: wave.lapMs,
            paid: wave.startProof,
            walletType: wave.walletType,
            fee: wave.fee,
            lobbyMsLeft:
              wave.phase === 'lobby'
                ? Math.max(0, wave.lobbyEndsAt - Date.now())
                : 0
          })
        )
      )
    );
  }

  /**
   * Unicast a DIRECTED note (wave-dm) to one peer. Sends over an existing direct channel if I have
   * one (the common case — roster peers share the wave sub-topic mesh); otherwise dials the peer
   * (swarm.joinPeer) and queues the note until the connection opens (onConnection flushes it). Not
   * flooded, so it never touches the mesh — only the recipient sees it. A no-op self-send is dropped.
   * @param {Object} fields
   * @param {string} fields.waveId The wave the note relates to (context).
   * @param {string} fields.to The recipient's ring id (hex Noise public key).
   * @param {Object} fields.note The opaque app payload (≤ MAX_NOTE_BYTES).
   * @returns {boolean} True if sent or queued for delivery; false if it couldn't be attempted.
   */
  function sendDirect({ waveId, to, note }) {
    if (!to || to === me.id) {
      return false; // no recipient / would be a self-send
    }
    const send = table.senderOf(to);
    if (send) {
      try {
        send(JSON.stringify(originate(makeDirectedNote({ waveId, to, note }))));
      } catch {}
      return true;
    }
    return dialForDm(to, { waveId, note });
  }

  /**
   * No direct channel to `to` yet: dial it (swarm.joinPeer) and queue the note; onConnection flushes
   * the queue when the connection opens. A per-peer cap bounds a stuck dial; a timeout drops the
   * queue (and stops dialing) if the peer never connects — an unreachable recipient.
   * @param {string} to The recipient's ring id (= its Noise public key, hex).
   * @param {{ waveId: string, note: Object }} entry The queued note.
   * @returns {boolean} True if queued for a dial.
   */
  function dialForDm(to, entry) {
    const queue = pendingDm.get(to) || [];
    if (queue.length >= DM_MAX_QUEUED) {
      queue.shift(); // drop the oldest — bound the backlog for a stuck dial
    }
    queue.push(entry);
    pendingDm.set(to, queue);
    if (!dmDialed.has(to)) {
      dmDialed.add(to);
      try {
        swarm.joinPeer(b4a.from(to, 'hex')); // directed dial (DHT lookup + hole-punch)
      } catch {}
      setTimeout(() => clearDmDial(to), DM_DIAL_TIMEOUT_MS);
    }
    return true;
  }

  /** Flush any queued directed notes to a peer that just connected (onConnection). */
  function flushPendingDm(id, send) {
    const queue = pendingDm.get(id);
    if (!queue) {
      return;
    }
    pendingDm.delete(id);
    for (const { waveId, note } of queue) {
      try {
        send(
          JSON.stringify(originate(makeDirectedNote({ waveId, to: id, note })))
        );
      } catch {}
    }
    clearDmDial(id); // delivered (or dropped) — stop holding the dial open
  }

  /** Drop a directed-dial's queue + leavePeer it (timeout, delivery, or close). */
  function clearDmDial(to) {
    pendingDm.delete(to);
    if (dmDialed.delete(to)) {
      try {
        swarm.leavePeer(b4a.from(to, 'hex'));
      } catch {}
    }
  }

  /**
   * The Hyperswarm sub-topic for a wave — its participants join it to discover each other directly,
   * off the O(N) directory mesh (a scale optimisation; small swarms are already fully connected).
   * @param {string} waveId The wave.
   * @returns {Buffer} The 32-byte topic key.
   */
  function subTopicKey(waveId) {
    return crypto.hash(b4a.from(WAVE_SUBTOPIC_PREFIX + topicId + ':' + waveId));
  }

  /**
   * Subscribe's transport half: join the wave's sub-topic (so its participants find me), announce
   * my updated subscription set, and proactively sync any neighbour I already know is subscribed.
   * @param {string} waveId The wave to engage on the wire.
   */
  function joinWaveTransport(waveId) {
    if (!subTopics.has(waveId)) {
      subTopics.add(waveId);
      swarm.join(subTopicKey(waveId), { server: true, client: true });
    }
    broadcastSubs();
    for (const [connId, subs] of neighborSubs) {
      if (subs.has(waveId)) {
        syncPeer(connId, waveId);
      }
    }
  }

  /**
   * Unsubscribe's transport half: leave the wave's sub-topic and announce my updated set.
   * @param {string} waveId The wave to disengage on the wire.
   */
  function leaveWaveTransport(waveId) {
    if (subTopics.has(waveId)) {
      subTopics.delete(waveId);
      swarm.leave(subTopicKey(waveId)).catch(() => {});
    }
    broadcastSubs();
  }

  // --- feed (multicore CRDT) ---------------------------------------------
  // The open/merge machinery lives in feed-crdt.js; wave.js drives it by
  // ingesting each participant's feed-core credential (from wave-join / wave-start /
  // wave-sync) — no shared feed key, no admission.

  /**
   * The canonical schedule input carried by a wave-start/wave-sync: the initiator plus every
   * flooded writer. Derived from the MESSAGE (not local state) so every receiver computes the
   * identical schedule even if it has ingested extra joins the initiator missed. The initiator is
   * `origin` on a wave-start (it originated it) but `by` on a wave-sync (which a subscriber sends).
   * @param {string} initiatorId The wave initiator's ring id.
   * @param {import('./messages').WriterCred[]} writers The flooded writer credentials.
   * @returns {string[]} The canonical participant ids.
   */
  function canonicalRoster(initiatorId, writers) {
    const ids = (writers || []).map((cred) => cred.peerId);
    return [initiatorId, ...ids];
  }

  /**
   * Remember `peerId` as a roster member of `waveId` (feed-lifetime, outlives the WaveState) — the
   * gate for the wave-note broadcast primitive. Freed with the cores (unsubscribe/close/closeWave).
   * @param {string} waveId The wave.
   * @param {string} peerId The participant's ring id.
   */
  function rememberRosterMember(waveId, peerId) {
    let roster = rosters.get(waveId);
    if (!roster) {
      roster = new Set();
      rosters.set(waveId, roster);
    }
    roster.add(peerId);
  }

  /**
   * Is `peerId` a known roster member of `waveId`? True for the whole time the wave's feed is held
   * (past the wave's end), so a tip note can be broadcast/relayed while the idle gallery is browsable.
   * @param {string} waveId The wave.
   * @param {string} peerId The candidate participant.
   * @returns {boolean} True if `peerId` is a roster member.
   */
  function isRosterMember(waveId, peerId) {
    return !!rosters.get(waveId)?.has(peerId);
  }

  // Learn a participant's feed core: verify its join attestation (binds peerId →
  // writerKey, so a relayed credential can't be forged or substituted), then count it
  // into the writers map (the roster) and open its core (feed-crdt.js). Idempotent; the
  // paid gate for direct wave-joins is enforced by the caller (wave-start/sync writers
  // carry no burn — the wave itself is gated by the start proof).
  /**
   * @param {Object} wave The WaveState to ingest into.
   * @param {Object} cred A feed-core credential.
   * @param {string} cred.peerId The participant's ring id.
   * @param {string} cred.writerKey The participant's feed core key (hex).
   * @param {string} cred.joinSig The join attestation over (waveId, peerId, writerKey).
   */
  function ingestWriter(wave, cred) {
    // shape is guaranteed upstream (messages.js validates wave-join fields and every
    // writers[] entry); only the signature and duplicate checks remain here
    if (!wave || wave.writers.has(cred.peerId)) {
      return;
    }
    // Roster cap: a wave seats at most MAX_ROSTER participants — a new joiner beyond that is
    // dropped (it spectates). This bounds `wave.writers`, so any wave-start/wave-sync this peer
    // floods stays within the wire cap. The sweep is unaffected (it derives from the authoritative
    // flooded wave-start, not this local set), so common waves (< cap) are byte-identical as before.
    if (wave.writers.size >= MAX_ROSTER) {
      return;
    }
    if (
      !verifyJoin(
        { waveId: wave.id, peerId: cred.peerId, writerKey: cred.writerKey },
        cred.joinSig
      )
    ) {
      return;
    }
    wave.writers.set(cred.peerId, {
      writerKey: cred.writerKey,
      joinSig: cred.joinSig
    });
    rememberRosterMember(wave.id, cred.peerId); // roster that outlives the WaveState (wave-note gate)
    // The writers map is cheap roster metadata (kept even when merely aware, so the browse count
    // is right and a later subscribe can open every core). Opening the participant's CORE — the
    // expensive, O(subscribed) part — happens only when subscribed.
    if (wave.subscribed) {
      session.addWriter(wave.id, cred.peerId, cred.writerKey);
    }
    emitEvent({ event: 'roster', waveId: wave.id, count: rosterCount(wave) });
  }

  // The worker reports a successful fee burn. Sign a burn attestation (ring key binds my
  // identity to the burn), stash it in the wave's EntryPipeline, and return it. Two
  // consumers: the initiator attaches its START proof to the wave-announce (the paid-wave
  // gate, announcePaid); a joiner's proof rides its wave-join (the per-peer paid gate) and
  // its feed entry (the tip-address binding).
  /**
   * @param {Object} fields The confirmed fee burn.
   * @param {string} fields.reason 'start' (initiator) or 'join' (participant).
   * @param {number} fields.amount Amount burned.
   * @param {string} fields.burnRef Burn reference (chain tx hash, ecash token, …).
   * @param {string} fields.waveId Wave the burn is for (threaded from payFee).
   * @returns {Object|null} The signed burn attestation, or null if that wave is no longer engaged.
   */
  function recordBurn({ reason, amount, burnRef, waveId }) {
    // The burn is for `waveId` (threaded from payFee). Its entry posts during the wave's own
    // sweep (postEntry captures the proof synchronously while the wave is still engaged), so a
    // proof landing after its wave ended is inert — the immutable block-0 entry already
    // appended (with or without it), and no new entry can post once the wave is gone.
    const wave = waveId ? waves.get(waveId) : null;
    if (!wave) {
      return null;
    }
    const fields = {
      waveId,
      peerId: me.id,
      reason,
      amount,
      burnRef,
      payerAddress: walletAddress || '',
      burnTs: Date.now()
    };
    const proof = { ...fields, sig: signBurn(swarm.keyPair, fields) };
    wave.pipeline.setBurnProof(proof);
    // My join fee just confirmed while the lobby is still open: re-flood my wave-join with
    // the burn attached — enforcing peers dropped the earlier burn-less join (per-peer paid
    // gate), so this flood is the one that actually seats me.
    if (reason === 'join' && wave.joined && wave.phase === 'lobby') {
      floodMyFeedCore(waveId);
    }
    return proof;
  }

  // --- wave lifecycle (idle -> lobby -> racing -> idle), per wave -------------

  /**
   * Accept this wave? Any wave that hasn't already finished can be adopted — concurrent
   * waves coexist (the old singleton's lower-waveId tie-break is gone). A finished wave never
   * comes back (endedWaves), so stale floods can't revive it.
   * @param {string} waveId Candidate wave id.
   * @returns {boolean} True if we should adopt/keep it.
   */
  function canAdopt(waveId) {
    return !endedWaves.has(waveId);
  }

  /**
   * Is a wave's initiator-set fee below my local anti-sybil floor? A wave I won't engage or join.
   * Only applies when I enforce payment (a wallet is wired) and I've set a floor; a fee-less wave
   * on the enforced path is treated as below any positive floor (the initiator must declare a fee
   * that clears it). With no floor / no wallet this is always false (accept any).
   * @param {number|undefined} fee The wave's announced fee.
   * @returns {boolean} True if the wave is below my floor and should be refused.
   */
  function belowFloor(fee) {
    if (!enforcePaid || !(minFee > 0)) {
      return false;
    }
    return !(typeof fee === 'number' && fee >= minFee);
  }

  /**
   * Clear one wave's lobby/sweep timers (it's ending or being torn down).
   * @param {Object} wave The WaveState whose timers to clear.
   */
  function teardownWave(wave) {
    clearTimeout(wave.lobbyTimer);
    clearTimeout(wave.waveTimer);
    for (const timer of wave.sweepTimers) {
      clearTimeout(timer);
    }
    wave.sweepTimers = [];
  }

  /**
   * Enter the lobby for `waveId` (announced by `by`; `mine` if I'm the initiator), creating
   * its WaveState. No-op if the wave is already engaged. `silent` skips the wave-announce UI
   * event (used when catching up straight into a race, so no bogus lobby countdown flashes).
   * @param {Object} opts The lobby to enter.
   * @param {string} opts.waveId The wave to enter a lobby for.
   * @param {string} opts.by Hex id of the initiator that announced it.
   * @param {boolean} [opts.mine] True if I'm the initiator.
   * @param {number} [opts.dur] Lobby duration in ms (defaults to lobbyMs).
   * @param {boolean} [opts.silent] Suppress the wave-announce UI event.
   * @param {string|null} [opts.walletType] The wave's payment-mechanism id (paid waves), so join() can gate on support.
   * @param {number|null} [opts.fee] The wave's initiator-set participation fee (paid waves), surfaced on the wave-announce event so a host can show the cost before opting in.
   */
  function enterLobby({
    waveId,
    by,
    mine = false,
    dur = lobbyMs,
    silent = false,
    walletType = null,
    fee = null
  }) {
    if (waves.has(waveId)) {
      return;
    }
    // paid: 'verified' when the start burn is confirmed (or enforcement is off); 'pending'
    // while a peer verifies it on-chain; 'rejected' if it isn't a real burn.
    const wave = {
      id: waveId,
      phase: 'lobby',
      by,
      joined: !!mine,
      // subscribed = I hold this wave's feed cores (open my own + the roster's, replicate,
      // render its gallery). Awareness alone (from a wave-announce) does NOT open cores.
      subscribed: false,
      paid: enforcePaid ? 'pending' : 'verified',
      startProof: null,
      joinSig: null, // MY join attestation (attest.js signJoin) — every feed entry carries it
      // peerId -> {writerKey, joinSig}: every participant's feed core. This IS the roster —
      // the single source of truth (a participant without a credential can't fill a sweep
      // slot, so counting anything else invents seats; two scale bugs came from exactly that
      // divergence).
      writers: new Map(),
      // The wave's payment-mechanism id (set on a paid wave — by me if I'm the initiator, else
      // learned from the announce/start/sync). join() blocks if I can't support it (§ join).
      walletType,
      // The wave's participation fee, SET BY THE INITIATOR (mine → myFee; else learned from the
      // announce/start/sync). Every joiner burns exactly this (payFee via feeFor), and verifiers
      // gate the start burn against it. A wave whose fee is below my local floor is refused upstream.
      fee,
      t0: undefined,
      lapMs: undefined,
      lobbyEndsAt: Date.now() + dur,
      lobbyTimer: null, // fires the sweep (initiator) or a fallback to idle (others)
      waveTimer: null, // the deterministic end of the sweep (t0 + lapMs + grace)
      sweepTimers: [], // my-slot + position timers for the running sweep
      announceMsg: null, // the sealed wave-announce (stored to catch up late-connecting peers)
      // Entry is captured up-front during the lobby (renderer stages it into the pipeline),
      // then posted to the feed when my sweep slot fires. The pipeline (entry.js) owns the
      // pairing/once-per-wave/burn-ticket invariants — one per wave, so concurrent waves each
      // stage + post independently.
      pipeline: new EntryPipeline({
        currentWaveId: () => (waves.has(waveId) ? waveId : null),
        post: (entry) => session.postEntry(entry)
      })
    };
    waves.set(waveId, wave);
    // Re-adopting a wave I joined, then abandoned on a revivable lobby-timeout (a late
    // wave-start re-opened it): restore my join state so my slot still arms + posts, and the
    // burn ticket so my entry keeps its tip-address binding.
    const memo = abandonedJoins.get(waveId);
    if (memo) {
      wave.joined = true;
      wave.joinSig = memo.joinSig;
      if (memo.burnProof) {
        wave.pipeline.setBurnProof(memo.burnProof);
      }
      abandonedJoins.delete(waveId);
    }
    // fallback: if the start never arrives (initiator vanished), drop back to idle
    wave.lobbyTimer = setTimeout(
      () => goIdle(waveId, 'lobby-timeout'),
      lobbyMs + 10000
    );
    // engage the feed (open my core + the roster's) only when subscribing — awareness alone
    // holds no cores (the core budget). Auto-subscribe (the default), the initiator (mine), and
    // a revived join all subscribe; an explicit-pick host stays merely aware until it chooses.
    if (autoSubscribe || wave.joined) {
      subscribe(waveId);
    }
    if (silent) {
      return;
    }
    emitEvent({
      event: 'wave-announce',
      waveId,
      by,
      mine: !!mine,
      joined: wave.joined,
      subscribed: wave.subscribed,
      count: rosterCount(wave),
      lobbyMs: dur,
      paid: wave.paid, // 'verified' (enforcement off / already paid) | 'pending' (verifying)
      walletType: wave.walletType, // the payment mechanism (null on an unpaid/wallet-less wave)
      fee: wave.fee // the initiator-set participation fee (null on an unpaid/wallet-less wave)
    });
  }

  /**
   * Subscribe to a wave: open its feed (my own core + every roster writer's core already known)
   * and, in Phase 3, join its sub-topic + open the per-wave gossip channel so I receive its
   * control gossip. Idempotent. This is what actually spends a core budget slot — an un-subscribed
   * (merely aware) peer holds no cores.
   * @param {string} waveId The wave to subscribe to.
   * @returns {string|null} The waveId, or null if unknown.
   */
  function subscribe(waveId) {
    const wave = waves.get(waveId);
    if (!wave) {
      return null;
    }
    if (subscriptions.has(waveId)) {
      return wave.id;
    }
    subscriptions.add(waveId);
    wave.subscribed = true;
    // open my own core for this wave (fire-and-forget; the writer key is awaited where needed)
    session.open(waveId).catch(() => {});
    // open every roster writer's core I already learned while merely aware
    for (const [peerId, cred] of wave.writers) {
      session.addWriter(waveId, peerId, cred.writerKey);
    }
    joinWaveTransport(waveId); // Phase 3: sub-topic + per-wave channels (no-op pre-Phase-3)
    emitEvent({ event: 'subscribed', waveId, joined: wave.joined });
    return wave.id;
  }

  /**
   * Unsubscribe from a wave: close its feed (free its cores) and, in Phase 3, leave its sub-topic
   * + drop its gossip channels. The peer stays AWARE (its WaveState/roster survive for the browse
   * list) but no longer replicates. Un-joins too — you can't post without holding your core.
   * @param {string} waveId The wave to unsubscribe from.
   */
  function unsubscribe(waveId) {
    if (!subscriptions.has(waveId)) {
      return;
    }
    subscriptions.delete(waveId);
    const wave = waves.get(waveId); // may be gone (ended) — the feed still needs freeing
    if (wave) {
      wave.subscribed = false;
      wave.joined = false;
    }
    leaveWaveTransport(waveId); // Phase 3: leave sub-topic + close per-wave channels
    session.closeWave(waveId).catch(() => {});
    rosters.delete(waveId); // free the wave-note roster with the feed cores
    emitEvent({ event: 'unsubscribed', waveId });
  }

  /**
   * Opt in to a lobby (renderer command / harness): the given wave, or the newest joinable
   * one when no waveId is supplied (concurrent waves — the host picks, or takes the default).
   * @param {string} [waveId] The wave to join (default: newest joinable lobby).
   * @returns {string|null} The joined waveId (so the worker can charge the join fee on a real
   *   opt-in), or null if it was a no-op.
   */
  function join(waveId) {
    const wave = waveId ? waves.get(waveId) : newestJoinableLobby();
    if (!wave || wave.phase !== 'lobby' || wave.joined) {
      return null;
    }
    // payment-mechanism support gate: a PAID wave declares its `walletType`; I can only join (and
    // pay the fee) if my own wallet is of that type. A wrong type OR no wallet (myWalletType null)
    // means I can't pay — so I don't join (I can still spectate/subscribe, which is free).
    if (wave.walletType && wave.walletType !== myWalletType) {
      emitEvent({
        event: 'join-blocked',
        waveId: wave.id,
        reason: 'wallet-unsupported',
        walletType: wave.walletType
      });
      return null;
    }
    // anti-spam: never join (and pay) a wave whose start fee isn't proven paid
    if (wave.paid !== 'verified') {
      emitEvent({ event: 'join-blocked', waveId: wave.id, reason: wave.paid });
      return null;
    }
    // roster cap: the wave is full — I can subscribe/spectate (free) but can't take a seat, so I
    // refuse the join up front (rather than pay a fee and then be dropped at ingest). Bounded waves
    // are the scale model (scaling.md) — join a different wave, or spectate this one.
    if (!wave.writers.has(me.id) && wave.writers.size >= MAX_ROSTER) {
      emitEvent({
        event: 'join-blocked',
        waveId: wave.id,
        reason: 'roster-full'
      });
      return null;
    }
    subscribe(wave.id); // participating implies holding the feed (idempotent)
    wave.joined = true;
    floodMyFeedCore(wave.id);
    emitEvent({ event: 'joined', waveId: wave.id, count: rosterCount(wave) });
    return wave.id;
  }

  /**
   * Stage my opaque entry payload for a wave (the given one, or the newest I've joined) — it's
   * posted to that wave's feed when my sweep slot fires.
   * @param {Object} [input] The staged entry.
   * @param {*} [input.payload] Opaque application content (arbitrary JSON the host owns).
   * @param {string} [input.waveId] The wave to stage for (default: newest joined).
   */
  function stageEntry(input = {}) {
    const wave = input.waveId ? waves.get(input.waveId) : newestJoinedWave();
    if (!wave) {
      return;
    }
    wave.pipeline.stage(input);
  }

  /**
   * Broadcast an opaque `note` on a wave (a roster-member announcement — the app owns its meaning;
   * a tip announcement is the first use). Floods to the wave's subscribers, but ONLY if I'm a
   * credentialed participant of it (in wave.writers) — the same gate every relayer re-checks on
   * receipt (handleGossip), so a non-participant can't announce. No-op otherwise.
   * @param {Object} input The note to broadcast.
   * @param {string} input.waveId The wave to broadcast on.
   * @param {Object} input.note Opaque app payload (≤ MAX_NOTE_BYTES; rejected by the receive edge if larger).
   * @returns {boolean} True if broadcast, false if I'm not a roster member of that wave.
   */
  function broadcastNote({ waveId, note }) {
    // Gate on the feed-lifetime roster, so a tip can be announced post-wave (browsing the idle
    // gallery — the common case). floodWave scopes to subscribed neighbours, independent of the FSM.
    if (!waveId || !isRosterMember(waveId, me.id)) {
      return false; // I'm not a participant of this wave — I can't broadcast on it
    }
    floodWave(waveId, makeWaveNote({ waveId, note }));
    return true;
  }

  /**
   * Publish MY feed core for `waveId`: open it (its key is my writer key), sign my join
   * attestation over it, remember myself in `writers`, and flood a wave-join carrying
   * (writerKey, joinSig, burn). Every peer ingests it → opens my core → sees my entry. The
   * core key needs my core ready, so the flood is async. Called by joiners (from join()) and
   * the initiator (from doAnnounce); recordBurn re-floods once a late join burn confirms.
   * @param {string} waveId The wave whose core to publish.
   */
  function floodMyFeedCore(waveId) {
    session
      .open(waveId)
      .then((writerKey) => {
        const wave = waves.get(waveId);
        if (!wave || !wave.joined || !writerKey) {
          return;
        }
        if (!wave.joinSig) {
          wave.joinSig = signJoin(swarm.keyPair, { waveId, writerKey });
        }
        // roster cap belt-and-suspenders: never push my own seat past MAX_ROSTER (join() already
        // refuses a full roster; this guards a race where the cap filled between join and here).
        if (!wave.writers.has(me.id) && wave.writers.size >= MAX_ROSTER) {
          return;
        }
        // remember myself so my own wave-sync shares my core with newcomers
        wave.writers.set(me.id, { writerKey, joinSig: wave.joinSig });
        rememberRosterMember(waveId, me.id); // roster survives the WaveState (wave-note gate)
        floodWave(
          waveId,
          makeWaveJoin({
            waveId,
            writerKey,
            joinSig: wave.joinSig,
            burn: wave.pipeline.burnProof
          })
        );
      })
      .catch(() => {});
  }

  /**
   * Transition a wave from lobby to the racing sweep: derive the schedule from the CANONICAL
   * roster (the ids flooded on wave-start — every peer must compute the identical schedule),
   * arm my slot + the position ticker + the deterministic end. Receiver-side clamps stop a
   * hostile start from wedging a wave open.
   * @param {Object} wave The WaveState to race.
   * @param {Object} opts The sweep parameters (from wave-start / wave-sync / my own start).
   * @param {string[]} opts.rosterIds The canonical roster ids.
   * @param {number} opts.t0 Epoch ms the sweep starts.
   * @param {number} opts.lapMs Duration of the full lap.
   */
  function beginSweep(wave, { rosterIds, t0, lapMs }) {
    if (!wave || wave.phase === 'racing') {
      return;
    }
    if (!Number.isFinite(t0) || !Number.isFinite(lapMs) || lapMs <= 0) {
      return;
    }
    if (t0 - Date.now() > MAX_LAP_MS) {
      return; // a start scheduled absurdly far out is bogus — ignore it
    }
    if (!rosterIds || !rosterIds.length) {
      return; // callers always supply the canonical roster; an empty one is bogus
    }
    const cappedLapMs = Math.min(lapMs, MAX_LAP_MS);
    wave.phase = 'racing';
    wave.t0 = t0;
    wave.lapMs = cappedLapMs;
    const schedule = sweepSchedule({ rosterIds, t0, lapMs: cappedLapMs });
    clearTimeout(wave.lobbyTimer);
    armSweepTimers(wave, schedule);
    // the deterministic end: EVERY peer observes t0 + lap + grace locally — there is
    // no wave-end message (nothing to trust, nothing to lose in the mesh)
    clearTimeout(wave.waveTimer);
    const waveId = wave.id;
    wave.waveTimer = setTimeout(
      () => finishWave(waveId, { hops: schedule.length }),
      Math.max(0, t0 + cappedLapMs + END_GRACE_MS - Date.now())
    );
    emitEvent({
      event: 'wave-active',
      waveId: wave.id,
      joined: wave.joined,
      count: schedule.length
    });
  }

  /**
   * Arm a wave's running sweep timers: my own slot (records it into the wave's entry pipeline
   * — pairing with the staged lobby frame posts the feed entry — and tells the renderer I'm
   * holding) and the position ticker (every screen walks the schedule locally and emits
   * `position` events — there is no wave-pos gossip; already-past slots flush at once so a
   * mid-race joiner catches up). Each timer bails if the wave was torn down (checked by
   * identity against the live map, so a superseded/ended wave's timers no-op).
   * @param {Object} wave The WaveState being raced.
   * @param {import('./sweep').SweepSlot[]} schedule The derived sweep schedule.
   */
  function armSweepTimers(wave, schedule) {
    const waveId = wave.id;
    const mine = mySlot(schedule, me.id);
    if (mine && wave.joined) {
      const slotTimer = setTimeout(
        () => {
          if (waves.get(waveId) !== wave) {
            return;
          }
          wave.pipeline.recordSlot({ waveId, hopCount: mine.rank });
          emitEvent({
            event: 'holding',
            waveId,
            hopCount: mine.rank,
            holder: me.id,
            angle: me.angle
          });
        },
        Math.max(0, mine.at - Date.now())
      );
      wave.sweepTimers.push(slotTimer);
    }
    let index = 0;
    const tick = () => {
      if (waves.get(waveId) !== wave) {
        return;
      }
      const now = Date.now();
      while (index < schedule.length && schedule[index].at <= now) {
        const slot = schedule[index];
        emitEvent({
          event: 'position',
          waveId,
          holder: slot.id,
          angle: slot.angle,
          hopCount: slot.rank
        });
        index++;
      }
      if (index >= schedule.length) {
        return;
      }
      wave.sweepTimers.push(
        setTimeout(tick, Math.max(0, schedule[index].at - now))
      );
    };
    tick();
  }

  // Idle reasons that must NOT blacklist the waveId: a lobby-timeout means "I gave up
  // waiting for wave-start", not "the wave ended" — at scale the initiator's start can
  // arrive after a receiver's fallback fired (measured at N=128: a slow pre-flood step
  // once delayed the start past every receiver's 30s lobby fallback, and the blacklist
  // made the whole swarm unrecoverable). A late wave-start (or sync) simply re-adopts
  // the wave. Genuine ends (completed, unpaid-rejected, superseded) still blacklist, so
  // stale floods can't revive a finished wave.
  const REVIVABLE_IDLE_REASONS = new Set(['lobby-timeout']);

  /**
   * Return a wave to idle: mark it ended (unless the reason is revivable), clear its timers,
   * drop its WaveState, and notify the UI. Its feed is left open (the post-race idle gallery /
   * latecomer replication rely on it) — feeds are freed on close().
   * @param {string} waveId The wave to idle.
   * @param {string} reason Why we went idle (lobby-timeout, ended, unpaid…).
   */
  function goIdle(waveId, reason) {
    const wave = waves.get(waveId);
    if (!wave) {
      return;
    }
    if (!REVIVABLE_IDLE_REASONS.has(reason)) {
      endedWaves.add(waveId);
      abandonedJoins.delete(waveId);
    } else if (wave.joined) {
      // remember my join state (+ burn ticket) so a late wave-start can revive my seat
      abandonedJoins.set(waveId, {
        joinSig: wave.joinSig,
        burnProof: wave.pipeline.burnProof
      });
    }
    teardownWave(wave);
    waves.delete(waveId);
    emitEvent({ event: 'wave-idle', waveId, reason });
  }

  /**
   * Finish a wave: emit the outcome to the UI and return it to idle. Fired by that wave's own
   * deterministic end timer (t0 + lapMs + grace) — completion needs no message and no trust.
   * @param {string} waveId The wave that finished.
   * @param {Object} [outcome]
   * @param {number} [outcome.hops] How many roster slots the sweep covered.
   */
  function finishWave(waveId, { hops = 0 } = {}) {
    const wave = waves.get(waveId);
    if (!wave) {
      return;
    }
    emitEvent({
      event: 'completed',
      waveId,
      hops,
      angle: angleOfId(wave.by)
    });
    goIdle(waveId, 'ended');
  }

  /**
   * A wave's roster size for display: its credentialed participants plus the initiator
   * (counted once — its own credential lands async).
   * @param {Object} wave The WaveState.
   * @returns {number} How many peers hold (or are guaranteed) a sweep slot.
   */
  function rosterCount(wave) {
    if (!wave) {
      return 0;
    }
    return wave.writers.size + (wave.writers.has(wave.by) ? 0 : 1);
  }

  /**
   * Announce a new wave and open its lobby. Concurrent waves are allowed (any peer can start
   * at any time — no singleton). At lobby close the initiator freezes the roster and starts
   * the sweep.
   * @returns {string} The new waveId.
   */
  function startWave() {
    const waveId = b4a.toString(crypto.randomBytes(16), 'hex');
    // initiator auto-joins (marks its own lobby); my wallet type + fee (if any) ride the wave — as
    // the initiator I SET the participation fee every joiner burns (myFee = my wallet's fee).
    enterLobby({
      waveId,
      by: me.id,
      mine: true,
      walletType: myWalletType,
      fee: myFee
    });
    if (enforcePaid) {
      // Anti-spam: don't announce yet. Wait for the worker to burn the start fee and prove it
      // (announcePaid). Fall back to idle if that never happens.
      const wave = waves.get(waveId);
      log('wave', shortId(waveId), '— awaiting start payment');
      clearTimeout(wave.lobbyTimer);
      wave.lobbyTimer = setTimeout(
        () => goIdle(waveId, 'unpaid'),
        PAY_TIMEOUT_MS
      );
      emitEvent({ event: 'paying', waveId });
    } else {
      // no-wallet path (tests/headless): announce immediately, unpaid
      doAnnounce(waveId, null);
    }
    return waveId;
  }

  /**
   * Flood a wave's wave-announce (carrying the start `paid` proof when present), publish the
   * initiator's own feed core (floodMyFeedCore), and start its lobby→sweep timer. There is no
   * shared feed key — each participant contributes its own self-certified core. Shared by the
   * paid and unpaid paths.
   * @param {string} waveId The wave being announced.
   * @param {Object|null} paidProof The signed start burn proof, or null (unpaid path).
   */
  function doAnnounce(waveId, paidProof) {
    const wave = waves.get(waveId);
    if (!wave) {
      return;
    }
    log('announcing wave', shortId(waveId), paidProof ? '(paid)' : '');
    // the announce rides the DIRECTORY (every peer sees it → the browse surface); the initiator's
    // own feed core rides the wave sub-topic channel (floodMyFeedCore → floodWave). Store the
    // sealed announce so I can catch up peers that connect later (I forward this exact frame).
    wave.announceMsg = floodDir(
      makeWaveAnnounce({
        waveId,
        lobbyMs,
        paid: paidProof,
        walletType: wave.walletType,
        fee: wave.fee
      })
    );
    floodMyFeedCore(waveId); // the initiator is a participant too — share its core
    clearTimeout(wave.lobbyTimer);
    wave.lobbyTimer = setTimeout(() => finalizeAndStart(waveId), lobbyMs);
  }

  /**
   * The worker proved a wave's start burn (after it confirmed on-chain) — attach the proof
   * and NOW announce. Routed to the proof's own waveId. The initiator trusts its own confirmed
   * burn (paid = 'verified').
   * @param {Object} proof The signed start burn attestation (carries its waveId).
   */
  function announcePaid(proof) {
    const wave = proof ? waves.get(proof.waveId) : null;
    if (!wave || wave.phase !== 'lobby' || !enforcePaid) {
      return;
    }
    if (!validStartProof(proof, wave.id, me.id)) {
      return;
    }
    wave.startProof = proof;
    wave.paid = 'verified';
    doAnnounce(wave.id, proof);
    emitEvent({ event: 'wave-verified', waveId: wave.id, mine: true });
  }

  /**
   * A start proof is structurally valid: signed (Ed25519) by the initiator over a start burn for
   * this wave, AND recent (the signed `burnTs` is within MAX_KICKOFF_AGE_MS). The freshness bound
   * is replay-attack prevention: a captured, still-validly-signed announce reusing an old burn is
   * rejected — the burnTs is part of the signed burn tuple, so it can't be back-dated without the
   * initiator's key. (On-chain reality is checked separately, async.)
   * @param {Object} proof The start burn attestation to check.
   * @param {string} waveId The wave it must name.
   * @param {string} byId Hex id of the initiator it must be signed by.
   * @returns {boolean} True if structurally valid, correctly signed, and fresh.
   */
  function validStartProof(proof, waveId, byId) {
    return startProofValid({
      proof,
      waveId,
      byId,
      now: Date.now(),
      maxAgeMs: MAX_KICKOFF_AGE_MS + CLOCK_SKEW_MS
    });
  }

  /**
   * Verify a wave's start burn with the payment mechanism, then settle wave.paid. Abandons the
   * wave if the burn isn't real (anti-spam). No-op if enforcement is off or no verifier is wired.
   * A TRANSIENT verifier failure (`res.transient` — e.g. the initiator's FOREIGN Cashu mint was
   * momentarily unreachable) is RETRIED with backoff rather than rejected, so a foreign-mint blip
   * doesn't permanently kill an honest cross-mint wave. Fails closed: the wave stays `pending`
   * (never joined/paid) until a definitive result, so a stuck verify gives an attacker nothing.
   * @param {string} waveId The wave whose start burn to verify.
   * @param {Object} proof The start burn attestation (carries burnRef / payerAddress / amount).
   * @param {number} [attempt] Retry counter (internal — grows on transient failures).
   */
  function verifyStartProof(waveId, proof, attempt = 0) {
    if (!enforcePaid || !verifyBurnOnChain) {
      return;
    }
    const wave = waves.get(waveId);
    if (!wave || wave.phase !== 'lobby') {
      return; // the wave ended/started before this (retried) async verify could run
    }
    // Enforce the initiator's ANNOUNCED fee as the settled minimum: the start burn must really be
    // ≥ the fee the wave advertises (catches an initiator that announces a high fee but underpays).
    // Fall back to the proof's own claimed amount when no fee was announced (older/unpaid-shape).
    const minAmount = wave.fee || proof.amount;
    verifyBurnOnChain(proof.burnRef, {
      waveId,
      from: proof.payerAddress,
      minAmount
    })
      .then((res) => {
        const wave = waves.get(waveId);
        if (!wave || wave.phase !== 'lobby') {
          return;
        }
        if (res && res.ok) {
          wave.paid = 'verified';
          emitEvent({ event: 'wave-verified', waveId });
          return;
        }
        // Transient (couldn't reach/decode the initiator's mint) → retry with linear backoff,
        // keeping the wave pending. Only a DEFINITIVE invalid burn (bad structure / spent /
        // wrong memo / amount too low) is rejected.
        if (res && res.transient && attempt < VERIFY_MAX_RETRIES) {
          setTimeout(
            () => verifyStartProof(waveId, proof, attempt + 1),
            VERIFY_RETRY_MS * (attempt + 1)
          );
          return;
        }
        wave.paid = 'rejected';
        emitEvent({
          event: 'wave-unpaid',
          waveId,
          reason: res && res.reason
        });
        goIdle(waveId, 'unpaid-rejected');
      })
      .catch(() => {});
  }

  /**
   * Lobby closed: freeze the wave's roster + writers and flood wave-start with them and the
   * sweep parameters, then begin the sweep. The wave-start is self-contained — its `writers`
   * carry every participant's feed-core credential, so a peer adopting via wave-start (that
   * missed the wave-joins) still learns every core.
   * @param {string} waveId The wave to finalize and start.
   */
  function finalizeAndStart(waveId) {
    const wave = waves.get(waveId);
    if (!wave || wave.phase !== 'lobby') {
      return;
    }
    // safety net: make sure my own credential is in `writers` (floodMyFeedCore set it at
    // announce, but the async open may have raced the lobby close)
    const myWriterKey = session.writerKeyFor(waveId);
    if (!wave.joinSig && myWriterKey) {
      wave.joinSig = signJoin(swarm.keyPair, {
        waveId,
        writerKey: myWriterKey
      });
    }
    if (myWriterKey && !wave.writers.has(me.id)) {
      wave.writers.set(me.id, {
        writerKey: myWriterKey,
        joinSig: wave.joinSig
      });
    }
    // the sweep parameters: a short lead so the flooded start reaches everyone before the
    // first slot, and a lap scaled to the roster (clamped — see the constants)
    const rosterIds = [...new Set([me.id, ...wave.writers.keys()])];
    const t0 = Date.now() + SWEEP_LEAD_MS;
    const lapMs = Math.max(
      MIN_LAP_MS,
      Math.min(MAX_LAP_MS, rosterIds.length * SLOT_MS)
    );
    const writers = [...wave.writers.entries()].map(([peerId, cred]) => ({
      peerId,
      writerKey: cred.writerKey,
      joinSig: cred.joinSig
    }));
    log('starting wave', shortId(waveId), 'writers', writers.length);
    floodWave(
      waveId,
      makeWaveStart({
        waveId,
        writers,
        t0,
        lapMs,
        paid: wave.startProof, // so peers adopting via start can re-sync newcomers
        walletType: wave.walletType,
        fee: wave.fee
      })
    );
    emitEvent({ event: 'started', waveId, by: me.id });
    beginSweep(wave, { rosterIds, t0, lapMs });
  }

  // --- connections -----------------------------------------------------------
  // One Protomux gossip channel per connection carries every kind (heartbeat / subs / wave-*), plus
  // Corestore feed-core replication. A connection may be shared across the directory topic and
  // several wave sub-topics (Hyperswarm dedups by remote key) — same one stream. `channels` tracks
  // our gossip channels so a shared-swarm close() can tear them down without destroying the swarm.
  const channels = new Set();

  /**
   * Handle a new Hyperswarm connection: wire the gossip channel + feed replication, greet, and seat.
   * @param {Object} conn The Noise duplex stream from Hyperswarm.
   */
  function onConnection(conn) {
    // Transport per-message cap (secret-stream patch): set BEFORE replication/data flows, and only
    // on a swarm we own — the cap applies to every message on the stream (gossip + replication), and
    // a host-supplied swarm may carry the host's own larger-message protocols (its cap to set, not
    // ours). The patched secret-stream reads this property per message, so setting it here (before
    // any data event) takes effect for this connection. Guarded so an unpatched/renamed property is
    // a harmless no-op rather than a crash.
    if (ownsSwarm && maxMessageSize > 0 && 'maxMessageSize' in conn) {
      conn.maxMessageSize = maxMessageSize;
    }
    store.replicate(conn); // carries the gossip mux + feed-core replication

    const id = b4a.toString(conn.remotePublicKey, 'hex');
    log('peer connected', shortId(id));

    // This connection's own token bucket: caps how fast this peer can make us parse + verify. The
    // check runs FIRST (before JSON.parse + verifyMessage), so over-budget junk is dropped cheaply.
    const limiter = new RateLimiter({
      capacity: GOSSIP_BURST,
      refillPerSec: GOSSIP_RATE_PER_SEC,
      now: Date.now()
    });
    let throttleLogged = false;

    const mux = Protomux.from(conn);
    const channel = mux.createChannel({ protocol: GOSSIP_PROTOCOL });
    const message = channel.addMessage({
      encoding: cenc.string,
      onmessage(str) {
        // Frame-size cap: no legitimate gossip frame approaches this (the roster cap bounds the
        // largest, wave-start, to ~77 KB; MAX_FRAME_BYTES is 256 KB), so an over-cap frame is
        // hostile/corrupt — DESTROY the connection rather than merely drop this one. We can't
        // prevent the single big allocation (the transport, @hyperswarm/secret-stream, reassembles a
        // message from its own 3-byte length prefix — up to ~16 MB — before this callback runs, and
        // exposes no lower cap), but disconnecting stops a peer SUSTAINING it: reconnection is gated
        // by the peer-table churn cooldown + the DHT. This guards the gossip channel; replication
        // rides its own protomux channel and is bounded by Hypercore + the transport ceiling (§11.3).
        // `.length` is UTF-16 units — gossip is ASCII (hex + JSON; tags ≤8 chars), so it tracks bytes.
        if (str.length > MAX_FRAME_BYTES) {
          log(
            'peer sent an oversized gossip frame — disconnecting',
            shortId(id)
          );
          conn.destroy();
          return;
        }
        if (!limiter.allow(Date.now())) {
          if (!throttleLogged) {
            throttleLogged = true;
            log('peer over gossip rate — throttling', shortId(id));
          }
          return; // over budget: drop before the parse + signature verify
        }
        throttleLogged = false;
        let msg;
        try {
          msg = JSON.parse(str);
        } catch {
          return;
        }
        handleGossip(msg, id);
      }
    });
    channel.open();
    channels.add(channel);

    const send = (str) => message.send(str);
    table.onConnect(id, send); // lift any churn cooldown, seat it, remember the channel
    flushPendingDm(id, send); // deliver any directed notes queued while we dialed this peer

    // greet: my heartbeat (liveness + tag) so the newcomer seats me, and my subscription set so it
    // knows which waves' control gossip to forward here (Phase 3 scoping). Both are sealed
    // (origin/ts/sig) like every message.
    send(JSON.stringify(originate(myHeartbeat())));
    send(JSON.stringify(originate(makeSubs({ subs: [...subscriptions] }))));

    // Directory catch-up: a fresh announce floods ONCE, so a peer connecting later would miss waves
    // already announced. Forward the INITIATOR's stored, signed announce VERBATIM for every wave I
    // know, so the newcomer can browse + subscribe. It re-verifies the initiator's envelope sig and,
    // if it relays the frame on, the original `mid` dedups it within one hop (no amplification, no
    // separate catch-up message kind). If we both then subscribe, our `subs` cross and we sync each
    // other (recordNeighborSubs → syncPeer).
    for (const wave of waves.values()) {
      if (wave.announceMsg) {
        send(JSON.stringify(wave.announceMsg));
      }
    }
    pushRingState();

    conn.on('close', () => {
      // authoritative disconnect: drop the seat + its subscription record immediately
      table.onDisconnect(id);
      neighborSubs.delete(id);
      channels.delete(channel);
      log('peer disconnected', shortId(id));
      pushRingState();
    });
    conn.on('error', () => {});
  }
  swarm.on('connection', onConnection);

  // Every time Hyperswarm learns of or drops peers on the topic, repaint (the
  // `discovered` count feeds host start-gating).
  swarm.on('update', pushRingState);

  const topic = crypto.hash(b4a.from(topicId));
  const discovery = swarm.join(topic, { server: true, client: true });
  discovery.flushed().then(() => {
    log(
      'joined directory topic',
      topicId,
      'topic',
      shortId(b4a.toString(topic, 'hex')),
      'as',
      shortId(me.id)
    );
    pushRingState(); // initial repaint once the topic announce/lookup has flushed
  });

  // --- timers ----------------------------------------------------------------
  // All periodic work is a self-rescheduling setTimeout (CLAUDE.md Code Style: no setInterval):
  // each tick re-arms itself as its last step, so a slow tick delays the next instead of stacking.
  let tHeartbeat = null; // heartbeat timer
  let tRing = null; // ring-maintenance timer

  /** Heartbeat tick: broadcast my (sealed) liveness to every neighbour, then re-arm. */
  function heartbeatTick() {
    broadcast(originate(myHeartbeat()));
    tHeartbeat = setTimeout(heartbeatTick, HEARTBEAT_MS);
  }
  tHeartbeat = setTimeout(heartbeatTick, HEARTBEAT_MS);

  /** Maintenance tick: prune stale seats, pull feed updates (every held wave), then re-arm. */
  function ringTick() {
    pushRingState(); // re-evaluate staleness pruning
    // Pull replicated feed writes for every feed held and repaint.
    session.tick();
    tRing = setTimeout(ringTick, RINGUPDATE_MS);
  }
  tRing = setTimeout(ringTick, RINGUPDATE_MS);

  return {
    me,
    startWave,
    subscribe,
    unsubscribe,
    join,
    setTag,
    stageEntry,
    note: broadcastNote,
    dm: sendDirect, // unicast a directed note to one peer (private counterpart of note)
    // Wire the payment layer once the wallet is up: my address (for feed tips / attestations), the
    // on-chain burn verifier (enables the paid-wave anti-spam gate), and my wallet TYPE (rides my
    // waves' announces so joiners can decide whether they support the payment mechanism).
    setWallet: (address, verifier, walletType, fee) => {
      walletAddress = address || null;
      myWalletType = walletType || null;
      myFee = typeof fee === 'number' ? fee : null;
      if (verifier) {
        verifyBurnOnChain = verifier;
        enforcePaid = true;
      }
    },
    // The initiator-set fee a wave requires (announced), for the host's fee flow (payFee burns
    // exactly this). Null for a wave with no announced fee (unpaid/wallet-less path).
    feeFor: (waveId) => {
      const wave = waves.get(waveId);
      return wave && typeof wave.fee === 'number' ? wave.fee : null;
    },
    announcePaid, // initiator: attach the confirmed start proof + announce the wave
    recordBurn, // sign a fee-burn attestation (the start proof for the paid-wave gate)
    async close() {
      clearTimeout(tHeartbeat);
      clearTimeout(tRing);
      for (const wave of waves.values()) {
        teardownWave(wave);
      }
      rosters.clear();
      // close our gossip channels (they ride the connections; harmless if the conn is going away)
      for (const channel of channels) {
        try {
          channel.close();
        } catch {}
      }
      channels.clear();
      // Release any directed-note dials (swarm.joinPeer) we opened but never resolved.
      for (const to of [...dmDialed]) {
        try {
          swarm.leavePeer(b4a.from(to, 'hex'));
        } catch {}
      }
      dmDialed.clear();
      pendingDm.clear();
      if (ownsSwarm) {
        await swarm.destroy(); // we made it → tear it down (closes every connection)
      } else {
        // a host-owned swarm: leave only the topics we joined + detach our listeners; never destroy
        // it (the host owns its lifecycle + its other topics/connections).
        swarm.off('connection', onConnection);
        swarm.off('update', pushRingState);
        await swarm.leave(topic).catch(() => {});
        for (const waveId of subTopics) {
          await swarm.leave(subTopicKey(waveId)).catch(() => {});
        }
      }
      await session.close();
      await store.close();
    }
  };
}

module.exports = { createWave, parseBootstrap, loadOrCreateSwarmSeed };
