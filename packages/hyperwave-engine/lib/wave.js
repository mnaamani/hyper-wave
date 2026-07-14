// HyperWave orchestrator — the composition root. Wires the transport (Hyperswarm +
// Protomux gossip) to the pure domains — ring geometry (ring.js), pin selection
// (pins.js), attestation crypto (attest.js), gallery ordering (gallery.js), sweep slot
// math (sweep.js) — and composes the stateful machines: PeerTable (seats/channels/pins),
// Flood (gossip dedup), SelfiePipeline (stage+slot pairing), and CrdtGallery
// (per-wave multicore CRDT gallery). What remains here is the wave
// lifecycle FSM, the deterministic sweep, and the gossip dispatch that binds them.
// The payment layer (wallet.js, WDK) is injected by the worker via setWallet(): wallet
// address (for gallery tips) + the on-chain burn verifier (the paid-wave anti-spam gate).
// Money model: burned fees (skin in the game) + gallery tips; there are no sponsor rewards.
// Runs under Bare (the worker) or a Node harness. The Bare worker (hyperwave.js) bridges
// this to the renderer; wave.run.js drives it headlessly.

const Hyperswarm = require('hyperswarm');
const Corestore = require('corestore');
const Protomux = require('protomux');
const cenc = require('compact-encoding');
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const fs = require('bare-fs');

const { angleOf, angleOfId, nextClockwise } = require('./ring');
const { sweepSchedule, mySlot } = require('./sweep');
const { topUpPins } = require('./pins');
const { Flood } = require('./flood');
const { CrdtGallery } = require('./gallery-crdt');
const { PeerTable } = require('./peer-table');
const { SelfiePipeline } = require('./selfie');
const {
  signBurn,
  verifyBurn,
  signJoin,
  verifyJoin,
  burnAuthorizes
} = require('./attest');

const MATCH = 'hyperwave:demo-match:v1';
const HEARTBEAT_MS = 2000; // heartbeat cadence (liveness + country)
const RINGUPDATE_MS = 4000; // re-pin + gallery-pull maintenance cadence
const PEER_STALE_MS = 12000; // a peer whose last heartbeat is older than this is stale (dropped)
// Lobby: after "kick off", the wave is announced and peers get this long to opt in
// (get ready / choose to selfie) before the sweep starts.
const LOBBY_MS = 15000;
// The sweep (scalable-topology.md §3B): the initiator's wave-start carries `t0` (epoch
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
// How many peers we deliberately pin (swarm.joinPeer) as the flood graph's floor —
// random-K, sticky (see pins.js for the full reasoning + the measured reach cliff:
// keep this well above K=3). Overridable per-instance (pinBudget option; 0 disables
// pinning entirely — the A/B knob for testing whether the incidental topic mesh
// alone carries the flood at scale).
const PIN_BUDGET = 7;
// Wave lifecycle control messages that must reach *every* peer (not just direct
// neighbours). At scale Hyperswarm is only a partial random mesh, so these are
// flooded — relayed hop-to-hop with per-message dedup (protocol.md §3.1).
// wave-join floods because it publishes a participant's gallery core (writer key + join
// attestation + burn) to EVERY peer, which ingests it to open that core; authenticity is
// the carried join signature (attest.js verifyJoin), not the hop.
const RELAYED_KINDS = new Set(['wave-announce', 'wave-join', 'wave-start']);
// Identity binding: for a message that describes its OWN sender, the claimed id must equal
// the Noise-authenticated connection id it arrived on (`fromId`). Hyperswarm authenticates
// *who* we're talking to; without this the app would still believe whatever a modified
// client *claims* to be — letting one peer fake other peers' liveness (ring pollution).
// Only direct (one-hop) messages can be bound this way; flooded messages (wave-*) are
// relayed, so their `by`/`peerId` is a third party at relay hops — those are authenticated
// by their carried signatures (kick-off burn proof, join attestations) instead.
const SELF_ID_FIELD = {
  heartbeat: 'id' // the heartbeat sender
  // NB: wave-join is NOT here — it's relayed (RELAYED_KINDS), so at relay hops its
  // `peerId` is a third party; its credential is authenticated by the carried join
  // signature (attest.js verifyJoin), not the connection.
};
// Cap on remembered message ids (flood dedup); the oldest ids are evicted first
// (flood.js), so a straggling duplicate of a very old message might re-flood once —
// harmless and very rare.
const GOSSIP_SEEN_CAP = 4096;
// How long the initiator waits for its kick-off burn to confirm + announce before aborting
// the wave back to idle (paid-wave gate). Generous: the burn broadcasts in ~2s but on-chain
// read-back can lag; must exceed the worker's confirmation poll budget.
const PAY_TIMEOUT_MS = 60000;

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
 * @property {(state: Object) => void} onState Called with `{ me, peers, successor }` whenever the ring changes.
 * @property {(event: Object) => void} [onEvent] Lifecycle/UI event sink (wave-announce, holding, position, completed…).
 * @property {(items: Object[]) => void} [onGallery] Called with the ordered gallery entries whenever it updates.
 * @property {(...args: any[]) => void} [log] Logger.
 * @property {Array<{host: string, port: number}>|null} [bootstrap] Local-DHT bootstrap nodes, or null for the public DHT.
 * @property {string} [matchId] Match topic string (all peers on the same id share one ring).
 * @property {number} [lobbyMs] Lobby window length in ms (opt-in window before the race).
 * @property {number} [pinBudget] Sticky random pins to hold (pins.js; 0 disables pinning).
 * @property {number} [maxPeers] Hyperswarm connection cap (default 64; lower to force a partial mesh).
 * @property {string} [swarmSeed] Hex seed for the swarm identity; distinct from the wallet seed (createPayments).
 */

/**
 * @typedef {Object} WaveHandle
 * @property {{id: string, angle: number, country: string|null}} me This peer's ring identity.
 * @property {() => string|null} startWave Announce a wave + open the lobby; returns the new waveId, or null if busy.
 * @property {() => string|null} join Opt into the current lobby; returns the joined waveId, or null on a no-op.
 * @property {(country: string) => void} setCountry Set the supported nation (cosmetic, rides the heartbeat).
 * @property {(selfie: {image: string, caption?: string}) => void} stageSelfie Stage the lobby selfie to post at my sweep slot.
 * @property {(address: string|null, verifier?: Function) => void} setWallet Wire the payment layer (address + on-chain burn verifier).
 * @property {(proof: Object) => void} announcePaid Initiator: attach the confirmed kick-off proof and announce.
 * @property {(fields: Object) => Object} recordBurn Sign a fee-burn attestation (the paid-wave gate ticket).
 * @property {() => Promise<void>} close Tear down timers, swarm, galleries, and the store.
 */

/**
 * Create the HyperWave orchestrator: joins the match swarm, maintains the pinned flood
 * mesh, runs the wave lifecycle (lobby → sweep → gallery), and exposes the command
 * surface the host (worker/harness) drives.
 * @param {CreateWaveOptions} options
 * @returns {WaveHandle} The command + identity surface for this peer.
 */
function createWave({
  storageDir,
  onState,
  onEvent = () => {},
  onGallery = () => {},
  log = () => {},
  bootstrap = null,
  matchId = MATCH,
  lobbyMs = LOBBY_MS,
  // Random-K pin budget (pins.js); 0 disables pinning (rely on the incidental mesh).
  pinBudget = PIN_BUDGET,
  // Hyperswarm's connection cap. 64 is Hyperswarm's own default; lower it (e.g. 16) to
  // force a genuine partial mesh below the peer count — the condition the flood + pins
  // are designed for, and what a real large swarm looks like.
  maxPeers = 64,
  swarmSeed = null // hex seed for the swarm identity; distinct from the wallet seed (createPayments)
}) {
  // The store is per-run (galleries are keyed by the random waveId, so nothing persists
  // meaningfully across runs); wipe it on startup to reclaim disk.
  const storePath = storageDir + '/hyperwave';
  try {
    fs.rmSync(storePath, { recursive: true, force: true });
  } catch {}
  const store = new Corestore(storePath);
  // Persisted swarm identity: derive the Noise keypair from a seed that survives restarts, so a
  // peer keeps the SAME id / ring seat / signing key across runs (loadOrCreateSwarmSeed). Passing
  // an explicit keyPair overrides Hyperswarm's fresh-per-run default.
  const swarmKeyPair = crypto.keyPair(
    loadOrCreateSwarmSeed(storageDir, swarmSeed, log)
  );
  // bootstrap: pass a local DHT for instant same-machine discovery (tests / single
  // -laptop demo). Omit for the public DHT (cross-machine, ~20-35s cold discovery).
  const swarm = new Hyperswarm({
    keyPair: swarmKeyPair,
    maxPeers,
    ...(bootstrap ? { bootstrap } : {})
  });

  const meKey = swarm.keyPair.publicKey;
  const me = {
    id: b4a.toString(meKey, 'hex'),
    angle: angleOf(meKey),
    country: null
  };
  let walletAddress = null; // my TRX wallet address (set by the worker once WDK is ready)
  let enforcePaid = false; // gate waves on a proven kick-off burn (enabled once wallet is up)
  let verifyBurnOnChain = null; // on-chain burn check (set once the wallet is up, via setWallet)
  // Live peer bookkeeping (peer-table.js): seats, direct channels, pins, churn cooldowns.
  const table = new PeerTable({ meId: me.id, staleMs: PEER_STALE_MS });
  const endedWaves = new Set(); // waves that finished — never re-adopt (prevents revival)
  const flood = new Flood({ cap: GOSSIP_SEEN_CAP }); // flood dedup for relayed control msgs

  // Per-wave gallery (gallery-crdt.js): each participant owns one Hypercore and appends
  // its one selfie; every peer opens the roster's cores (keys ride wave-join) and merges
  // locally — no indexer, no admission. The accessors read live wave.js state.
  const session = new CrdtGallery({
    store,
    me,
    onGallery,
    walletAddress: () => walletAddress,
    burnProof: () => selfie.burnProof,
    joinProof: () => (wave ? wave.joinSig : null),
    log
  });

  // Wave lifecycle: idle -> lobby -> racing -> idle. One wave engaged at a time;
  // concurrent starts resolve deterministically (lower waveId wins). During the lobby,
  // peers opt in; only the roster gets a selfie slot — everyone renders the sweep.
  let wave = null;
  let lobbyEndsAt = 0; // ~when the lobby closes (for syncing a late joiner's countdown)
  let lobbyTimer = null; // fires the sweep (initiator) or a fallback to idle (others)
  let waveTimer = null; // the deterministic end of the sweep (t0 + lapMs + grace)
  let sweepTimers = []; // my-slot + ball-position timers for the running sweep
  let tHeartbeat = null; // heartbeat timer (self-rescheduling, see the timers section)
  let tRing = null; // ring-maintenance timer

  // Selfie is captured up-front during the lobby (renderer stages it into the pipeline),
  // then posted to the gallery when my sweep slot fires. The pipeline (selfie.js) owns
  // the pairing/once-per-wave/burn-ticket invariants; `canSelfieNow`/`postSelfie` are
  // function declarations below (hoisted), safe to pass here.
  const selfie = new SelfiePipeline({
    canSelfie: () => canSelfieNow(),
    currentWaveId: () => (wave ? wave.id : null),
    post: (entry) => session.postSelfie(entry)
  });

  // --- ring / peer table -----------------------------------------------------
  /** Recompute the live ring and push `{ me, peers, successor, connected, discovered }` to the host (onState). */
  function emit() {
    const ring = table.liveRing();
    onState({
      me,
      peers: ring,
      successor: nextClockwise(me.angle, ring),
      connected: [...table.senderIds()].length,
      // DHT-discovered count (may exceed live seats): hosts gate start triggers on
      // this — a seat needs a live connection, but "the roster exists" only needs
      // the DHT to have seen the peers.
      discovered: swarm.peers.size
    });
  }

  // DHT discovery drives *who we try to connect to* (pin candidates) — NOT the visible
  // ring. A DHT announcement only means "this key advertised the topic once"; a stale
  // announce from a since-closed instance would otherwise become a permanent ghost seat.
  // A seat requires real liveness (a connection or gossip); discovery says who to dial.
  /** @returns {string[]} Hex ids Hyperswarm has discovered on our topic, minus just-disconnected peers. */
  function discoveredIds() {
    const now = Date.now();
    const ids = [];
    for (const info of swarm.peers.values()) {
      const id = b4a.toString(info.publicKey, 'hex');
      // Skip a peer we just saw disconnect (Hyperswarm keeps retrying it) so we don't
      // re-pin a dead neighbour; the cooldown clears on reconnect or when it expires.
      if (table.coolingDown(id, now)) {
        continue;
      }
      ids.push(id);
    }
    return ids;
  }

  /**
   * Keep PIN_BUDGET sticky random pins (pins.js has the full reasoning): the pins are
   * the flood graph's chosen floor — dialed with priority, immune to maxPeers — so
   * flood reach never depends on the quality of Hyperswarm's incidental topic mesh.
   * Diff against the table's pinned set as peers churn (table.updatePins): joinPeer
   * the additions, leavePeer the removals. A dead pin leaves the candidate set (its
   * disconnect starts a churn cooldown that also suppresses its stale DHT announce),
   * so the top-up replaces it on the next refresh.
   *
   * Candidates = DHT-discovered ∪ already-connected ∪ gossip-known (live seats). A
   * stale discovery we can't reach may be pinned (dialed) but is never shown as a
   * seat (seats require real liveness).
   */
  function maintainNeighbours() {
    const cand = new Set([
      ...discoveredIds(),
      ...table.senderIds(),
      ...table.peerIds()
    ]);
    cand.delete(me.id);
    const targets = topUpPins({
      current: table.pinnedIds(),
      candidates: cand,
      budget: pinBudget
    });
    // Never unpin a peer we already have a live channel to: leavePeer on a connected
    // peer makes Hyperswarm reap the connection, and reaping live channels mid-wave
    // once cost messages on channels the table still reported live. Keeping live
    // channels pinned holds the mesh stable; genuinely-closed peers drop out of
    // senderIds via conn.on('close').
    for (const id of table.senderIds()) {
      targets.add(id);
    }
    // The table diffs `pinned`; we mirror the diff into the swarm (side-effects here).
    const { added, removed } = table.updatePins(targets);
    for (const id of added) {
      try {
        swarm.joinPeer(b4a.from(id, 'hex'));
        log('pin neighbour', shortId(id));
      } catch {}
    }
    for (const id of removed) {
      try {
        swarm.leavePeer(b4a.from(id, 'hex'));
        log('unpin neighbour', shortId(id));
      } catch {}
    }
  }

  /** Top up the pins from current discovery/connectivity, and repaint. */
  function refreshTopology() {
    maintainNeighbours();
    emit();
  }

  /**
   * Set the nation this peer supports; rides the heartbeat + selfie entries (cosmetic).
   * @param {string} code Supported-nation code (falsy clears it).
   */
  function setCountry(code) {
    me.country = code || null;
    emit();
  }

  // The heartbeat: pure liveness + country, sent to pinned neighbours. Membership
  // comes from DHT discovery (`swarm.peers`) + direct connections; peers don't gossip
  // ring structure at all — the sweep needs no successor precision.
  /** @returns {Object} A `heartbeat` gossip message: my id + country (pure liveness). */
  function myHeartbeat() {
    return {
      kind: 'heartbeat',
      id: me.id,
      country: me.country
    };
  }

  /**
   * Central inbound-gossip dispatcher: identity-binds, floods relayable control messages,
   * then routes each message kind to its handler (wave-*, heartbeat).
   * @param {Object} msg Parsed gossip message (has a `kind`).
   * @param {string} fromId Hex id of the Noise-authenticated connection it arrived on.
   */
  function handleGossip(msg, fromId) {
    // Identity binding (see SELF_ID_FIELD): drop a self-describing message that didn't come
    // from the peer it claims to be. Cheap string compare, before any signature work.
    const idField = SELF_ID_FIELD[msg.kind];
    if (idField && msg[idField] !== fromId) {
      return;
    }

    // Flood relayable control messages across the partial mesh: process each exactly
    // once, and on first sight re-broadcast to my other neighbours (dedup by `mid`).
    if (msg.mid && RELAYED_KINDS.has(msg.kind)) {
      if (!flood.firstSight(msg.mid)) {
        return; // already seen -> drop (stops loops)
      }
      relayFlood(msg, fromId);
    }
    if (msg.kind === 'wave-sync') {
      // a peer told us the wave state when we joined mid-lobby / mid-race
      if (!msg.waveId || !shouldAdopt(msg.waveId)) {
        return;
      }
      // anti-spam: adopt a synced wave (lobby OR racing) only with a valid kick-off proof.
      // Previously a *racing* sync skipped this — a hostile peer could unicast a fabricated
      // racing wave-sync on connect to force a newcomer into a bogus wave, bypassing the
      // paid gate. The signed burn-proof can't be forged for a key the attacker lacks.
      if (enforcePaid && !validKickoff(msg.paid, msg.waveId, msg.by)) {
        return;
      }
      if (msg.phase === 'racing') {
        if (!wave || wave.id !== msg.waveId) {
          enterLobby({ waveId: msg.waveId, by: msg.by, dur: 0, silent: true });
        }
        if (msg.paid) {
          wave.kickoffProof = msg.paid;
        }
        wave.paid = 'verified';
        // learn every participant's gallery core (self-contained: the sync carries the
        // writers, so a mid-race newcomer doesn't depend on having seen the wave-joins)
        for (const cred of msg.writers || []) {
          ingestWriter(cred);
        }
        beginSweep({ rosterIds: msg.roster, t0: msg.t0, lapMs: msg.lapMs });
      } else {
        if (!wave || wave.id !== msg.waveId) {
          enterLobby({ waveId: msg.waveId, by: msg.by, dur: msg.lobbyMsLeft });
        }
        if (enforcePaid && msg.paid && !wave.kickoffProof) {
          wave.kickoffProof = msg.paid;
          verifyKickoff(msg.waveId, msg.paid);
        }
        for (const cred of msg.writers || []) {
          ingestWriter(cred);
        }
        onEvent({ event: 'roster', waveId: wave.id, count: wave.roster.size });
      }
      return;
    }
    if (msg.kind === 'wave-announce') {
      // anti-spam: an enforced peer ignores any announce lacking a validly-signed kick-off
      // proof (unpaid/spam waves are invisible). Then it verifies the burn on-chain.
      if (enforcePaid && !validKickoff(msg.paid, msg.waveId, msg.by)) {
        return;
      }
      if (!shouldAdopt(msg.waveId)) {
        return;
      }
      enterLobby({ waveId: msg.waveId, by: msg.by, dur: msg.lobbyMs });
      if (enforcePaid && msg.paid) {
        wave.kickoffProof = msg.paid;
        verifyKickoff(msg.waveId, msg.paid);
      }
      return;
    }
    if (msg.kind === 'wave-join') {
      // Every peer ingests every wave-join: learn the participant's gallery core (its key
      // rides the join, self-certified by joinSig) + count it into the roster. Only DURING
      // THE LOBBY — the roster freezes into the schedule at lobby close, so a late join
      // can't take a seat it can never fill. When enforcing, the join must present a valid
      // burn (paid gate — every peer checks, deterministically).
      if (wave && wave.phase === 'lobby' && msg.waveId === wave.id) {
        if (enforcePaid && !burnAuthorizes(msg.burn, msg.peerId, msg.waveId)) {
          return;
        }
        ingestWriter({
          peerId: msg.peerId,
          writerKey: msg.writerKey,
          joinSig: msg.joinSig
        });
      }
      return;
    }
    if (msg.kind === 'wave-start') {
      // initiator finalized the roster and kicked off the sweep. Gate on the same kick-off
      // proof as the announce, so a forged wave-start can't conjure a race.
      if (enforcePaid && !validKickoff(msg.paid, msg.waveId, msg.by)) {
        return;
      }
      if (msg.waveId && shouldAdopt(msg.waveId)) {
        if (!wave || wave.id !== msg.waveId) {
          enterLobby({ waveId: msg.waveId, by: msg.by });
        }
        if (msg.paid) {
          wave.kickoffProof = msg.paid; // carry it so we can re-sync newcomers
        }
        // the flooded writers make wave-start self-contained: a peer adopting here (that
        // missed the wave-joins) still learns every participant's gallery core
        for (const cred of msg.writers || []) {
          ingestWriter(cred);
        }
        beginSweep({ rosterIds: msg.roster, t0: msg.t0, lapMs: msg.lapMs });
      }
      return;
    }
    if (msg.kind !== 'heartbeat') {
      return;
    }
    // sender is a live neighbour (direct channel): refresh its seat + country
    table.upsert(msg.id, Date.now(), msg.country);
    emit();
  }

  /**
   * JSON-encode and send a message to every direct connection.
   * @param {Object} obj The gossip message to broadcast.
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
   * Originate a flooded control message: stamp a unique id, remember it (so it doesn't
   * loop back into me), and broadcast to every direct connection. Receivers relay it on
   * (relayFlood) until it has blanketed the whole partial mesh.
   * @param {Object} obj The message to flood (a fresh `mid` is stamped onto it).
   */
  function floodGossip(obj) {
    obj.mid = b4a.toString(crypto.randomBytes(8), 'hex');
    flood.firstSight(obj.mid); // mark mine seen so relays can't loop back into me
    broadcast(obj);
  }

  /**
   * Re-broadcast a flooded message to my other neighbours (everyone except whoever sent
   * it to me — dedup handles the remaining echoes). This is the relay step that carries
   * an announcement across a swarm too large to be a full mesh.
   * @param {Object} msg The already-seen flooded message to relay on.
   * @param {string} fromId Hex id of the connection it arrived on (excluded from the relay).
   */
  function relayFlood(msg, fromId) {
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

  // Send only to our pinned peers (the random-K floor, pins.js). Used for the
  // heartbeat — constant fanout instead of hitting every connection. wave-* fanout
  // stays on broadcast() + flood relay (roster/lifecycle need full reach).
  /**
   * @param {Object} obj The gossip message to send only to pinned peers.
   */
  function broadcastToNeighbours(obj) {
    const str = JSON.stringify(obj);
    for (const id of table.pinnedIds()) {
      const send = table.send(id);
      if (!send) {
        continue;
      }
      try {
        send(str);
      } catch {}
    }
  }

  // --- gallery (multicore CRDT) ---------------------------------------------
  // The open/merge machinery lives in gallery-crdt.js; wave.js drives it by
  // ingesting each participant's gallery-core credential (from wave-join / wave-start /
  // wave-sync) — no shared gallery key, no admission.

  // Learn a participant's gallery core: verify its join attestation (binds peerId →
  // writerKey, so a relayed credential can't be forged or substituted), then count it
  // into the roster + writers and open its core (gallery-crdt.js). Idempotent; the paid
  // gate for direct wave-joins is enforced by the caller (wave-start/sync writers carry
  // no burn — the wave itself is gated by the kick-off proof).
  /**
   * @param {Object} cred A gallery-core credential.
   * @param {string} cred.peerId The participant's ring id.
   * @param {string} cred.writerKey The participant's gallery core key (hex).
   * @param {string} cred.joinSig The join attestation over (waveId, peerId, writerKey).
   */
  function ingestWriter(cred) {
    if (!wave || !cred || wave.writers.has(cred.peerId)) {
      return;
    }
    if (!cred.peerId || !cred.writerKey || !cred.joinSig) {
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
    wave.roster.add(cred.peerId);
    wave.writers.set(cred.peerId, {
      writerKey: cred.writerKey,
      joinSig: cred.joinSig
    });
    session.addWriter(wave.id, cred.peerId, cred.writerKey);
    onEvent({ event: 'roster', waveId: wave.id, count: wave.roster.size });
  }

  // The worker reports a successful fee burn. Sign a burn attestation (ring key binds my
  // identity to the on-chain tx), stash it, and return it. Two consumers: the initiator
  // attaches its KICK-OFF proof to the wave-announce (the paid-wave gate, announcePaid);
  // a joiner's proof rides its wave-join (the per-peer paid gate) and its gallery entry
  // (the tip-address binding).
  /**
   * @param {Object} fields The confirmed on-chain burn.
   * @param {string} fields.reason 'kickoff' (initiator) or 'join' (participant).
   * @param {number} fields.amount TRX amount burned.
   * @param {string} fields.txHash On-chain transaction hash.
   * @param {string} [fields.waveId] Wave the burn is for (falls back to the current wave).
   * @returns {Object|null} The signed burn attestation, or null if we've moved past that wave.
   */
  function recordBurn({ reason, amount, txHash, waveId }) {
    // The burn is for `waveId` (threaded from payFee). A burn for an older wave must never
    // overwrite the current wave's proof; one landing after its own wave moved on is inert.
    const wid = waveId || wave?.id;
    if (!wid || (wid !== wave?.id && wid !== session.waveId)) {
      return null;
    }
    const fields = {
      waveId: wid,
      peerId: me.id,
      reason,
      amount,
      txHash,
      tronAddress: walletAddress || '',
      burnTs: Date.now()
    };
    const proof = { ...fields, sig: signBurn(swarm.keyPair, fields) };
    selfie.setBurnProof(proof);
    // My join fee just confirmed while the lobby is still open: re-flood my wave-join with
    // the burn attached — enforcing peers dropped the earlier burn-less join (per-peer paid
    // gate), so this flood is the one that actually seats me.
    if (
      reason === 'join' &&
      wave &&
      wave.id === wid &&
      wave.joined &&
      wave.phase === 'lobby'
    ) {
      floodMyGalleryCore(wid);
    }
    return proof;
  }

  // --- wave lifecycle (idle -> lobby -> racing -> idle) ----------------------

  /**
   * Accept this wave? Idle -> yes; same wave -> yes; a competing wave only if its
   * id is lower (deterministic tie-break so every peer converges on one wave).
   * @param {string} waveId Candidate wave id.
   * @returns {boolean} True if we should adopt/keep it.
   */
  function shouldAdopt(waveId) {
    if (endedWaves.has(waveId)) {
      return false; // a finished wave never comes back
    }
    if (!wave || waveId === wave.id) {
      return true;
    }
    return waveId < wave.id;
  }

  /** Clear the lobby/sweep timers (wave is ending or being superseded). */
  function teardown() {
    clearTimeout(lobbyTimer);
    clearTimeout(waveTimer);
    for (const timer of sweepTimers) {
      clearTimeout(timer);
    }
    sweepTimers = [];
  }

  /**
   * Enter the lobby for `waveId` (announced by `by`; `mine` if I'm the initiator).
   * `silent` skips the wave-announce UI event (used when catching up straight into a
   * race, so no bogus lobby countdown flashes).
   * @param {Object} opts The lobby to enter.
   * @param {string} opts.waveId The wave to enter a lobby for.
   * @param {string} opts.by Hex id of the initiator that announced it.
   * @param {boolean} [opts.mine] True if I'm the initiator.
   * @param {number} [opts.dur] Lobby duration in ms (defaults to lobbyMs).
   * @param {boolean} [opts.silent] Suppress the wave-announce UI event.
   */
  function enterLobby({
    waveId,
    by,
    mine = false,
    dur = lobbyMs,
    silent = false
  }) {
    if (wave && wave.id === waveId) {
      return;
    }
    if (wave) {
      // superseded by a lower-id wave — abandon the old one
      endedWaves.add(wave.id);
      teardown();
    }
    selfie.reset(); // fresh wave — clear any staged selfie/slot from a prior one
    selfie.clearBurnProof(); // a genuinely new wave (guarded above): drop the previous wave's burn ticket
    // paid: 'verified' when the kick-off burn is confirmed (or enforcement is off);
    // 'pending' while a peer verifies it on-chain; 'rejected' if it isn't a real burn.
    wave = {
      id: waveId,
      phase: 'lobby',
      by,
      roster: new Set([by]),
      joined: !!mine,
      paid: enforcePaid ? 'pending' : 'verified',
      kickoffProof: null,
      joinSig: null, // MY join attestation (attest.js signJoin) — every gallery entry carries it
      writers: new Map() // peerId -> {writerKey, joinSig, burn} — every participant's gallery core
    };
    // engage the wave's gallery for viewing (create my own core; foreign cores arrive via
    // ingestWriter). Fire-and-forget — the writer key is awaited where it's needed.
    session.open(waveId).catch(() => {});
    // Re-adopting a wave I joined, then abandoned on a revivable lobby-timeout (a late
    // wave-start re-opened it): restore my join state so my slot still arms + posts.
    if (abandonedJoin && abandonedJoin.waveId === waveId) {
      wave.joined = true;
      wave.joinSig = abandonedJoin.joinSig;
      wave.roster.add(me.id);
      abandonedJoin = null;
    }
    if (mine) {
      wave.roster.add(me.id);
    }
    lobbyEndsAt = Date.now() + dur;
    // fallback: if the start never arrives (initiator vanished), drop back to idle
    clearTimeout(lobbyTimer);
    lobbyTimer = setTimeout(() => goIdle('lobby-timeout'), lobbyMs + 10000);
    if (silent) {
      return;
    }
    onEvent({
      event: 'wave-announce',
      waveId,
      by,
      mine: !!mine,
      joined: wave.joined,
      count: wave.roster.size,
      lobbyMs: dur,
      paid: wave.paid // 'verified' (enforcement off / already paid) | 'pending' (verifying)
    });
  }

  /**
   * Opt in to the current lobby (renderer command / harness).
   * @returns {string|null} The joined waveId (so the worker can charge the join fee on a real
   *   opt-in), or null if it was a no-op.
   */
  function join() {
    if (!wave || wave.phase !== 'lobby' || wave.joined) {
      return null;
    }
    // anti-spam: never join (and pay) a wave whose kick-off fee isn't proven paid
    if (wave.paid !== 'verified') {
      onEvent({ event: 'join-blocked', waveId: wave.id, reason: wave.paid });
      return null;
    }
    wave.joined = true;
    wave.roster.add(me.id);
    floodMyGalleryCore(wave.id);
    onEvent({ event: 'joined', waveId: wave.id, count: wave.roster.size });
    return wave.id;
  }

  /**
   * Publish MY gallery core: open it (its key is my writer key), sign my join attestation
   * over it, remember myself in `writers`, and flood a wave-join carrying (writerKey,
   * joinSig, burn). Every peer ingests it → opens my core → sees my selfie. The core key
   * needs my core ready, so the flood is async. Called by joiners (from join()) and the
   * initiator (from doAnnounce); recordBurn re-floods once a late join burn confirms.
   * @param {string} waveId The wave whose core to publish.
   */
  function floodMyGalleryCore(waveId) {
    session
      .open(waveId)
      .then((writerKey) => {
        if (!wave || wave.id !== waveId || !wave.joined || !writerKey) {
          return;
        }
        if (!wave.joinSig) {
          wave.joinSig = signJoin(swarm.keyPair, { waveId, writerKey });
        }
        // remember myself so my own wave-sync shares my core with newcomers
        wave.writers.set(me.id, { writerKey, joinSig: wave.joinSig });
        floodGossip({
          kind: 'wave-join',
          waveId,
          peerId: me.id,
          writerKey,
          joinSig: wave.joinSig,
          burn: selfie.burnProof || undefined
        });
      })
      .catch(() => {});
  }

  /**
   * Transition the current wave from lobby to the racing sweep: derive the schedule
   * from the CANONICAL roster (the ids flooded on wave-start — every peer must compute
   * the identical schedule), arm my slot + the ball ticker + the deterministic end.
   * Receiver-side clamps stop a hostile start from wedging a wave open.
   * @param {Object} opts The sweep parameters (from wave-start / wave-sync / my own start).
   * @param {string[]} opts.rosterIds The canonical roster ids.
   * @param {number} opts.t0 Epoch ms the sweep starts.
   * @param {number} opts.lapMs Duration of the full lap.
   */
  function beginSweep({ rosterIds, t0, lapMs }) {
    if (!wave || wave.phase === 'racing') {
      return;
    }
    if (!Number.isFinite(t0) || !Number.isFinite(lapMs) || lapMs <= 0) {
      return;
    }
    if (t0 - Date.now() > MAX_LAP_MS) {
      return; // a start scheduled absurdly far out is bogus — ignore it
    }
    const ids =
      rosterIds && rosterIds.length ? [...rosterIds] : [...wave.roster];
    const cappedLapMs = Math.min(lapMs, MAX_LAP_MS);
    wave.phase = 'racing';
    wave.t0 = t0;
    wave.lapMs = cappedLapMs;
    for (const id of ids) {
      wave.roster.add(id);
    }
    const schedule = sweepSchedule({ rosterIds: ids, t0, lapMs: cappedLapMs });
    clearTimeout(lobbyTimer);
    armSweepTimers(schedule);
    // the deterministic end: EVERY peer observes t0 + lap + grace locally — there is
    // no wave-end message (nothing to trust, nothing to lose in the mesh)
    clearTimeout(waveTimer);
    const waveId = wave.id;
    waveTimer = setTimeout(
      () => finishWave(waveId, { hops: schedule.length }),
      Math.max(0, t0 + cappedLapMs + END_GRACE_MS - Date.now())
    );
    onEvent({
      event: 'wave-active',
      waveId: wave.id,
      joined: wave.joined,
      count: wave.roster.size
    });
  }

  /**
   * Arm the running sweep's timers: my own slot (records it into the selfie pipeline —
   * pairing with the staged lobby frame posts the gallery entry — and tells the renderer
   * I'm holding) and the ball ticker (every screen walks the schedule locally and emits
   * `position` events — there is no wave-pos gossip; already-past slots flush at once so
   * a mid-race joiner catches up).
   * @param {import('./sweep').SweepSlot[]} schedule The derived sweep schedule.
   */
  function armSweepTimers(schedule) {
    const waveId = wave.id;
    const mine = mySlot(schedule, me.id);
    if (mine && wave.joined) {
      const slotTimer = setTimeout(
        () => {
          if (!wave || wave.id !== waveId) {
            return;
          }
          selfie.recordSlot({ waveId, hopCount: mine.rank });
          onEvent({
            event: 'holding',
            waveId,
            hopCount: mine.rank,
            holder: me.id,
            angle: me.angle,
            canSelfie: canSelfieNow()
          });
        },
        Math.max(0, mine.at - Date.now())
      );
      sweepTimers.push(slotTimer);
    }
    let index = 0;
    const tick = () => {
      if (!wave || wave.id !== waveId) {
        return;
      }
      const now = Date.now();
      while (index < schedule.length && schedule[index].at <= now) {
        const slot = schedule[index];
        onEvent({
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
      sweepTimers.push(setTimeout(tick, Math.max(0, schedule[index].at - now)));
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
  // When a revivable idle abandons a wave I had JOINED, remember my join state: a late
  // wave-start re-adopts the wave through enterLobby, which builds fresh state — without
  // this memo the re-adopted wave would have joined=false (my slot never arms, my selfie
  // never posts) and a blank joinSig (my entry would fail mergeGallery's write-gate).
  // Single slot: only one wave is ever engaged at a time. (Found at N=128: one peer per
  // ~100 hit exactly this path.)
  let abandonedJoin = null; // { waveId, joinSig } | null

  /**
   * Return to idle: mark the wave ended (unless the reason is revivable), clear
   * per-wave state, and notify the UI.
   * @param {string} reason Why we went idle (lobby-timeout, ended, unpaid…).
   */
  function goIdle(reason) {
    if (!wave) {
      return;
    }
    const waveId = wave.id;
    if (!REVIVABLE_IDLE_REASONS.has(reason)) {
      endedWaves.add(waveId);
      abandonedJoin = null;
    } else if (wave.joined) {
      abandonedJoin = { waveId, joinSig: wave.joinSig };
    }
    wave = null;
    selfie.reset(); // drop any staged selfie / slot for the next wave
    teardown();
    onEvent({ event: 'wave-idle', waveId, reason });
  }

  /**
   * Finish the current wave: emit the outcome to the UI and return to idle. Fired by
   * every peer's own deterministic end timer (t0 + lapMs + grace) — completion needs no
   * message and no trust.
   * @param {string} waveId The wave that finished.
   * @param {Object} [outcome]
   * @param {number} [outcome.hops] How many roster slots the sweep covered.
   */
  function finishWave(waveId, { hops = 0 } = {}) {
    if (!wave || wave.id !== waveId) {
      return;
    }
    onEvent({
      event: 'completed',
      waveId,
      hops,
      angle: angleOfId(wave.by)
    });
    goIdle('ended');
  }

  /**
   * @returns {boolean} True if I'm opted into the current wave (a roster member who may selfie).
   */
  function canSelfieNow() {
    return !!(wave && wave.roster.has(me.id));
  }

  /**
   * Announce a new wave and open the lobby (any peer can start when idle). At lobby
   * close the initiator freezes the roster and starts the sweep.
   * @returns {string|null} The new waveId, or null if a wave is already engaged.
   */
  function startWave() {
    if (wave) {
      onEvent({ event: 'busy', waveId: wave.id });
      return null;
    }
    const waveId = b4a.toString(crypto.randomBytes(16), 'hex');
    enterLobby({ waveId, by: me.id, mine: true }); // initiator auto-joins (marks its own lobby)
    if (enforcePaid) {
      // Anti-spam: don't announce yet. Wait for the worker to burn the kick-off fee and
      // prove it (announcePaid). Fall back to idle if that never happens.
      log('wave', shortId(waveId), '— awaiting kick-off payment');
      clearTimeout(lobbyTimer);
      lobbyTimer = setTimeout(() => goIdle('unpaid'), PAY_TIMEOUT_MS);
      onEvent({ event: 'paying', waveId });
    } else {
      // no-wallet path (tests/headless): announce immediately, unpaid
      doAnnounce(waveId, null);
    }
    return waveId;
  }

  /**
   * Flood the wave-announce (carrying the kick-off `paid` proof when present), publish the
   * initiator's own gallery core (floodMyGalleryCore), and start the lobby→sweep timer.
   * There is no shared gallery key any more — each participant contributes its own
   * self-certified core. Shared by the paid and unpaid paths.
   * @param {string} waveId The wave being announced.
   * @param {Object|null} paidProof The signed kick-off burn proof, or null (unpaid path).
   */
  function doAnnounce(waveId, paidProof) {
    log('announcing wave', shortId(waveId), paidProof ? '(paid)' : '');
    floodGossip({
      kind: 'wave-announce',
      waveId,
      by: me.id,
      lobbyMs,
      paid: paidProof || undefined
    });
    floodMyGalleryCore(waveId); // the initiator is a participant too — share its core
    clearTimeout(lobbyTimer);
    lobbyTimer = setTimeout(() => finalizeAndStart(waveId), lobbyMs);
  }

  /**
   * The worker proved the kick-off burn (after it confirmed on-chain) — attach the proof
   * and NOW announce. The initiator trusts its own confirmed burn (paid = 'verified').
   * @param {Object} proof The signed kick-off burn attestation.
   */
  function announcePaid(proof) {
    if (!wave || wave.phase !== 'lobby' || !enforcePaid) {
      return;
    }
    if (!validKickoff(proof, wave.id, me.id)) {
      return;
    }
    wave.kickoffProof = proof;
    wave.paid = 'verified';
    doAnnounce(wave.id, proof);
    onEvent({ event: 'wave-verified', waveId: wave.id, mine: true });
  }

  /**
   * A kick-off proof is structurally valid: signed (Ed25519) by the initiator over a
   * kick-off burn for this wave. (On-chain reality is checked separately, async.)
   * @param {Object} proof The kick-off burn attestation to check.
   * @param {string} waveId The wave it must name.
   * @param {string} byId Hex id of the initiator it must be signed by.
   * @returns {boolean} True if structurally valid and correctly signed.
   */
  function validKickoff(proof, waveId, byId) {
    return !!(
      proof &&
      proof.reason === 'kickoff' &&
      proof.waveId === waveId &&
      proof.peerId === byId &&
      verifyBurn(proof, proof.sig)
    );
  }

  /**
   * Verify a wave's kick-off burn ON-CHAIN, then settle wave.paid. Abandons the wave if the
   * burn isn't real (anti-spam). No-op if enforcement is off or no verifier is wired.
   * @param {string} waveId The wave whose kick-off burn to verify.
   * @param {Object} proof The kick-off burn attestation (carries txHash / tronAddress / amount).
   */
  function verifyKickoff(waveId, proof) {
    if (!enforcePaid || !verifyBurnOnChain) {
      return;
    }
    verifyBurnOnChain(proof.txHash, {
      waveId,
      from: proof.tronAddress,
      minTrx: proof.amount
    })
      .then((res) => {
        if (!wave || wave.id !== waveId || wave.phase !== 'lobby') {
          return;
        }
        if (res && res.ok) {
          wave.paid = 'verified';
          onEvent({ event: 'wave-verified', waveId });
        } else {
          wave.paid = 'rejected';
          onEvent({ event: 'wave-unpaid', waveId, reason: res && res.reason });
          goIdle('unpaid-rejected');
        }
      })
      .catch(() => {});
  }

  /**
   * Lobby closed: freeze the roster + writers and flood wave-start with them and the sweep
   * parameters, then begin the sweep. The wave-start is self-contained — its `writers`
   * carry every participant's gallery-core credential, so a peer adopting via wave-start
   * (that missed the wave-joins) still learns every core.
   * @param {string} waveId The wave to finalize and start.
   */
  function finalizeAndStart(waveId) {
    if (!wave || wave.id !== waveId || wave.phase !== 'lobby') {
      return;
    }
    // safety net: make sure my own credential is in `writers` (floodMyGalleryCore set it
    // at announce, but the async open may have raced the lobby close)
    if (!wave.joinSig && session.writerKey) {
      wave.joinSig = signJoin(swarm.keyPair, {
        waveId,
        writerKey: session.writerKey
      });
    }
    if (session.writerKey && !wave.writers.has(me.id)) {
      wave.writers.set(me.id, {
        writerKey: session.writerKey,
        joinSig: wave.joinSig
      });
    }
    // the sweep parameters: a short lead so the flooded start reaches everyone before
    // the first slot, and a lap scaled to the roster (clamped — see the constants)
    const t0 = Date.now() + SWEEP_LEAD_MS;
    const lapMs = Math.max(
      MIN_LAP_MS,
      Math.min(MAX_LAP_MS, wave.roster.size * SLOT_MS)
    );
    const rosterIds = [...wave.roster];
    const writers = [...wave.writers.entries()].map(([peerId, cred]) => ({
      peerId,
      writerKey: cred.writerKey,
      joinSig: cred.joinSig
    }));
    log(
      'starting wave',
      shortId(waveId),
      'roster',
      wave.roster.size,
      'writers',
      writers.length
    );
    floodGossip({
      kind: 'wave-start',
      waveId,
      by: me.id,
      roster: rosterIds,
      writers,
      t0,
      lapMs,
      paid: wave.kickoffProof || undefined // so peers adopting via start can re-sync newcomers
    });
    onEvent({ event: 'started', waveId, by: me.id });
    beginSweep({ rosterIds, t0, lapMs });
  }

  // --- connections -----------------------------------------------------------
  swarm.on('connection', (conn) => {
    store.replicate(conn); // carries gossip mux + gallery-core replication

    const id = b4a.toString(conn.remotePublicKey, 'hex');
    log('peer connected', shortId(id));

    const mux = Protomux.from(conn);
    const channel = mux.createChannel({ protocol: 'hyperwave/gossip' });
    const message = channel.addMessage({
      encoding: cenc.string,
      onmessage(str) {
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

    const send = (str) => message.send(str);
    table.onConnect(id, send); // lift any churn cooldown, seat it, remember the channel

    // greet: my heartbeat (liveness + country), so the newcomer seats me immediately.
    // Membership converges via DHT discovery (swarm.peers) + direct connections.
    send(JSON.stringify(myHeartbeat()));
    // if a wave is forming/racing, tell the newcomer so their UI syncs and they can't
    // start a competing one (broadcasts they missed won't reach them otherwise)
    if (wave) {
      send(
        JSON.stringify({
          kind: 'wave-sync',
          waveId: wave.id,
          phase: wave.phase,
          by: wave.by,
          roster: [...wave.roster],
          // every participant's gallery-core credential, so a newcomer is self-contained
          writers: [...wave.writers.entries()].map(([peerId, cred]) => ({
            peerId,
            writerKey: cred.writerKey,
            joinSig: cred.joinSig
          })),
          t0: wave.t0 || undefined, // sweep timing, so a mid-race newcomer animates + ends right
          lapMs: wave.lapMs || undefined,
          paid: wave.kickoffProof || undefined, // so a mid-lobby newcomer can verify + join
          lobbyMsLeft:
            wave.phase === 'lobby' ? Math.max(0, lobbyEndsAt - Date.now()) : 0
        })
      );
    }
    emit();

    conn.on('close', () => {
      // authoritative disconnect: drop the channel + seat, start the churn cooldown
      const { wasPinned } = table.onDisconnect(id);
      log('peer disconnected', shortId(id));
      // a pinned peer dropped: top up the pins immediately instead of waiting for the
      // next tick (its churn cooldown keeps it out of the replacement candidates)
      if (wasPinned) {
        maintainNeighbours();
      }
      emit();
    });
    conn.on('error', () => {});
  });

  // Every time Hyperswarm learns of or drops peers on the topic, refresh the pin
  // candidates and the visible ring.
  swarm.on('update', refreshTopology);

  const topic = crypto.hash(b4a.from(matchId));
  const discovery = swarm.join(topic, { server: true, client: true });
  discovery.flushed().then(() => {
    log(
      'joined match',
      matchId,
      'topic',
      shortId(b4a.toString(topic, 'hex')),
      'as',
      shortId(me.id)
    );
    refreshTopology(); // initial seed + pin once the topic announce/lookup has flushed
  });

  // --- timers ----------------------------------------------------------------
  // All periodic work is a self-rescheduling setTimeout (CLAUDE.md Code Style: no setInterval):
  // each tick re-arms itself as its last step, so a slow tick delays the next instead of stacking.
  /** Heartbeat tick: broadcast my liveness to pinned neighbours, then re-arm. */
  function heartbeatTick() {
    broadcastToNeighbours(myHeartbeat());
    tHeartbeat = setTimeout(heartbeatTick, HEARTBEAT_MS);
  }
  tHeartbeat = setTimeout(heartbeatTick, HEARTBEAT_MS);

  /** Maintenance tick: top up pins, prune stale seats, pull gallery updates, then re-arm. */
  function ringTick() {
    // top up pins from current discovery even if no 'update' fired
    maintainNeighbours();
    emit(); // also re-evaluate staleness pruning
    // Pull replicated gallery writes for every gallery held and repaint.
    session.tick();
    tRing = setTimeout(ringTick, RINGUPDATE_MS);
  }
  tRing = setTimeout(ringTick, RINGUPDATE_MS);

  return {
    me,
    startWave,
    join,
    setCountry,
    stageSelfie: (input) => selfie.stage(input),
    // Wire the payment layer once the wallet is up: my address (for gallery tips /
    // attestations) and the on-chain burn verifier (enables the paid-wave anti-spam gate).
    setWallet: (address, verifier) => {
      walletAddress = address || null;
      if (verifier) {
        verifyBurnOnChain = verifier;
        enforcePaid = true;
      }
    },
    announcePaid, // initiator: attach the confirmed kick-off proof + announce the wave
    recordBurn, // sign a fee-burn attestation (the kick-off proof for the paid-wave gate)
    async close() {
      clearTimeout(tHeartbeat);
      clearTimeout(tRing);
      clearTimeout(lobbyTimer);
      clearTimeout(waveTimer);
      for (const timer of sweepTimers) {
        clearTimeout(timer);
      }
      await swarm.destroy();
      await session.close();
      await store.close();
    }
  };
}

module.exports = { createWave, parseBootstrap, loadOrCreateSwarmSeed };
