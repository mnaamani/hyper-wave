// The field: all <canvas> rendering — CONCENTRIC RINGS (one per wave), peer dots + flags, the
// travelling spark, and the centre moment. Owns a rAF loop and reads state pushed via the
// setters. No worker/DOM-UI concerns here.
//
// --- why concentric rings ---------------------------------------------------
// The engine has been multi-wave since the scaling work (a multiplexed `Map<waveId, WaveState>`;
// scaling.md), but the UI used to hide that: ONE wave got to be the ring and every other wave was
// a 46px HTML bubble orbiting outside it (the old directory.js, now gone). Here every wave gets
// its own ring instead:
//
//   - The OUTERMOST ring is the topic itself — every peer present, at its seat. Waves are born on
//     it and sit progressively further in, so a wave visibly condenses out of the crowd.
//   - Radius encodes LIFECYCLE, not wall-clock age (a wave's whole life is ~30s, so a clock would
//     dump everything in the centre in under a minute): lobby sits outermost, racing next, ended
//     innermost, where it lingers and fades. Step 2 animates the drift between those bands; today
//     each ring is placed at its band and moves when its phase changes.
//   - The inner floor is the STAGE: the centre moment is never encroached on.
//   - Radius is time; BRIGHTNESS is attention. The active wave is drawn full-strength with its
//     participants' seats and the sweep spark; a wave you have not opened is a thin ghost ring.
//     That keeps browse-then-pick (`autoSubscribe: false`) honest — a ghost ring is visibly
//     something you don't hold cores for.
//
// Because every seat angle is derived locally from the peer id (`angleOfId`, never trusted from
// gossip), the SAME peer sits at the same angle on every ring — so a radial line through the
// rings is one person's participation across waves.
//
// What a ring can show depends on what this peer holds: for a wave we haven't subscribed to we
// know only the initiator and the roster COUNT (that's the whole point of the core budget), so a
// ghost ring draws the initiator's seat and a count. Subscribing fills it in.
import { flagOf } from './countries.js';
import { networkMatches } from './wallet-meta.js';

const canvas = document.getElementById('ring');
const ctx = canvas.getContext('2d');
const SWEEP_MS = 8000; // replay sweep duration — the spark's lap around the active wave's ring
const FLOURISH_MS = 1500; // completion flourish duration (ring pulses + confetti)
// Geometry budget, all in CSS px and all derived from the canvas's live size (the field is
// responsive, so the ring grows with the window instead of sitting in a fixed 440px box).
const OUTER_MARGIN = 36; // room outside the topic ring for its flags
const STAGE_RADIUS = 148; // inner floor: the centre moment (r=108) plus breathing room
const TOPIC_GAP = 28; // clearance between the topic ring and the outermost wave ring
const MIN_RING_GAP = 30; // any closer and two rings read as one
const MAX_RING_GAP = 58;
const HIT_TOLERANCE = 16; // how near a ring a click counts as hitting it
// Inward drift: a ring EASES to the radius its lifecycle asks for instead of jumping there, so a
// wave is seen to travel inward as it forms → races → ends. Exponential smoothing on real elapsed
// time (not per-frame steps), so the motion is identical on a 60Hz and a 120Hz display.
const DRIFT_TAU_MS = 550; // time constant: ~63% of the remaining distance per tau
const DRIFT_SNAP_PX = 0.4; // close enough — stop animating and sit still
const BIRTH_MARGIN = 6; // a new ring is born just inside the topic ring, then drifts in
const DISMISS_RADIUS = 11; // the ✕ badge's hit circle
const DISMISS_INSET = 26; // how far inside its ring the badge sits
const BADGE_PAD = 5; // slack around the badge, so the pointer doesn't fall off its own target
// Lifecycle → band order (0 = outermost). A fading wave sinks below an ended one so the last
// thing it does is fall inward.
const PHASE_RANK = { lobby: 0, racing: 1, ended: 2 };
const PHASE_COLOR = { lobby: '#f7931a', racing: '#f7931a', ended: '#7a6a55' };

// Module state — all declared up front (CLAUDE.md Code Style); each group's behaviour is
// documented at the section that drives it below.
let state = { me: null, peers: [] }; // the topic ring: everyone present
let waves = new Map(); // waveId -> directory meta (from the app core's snapshot)
let activeWaveId = null;
let activeSeats = []; // [{id, country}] participants of the active wave that have posted
let layout = []; // [{waveId, radius, wave}] — recomputed each frame, read by hit-testing
const driftRadii = new Map(); // waveId -> the radius actually on screen, easing toward its target
let lastFrameAt = 0; // performance.now() of the previous frame, for time-based easing
let hoverWaveId = null; // the ring under the pointer — only it shows its ✕ (no permanent clutter)
let cssWidth = 440; // canvas size in CSS px (backing store is this × devicePixelRatio)
let cssHeight = 440;
let center = null; // gallery item shown in the centre (or null)
const imgCache = new Map(); // dataURL -> HTMLImageElement
// replay sweep (see "the sweep" section)
let origin = null; // null = no active replay (ball hidden); else the sweep's start angle
let sweepMs = SWEEP_MS;
let playStart = 0; // performance.now() while auto-playing; 0 when frozen/scrubbing
let frac = 0; // authoritative progress [0,1] when not auto-playing
const frameListeners = []; // fn(frac, origin) called each render frame while a replay is live
// completion flourish (see "completion flourish" section)
let flourish = null; // { startedAt } | null
let confetti = []; // particles for the current flourish (browser rAF, so Math.random is fine here)
// wave selection (see "selection" section)
let onWaveSelectCb = () => {};
let onWaveDismissCb = () => {};

// Captions come from other peers' gallery entries — treat them as untrusted. We render on
// <canvas> (fillText), so HTML/JS injection is already impossible; this strips control &
// bidi-override characters (e.g. U+202E, which can visually spoof/scramble text) and clamps
// the length as defence-in-depth. Newlines/control chars are stripped so a caption stays on
// its single row and can't paint outside it.
function safeCaption(text) {
  return String(text || '')
    .replace(
      /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g,
      ''
    )
    .slice(0, 60);
}

// The centre moment image is peer-supplied and is only ever an inline JPEG dataURL. Reject
// anything else (e.g. a crafted http(s) URL) so a malicious entry can't turn viewers into a
// tracking beacon / leak their IP via a remote fetch. Canvas-only, so no script exec either.
function safeImage(url) {
  return typeof url === 'string' && url.startsWith('data:image/') ? url : '';
}

export function setState(next) {
  state = next;
}
export function setCenter(item) {
  center = item;
}

/**
 * Push the wave directory — one ring per wave. Cross-network waves are HIDDEN here exactly as the
 * old bubble directory hid them: a wave whose settlement network (from its start burn) is a known
 * mismatch with the active wallet's is dropped, so a testnet peer never sees (or can tip into) a
 * mainnet wave. My own waves + unpaid/unknown-network waves always pass (`networkMatches` is
 * permissive).
 * @param {Map<string, Object>} nextWaves The waveId -> metadata map from the app core.
 * @param {string|null} nextActive The active waveId.
 * @returns {void}
 */
export function setWaves(nextWaves, nextActive) {
  waves = nextWaves || new Map();
  activeWaveId = nextActive || null;
}

/**
 * The participants to draw on the ACTIVE wave's ring — those whose moment has landed (we only
 * hold a feed for the wave we're subscribed to, so this is what "who is in this wave" can honestly
 * mean here). The ring fills in as the wave syncs.
 * @param {Array<{id: string, country: string}>} seats The seats to draw.
 * @returns {void}
 */
export function setActiveSeats(seats) {
  activeSeats = seats || [];
}

// --- geometry ---------------------------------------------------------------
// [x, y] of the point at `angleDeg` on the circle of `orbitRadius` around the canvas centre.
function pointOn(angleDeg, orbitRadius) {
  const radians = ((angleDeg - 90) * Math.PI) / 180; // 0° at top, clockwise
  return [
    cssWidth / 2 + orbitRadius * Math.cos(radians),
    cssHeight / 2 + orbitRadius * Math.sin(radians)
  ];
}

// The topic ring's radius — the outermost circle, sized to whatever the field currently is.
function topicRadius() {
  return Math.max(
    STAGE_RADIUS + TOPIC_GAP,
    Math.min(cssWidth, cssHeight) / 2 - OUTER_MARGIN
  );
}

function dot(angleDeg, orbitRadius, color, dotRadius, label) {
  const [x, y] = pointOn(angleDeg, orbitRadius);
  ctx.beginPath();
  ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  if (label) {
    ctx.fillStyle = 'rgba(245,245,245,0.7)';
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, x, y - dotRadius - 4);
  }
}

function drawFlagAt(angleDeg, orbitRadius, size, flag) {
  if (!flag) {
    return;
  }
  const [x, y] = pointOn(angleDeg, orbitRadius);
  ctx.font = `${size}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(flag, x, y);
  ctx.textBaseline = 'alphabetic';
}

// A peer id -> its country, resolved from the topic ring we already hold (this is what the old
// directory.js needed a callback from app.js for; here the ring owns both, so it just looks up).
function countryOfPeer(peerId) {
  if (!peerId) {
    return '';
  }
  if (state.me && state.me.id === peerId) {
    return state.me.country;
  }
  const peer = state.peers.find((one) => one.id === peerId);
  return peer ? peer.country : '';
}

// Ring angle (seat) derived from a hex peer id — mirrors ring.js `angleOf` in the engine
// (top 6 bytes, big-endian, mapped onto [0, 360)). Used to place a gallery entry on the ring.
export function angleOfId(hex) {
  let topBytes = 0;
  for (let i = 0; i < 6; i++) {
    topBytes = topBytes * 256 + parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return (topBytes / 2 ** 48) * 360;
}

// --- ring layout ------------------------------------------------------------
// Order the visible waves by lifecycle (lobby outermost → fading innermost), then hand each a
// radius stepping inward from just inside the topic ring. Ties break on waveId so the order is
// stable frame to frame (and so two peers watching the same waves see the same picture).

function rankOf(wave) {
  const base = PHASE_RANK[wave.phase] ?? 1;
  return wave.fading ? base + 1 : base;
}

function visibleWaves() {
  const list = [...waves.values()].filter(
    (wave) => wave.mine || networkMatches(wave.network)
  );
  list.sort((left, right) => {
    const byRank = rankOf(left) - rankOf(right);
    if (byRank !== 0) {
      return byRank;
    }
    return String(left.waveId).localeCompare(String(right.waveId));
  });
  return list;
}

// How many rings actually fit between the outermost wave band and the stage floor. Anything past
// this is NOT drawn — and the caller says so on screen rather than silently dropping it.
function ringCapacity(outermost) {
  const span = outermost - STAGE_RADIUS;
  return Math.max(1, Math.floor(span / MIN_RING_GAP) + 1);
}

// Where a wave's ring WANTS to be. A fading wave always targets the floor: the last thing it does
// is fall inward and wink out, rather than sliding sideways into some middle band.
function targetRadiusOf({ wave, index, outermost, gap }) {
  if (wave.fading) {
    return STAGE_RADIUS;
  }
  return Math.max(STAGE_RADIUS, outermost - index * gap);
}

// Ease `current` toward `target` over `elapsedMs`. Frame-rate independent: the fraction covered
// depends on elapsed TIME, so a 120Hz display doesn't drift twice as fast as a 60Hz one.
function easeToward({ current, target, elapsedMs }) {
  const distance = target - current;
  if (Math.abs(distance) < DRIFT_SNAP_PX) {
    return target;
  }
  return current + distance * (1 - Math.exp(-elapsedMs / DRIFT_TAU_MS));
}

function computeLayout(elapsedMs) {
  const outermost = topicRadius() - TOPIC_GAP;
  const list = visibleWaves();
  const capacity = ringCapacity(outermost);
  const shown = list.slice(0, capacity);
  const span = outermost - STAGE_RADIUS;
  const gap = Math.max(
    MIN_RING_GAP,
    Math.min(MAX_RING_GAP, shown.length > 1 ? span / (shown.length - 1) : span)
  );
  const live = new Set();
  const rings = shown.map((wave, index) => {
    const target = targetRadiusOf({ wave, index, outermost, gap });
    // A ring the user has never seen is BORN on the topic ring — the crowd it condensed out of —
    // and drifts to its band from there, so arrival reads as "a wave formed out there".
    const current = driftRadii.has(wave.waveId)
      ? driftRadii.get(wave.waveId)
      : topicRadius() - BIRTH_MARGIN;
    const radius = easeToward({ current, target, elapsedMs });
    driftRadii.set(wave.waveId, radius);
    live.add(wave.waveId);
    return { waveId: wave.waveId, wave, radius, target };
  });
  // Forget rings that are no longer drawn (dropped, dismissed, or pushed out of the radial
  // budget), so a wave that ever comes back is born again rather than teleporting from a stale
  // position — and so the map can't grow without bound over a long session.
  for (const waveId of [...driftRadii.keys()]) {
    if (!live.has(waveId)) {
      driftRadii.delete(waveId);
    }
  }
  return { rings, hidden: list.length - shown.length };
}

// The radius the active wave's ring sits at — where the spark rides and the flourish pulses from.
// Falls back to the topic ring when no wave is active (e.g. a replay left over from a dropped one).
function activeRadius() {
  const found = layout.find((entry) => entry.waveId === activeWaveId);
  return found ? found.radius : topicRadius();
}

// --- selection: a ring is the click target the old orbit bubble used to be ---
/**
 * Register the click handler — app.js's core.selectWave(waveId) subscribes + activates.
 * @param {(waveId: string) => void} cb The selection callback.
 * @returns {void}
 */
export function onWaveSelect(cb) {
  onWaveSelectCb = cb;
}

/**
 * Register the dismiss handler — app.js's core.dismissWave(waveId) frees the wave's cores and
 * drops it for good.
 * @param {(waveId: string) => void} cb The dismiss callback.
 * @returns {void}
 */
export function onWaveDismiss(cb) {
  onWaveDismissCb = cb;
}

// Canvas-local [x, y] of a viewport point.
function localPoint(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return [clientX - rect.left, clientY - rect.top];
}

// Where a ring's ✕ badge sits: just INSIDE the ring at the initiator's seat angle, i.e. in the
// band between it and the next ring in, where nothing else is drawn.
function dismissPointOf(entry) {
  const angle = entry.wave.by ? angleOfId(entry.wave.by) : 0;
  return pointOn(angle, Math.max(0, entry.radius - DISMISS_INSET));
}

// Whose ✕ badge covers this viewport point — checked against EVERY drawn ring, not just the
// hovered one, because this is also what KEEPS a ring hovered while the pointer is on its badge.
// The badge sits inside the ring, outside its hit band: without this the badge would vanish the
// moment you moved off the ring line toward it, and could never be clicked.
function badgeWaveAt(clientX, clientY) {
  const [x, y] = localPoint(clientX, clientY);
  for (const entry of layout) {
    const [badgeX, badgeY] = dismissPointOf(entry);
    if (Math.hypot(x - badgeX, y - badgeY) <= DISMISS_RADIUS + BADGE_PAD) {
      return entry.waveId;
    }
  }
  return null;
}

// The ✕ under a viewport point, if any. Only the HOVERED ring shows one, so only it can be hit —
// a badge you can't see must not be clickable.
function dismissAt(clientX, clientY) {
  const waveId = badgeWaveAt(clientX, clientY);
  return waveId && waveId === hoverWaveId ? waveId : null;
}

// What the pointer is over: a ring's badge, else the ring nearest it (ANY ring, the active one
// included). Badges win, so travelling from a ring to its own ✕ never breaks the hover.
function ringAt(clientX, clientY) {
  const onBadge = badgeWaveAt(clientX, clientY);
  if (onBadge) {
    return onBadge;
  }
  const [x, y] = localPoint(clientX, clientY);
  const distance = Math.hypot(x - cssWidth / 2, y - cssHeight / 2);
  let best = null;
  let bestDelta = HIT_TOLERANCE;
  for (const entry of layout) {
    const delta = Math.abs(distance - entry.radius);
    if (delta <= bestDelta) {
      best = entry.waveId;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * Whether a press at this point belongs to the rings (a selection or a dismiss) rather than to the
 * scrubber. The scrubber asks before starting a drag, so a click on another wave's ring — or on a
 * ✕ — never doubles as a scrub of the active one.
 * @param {number} clientX Viewport x.
 * @param {number} clientY Viewport y.
 * @returns {boolean} True if the rings claim this press.
 */
export function claimsPointer(clientX, clientY) {
  if (dismissAt(clientX, clientY)) {
    return true;
  }
  return selectableWaveAt(clientX, clientY) !== null;
}

/**
 * Which OTHER wave's ring (if any) a viewport point lands on — "other" because a press on the
 * active ring is a scrub, not a selection. Exported so the scrubber can stand down for presses
 * that are really selections.
 * @param {number} clientX Viewport x.
 * @param {number} clientY Viewport y.
 * @returns {string|null} The waveId to select, or null.
 */
export function selectableWaveAt(clientX, clientY) {
  const [x, y] = localPoint(clientX, clientY);
  const distance = Math.hypot(x - cssWidth / 2, y - cssHeight / 2);
  let best = null;
  let bestDelta = HIT_TOLERANCE;
  for (const entry of layout) {
    if (entry.waveId === activeWaveId) {
      continue; // the active ring belongs to the scrubber
    }
    const delta = Math.abs(distance - entry.radius);
    if (delta <= bestDelta) {
      best = entry.waveId;
      bestDelta = delta;
    }
  }
  return best;
}

function onCanvasClick(ev) {
  // the ✕ wins over selection: it sits inside the ring's own hit band
  const dismissId = dismissAt(ev.clientX, ev.clientY);
  if (dismissId) {
    onWaveDismissCb(dismissId);
    hoverWaveId = null;
    return;
  }
  const waveId = selectableWaveAt(ev.clientX, ev.clientY);
  if (waveId) {
    onWaveSelectCb(waveId);
  }
}

function onCanvasPointerMove(ev) {
  hoverWaveId = ringAt(ev.clientX, ev.clientY);
}

// A touch/pen tap produces no hover pass at all, so resolve it at press time too — otherwise the ✕
// would be unreachable on a touchscreen.
function onCanvasPointerDown(ev) {
  hoverWaveId = ringAt(ev.clientX, ev.clientY);
}

function onCanvasPointerLeave() {
  hoverWaveId = null;
}

// --- the sweep: a local REPLAY sweep, decoupled from the (near-instant) race ---
// The protocol races at network speed; visual pacing lives here. On
// completion the host starts a fixed-duration sweep: the spark rolls clockwise once around the
// ACTIVE WAVE'S ring over SWEEP_MS regardless of N, and each frame we report progress so the
// gallery can feature the moment the spark is passing. When the sweep reaches the end it FREEZES
// (the spark parks and stays); the user can then drag it (see scrubber.js → scrubTo) to browse.
// `origin` is the originator's seat angle (hop 0) — frac 0 sits there, frac 1 completes the lap.
// (State: origin/sweepMs/playStart/frac/frameListeners, declared at the top of the module.)

// Register a per-frame progress listener (gallery featuring, scrubber handle).
export function onSweepFrame(fn) {
  frameListeners.push(fn);
}

// Begin the replay sweep from `originAngle` (hop 0's seat). Auto-plays over `durationMs`.
export function startSweep(originAngle, durationMs = SWEEP_MS) {
  origin = originAngle ?? 0;
  sweepMs = durationMs;
  playStart = performance.now();
  frac = 0;
}

// Manual scrub (from the scrubber): pause auto-play and park the ball at `fraction` ∈ [0,1].
export function scrubTo(fraction) {
  if (origin === null) {
    return;
  }
  playStart = 0; // freeze auto-advance; the user is driving now
  frac = Math.max(0, Math.min(1, fraction));
}

// The sweep's start angle (hop 0), or null if no replay is active. Used by the scrubber to
// map a pointer angle to a progress fraction.
export function sweepOrigin() {
  return origin;
}

// End the replay entirely (hide the ball) — on wave-idle.
export function stopSweep() {
  origin = null;
  playStart = 0;
  frac = 0;
}

function currentFrac() {
  if (origin === null) {
    return 0;
  }
  if (playStart) {
    frac = Math.min(1, (performance.now() - playStart) / sweepMs);
    if (frac >= 1) {
      playStart = 0; // reached the end → freeze in place (manual scrub only)
    }
  }
  return frac;
}

// The travelling marker is an orange spark (the ⚡ motif): a glowing bitcoin-orange
// core with a soft halo, drawn purely on-canvas so it matches the palette exactly.
function drawSpark(x, y) {
  ctx.save();
  ctx.shadowColor = 'rgba(247,147,26,0.9)';
  ctx.shadowBlur = 18;
  const glow = ctx.createRadialGradient(x, y, 0, x, y, 11);
  glow.addColorStop(0, '#ffd9a3');
  glow.addColorStop(0.5, '#f7931a');
  glow.addColorStop(1, 'rgba(247,147,26,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBall(angle, orbitRadius, asHandle) {
  if (angle === null) {
    return;
  }
  const [ballX, ballY] = pointOn(angle, orbitRadius);
  // when the replay has frozen, the spark is the scrubber handle — draw a grab halo so it reads
  // as draggable (paired with the cursor:grab from scrubber.js and the dashed track below)
  if (asHandle) {
    ctx.beginPath();
    ctx.arc(ballX, ballY, 20, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(247,147,26,0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  drawSpark(ballX, ballY);
}

// --- completion flourish: an orange ring pulse + light confetti when the wave makes it home ---
// (State: flourish/confetti, declared at the top of the module.)
export function startFlourish() {
  const PARTICLES = 26;
  const centerX = cssWidth / 2;
  const centerY = cssHeight / 2;
  const radius = activeRadius();
  confetti = [];
  for (let i = 0; i < PARTICLES; i++) {
    // start on the active wave's ring edge
    const [startX, startY] = pointOn(
      (i / PARTICLES) * 360 + Math.random() * 8,
      radius
    );
    const offsetX = startX - centerX;
    const offsetY = startY - centerY;
    const distance = Math.hypot(offsetX, offsetY) || 1;
    const speed = 70 + Math.random() * 90;
    confetti.push({
      x: startX,
      y: startY,
      vx: (offsetX / distance) * speed, // radiate outward from the ring (clear of the centre moment)
      vy: (offsetY / distance) * speed - 30,
      color: ['#f7931a', '#ffb04d', '#f5f5f5', '#ff8c42'][i % 4],
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 12,
      size: 4 + Math.random() * 4
    });
  }
  flourish = { startedAt: performance.now() };
}

function drawFlourish(centerX, centerY) {
  if (!flourish) {
    return;
  }
  const progress = (performance.now() - flourish.startedAt) / FLOURISH_MS;
  if (progress >= 1) {
    flourish = null;
    confetti = [];
    return;
  }
  const radius = activeRadius();
  // two staggered orange ring pulses expanding outward from the active wave's ring
  for (let pulse = 0; pulse < 2; pulse++) {
    const pulseProgress = progress - pulse * 0.18;
    if (pulseProgress < 0 || pulseProgress > 1) {
      continue;
    }
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius + pulseProgress * 70, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(247,147,26,${(1 - pulseProgress) * 0.55})`;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  // light confetti with gravity, fading out over the flourish
  const elapsedSec = (progress * FLOURISH_MS) / 1000;
  const GRAVITY = 240;
  for (const particle of confetti) {
    ctx.save();
    ctx.globalAlpha = 1 - progress;
    ctx.translate(
      particle.x + particle.vx * elapsedSec,
      particle.y +
        particle.vy * elapsedSec +
        0.5 * GRAVITY * elapsedSec * elapsedSec
    );
    ctx.rotate(particle.rot + particle.spin * elapsedSec);
    ctx.fillStyle = particle.color;
    ctx.fillRect(
      -particle.size / 2,
      -particle.size / 2,
      particle.size,
      particle.size * 0.6
    );
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

// A dashed track around the active ring while the replay is frozen — signals it is now an
// interactive circular scrubber (drag the spark around it to browse the moments).
function drawScrubTrack(centerX, centerY, orbitRadius) {
  ctx.save();
  ctx.setLineDash([4, 7]);
  ctx.beginPath();
  ctx.arc(centerX, centerY, orbitRadius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(247,147,26,0.4)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

// --- the rings --------------------------------------------------------------
// The topic ring: everyone present on the shared topic, at their true seats. Waves are born here.
function drawTopicRing() {
  const radius = topicRadius();
  ctx.beginPath();
  ctx.arc(cssWidth / 2, cssHeight / 2, radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.stroke();

  for (const peer of state.peers) {
    dot(peer.angle, radius, '#f5f5f5', 6, peer.id.slice(0, 6));
    drawFlagAt(peer.angle, radius + 20, 22, flagOf(peer.country));
  }
  if (state.me) {
    dot(state.me.angle, radius, '#f7931a', 9, 'you');
    drawFlagAt(state.me.angle, radius + 22, 26, flagOf(state.me.country));
  }
}

// The label that replaced the orbit bubble: the initiator's flag, roster count and phase, sat on
// the ring at the initiator's own seat angle.
function drawWaveLabel(entry, isActive) {
  const { wave, radius } = entry;
  const angle = wave.by ? angleOfId(wave.by) : 0;
  const [x, y] = pointOn(angle, radius);
  const flag = flagOf(countryOfPeer(wave.by)) || '🌐';
  const count = wave.count || 1;

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, isActive ? 15 : 12, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(20,12,4,0.92)';
  ctx.fill();
  ctx.strokeStyle = PHASE_COLOR[wave.phase] || '#666';
  ctx.lineWidth = isActive ? 2.5 : 1.5;
  ctx.stroke();
  ctx.font = `${isActive ? 17 : 14}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(flag, x, y);
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = isActive ? '#ffb04d' : 'rgba(245,245,245,0.6)';
  ctx.font = '10px ui-monospace, Menlo, monospace';
  const label = `${wave.mine ? 'you' : 'wave'} · ${count}`;
  ctx.fillText(label, x, y + (isActive ? 30 : 26));

  // What the initiator said this wave is about — drawn only for the ACTIVE ring and the one under
  // the pointer, so browsing reveals it without every ring shouting at once. Untrusted text: it
  // goes through the same sanitizer a caption does (canvas fillText, so no injection either way).
  const message = safeCaption(wave.message);
  if (message && (isActive || wave.waveId === hoverWaveId)) {
    ctx.fillStyle = '#ffb04d';
    ctx.font = 'italic 12px -apple-system, sans-serif';
    ctx.fillText(message, x, y + (isActive ? 46 : 42));
  }
  ctx.restore();
}

// One wave = one ring. The active one is drawn full-strength with its participants' seats; the
// rest are thin dashed ghosts (we hold no cores for them — see the module header).
function drawWaveRing(entry) {
  const { wave, radius } = entry;
  const isActive = wave.waveId === activeWaveId;
  const color = PHASE_COLOR[wave.phase] || '#666';
  let alpha = isActive ? 1 : 0.4;
  if (wave.fading) {
    alpha *= 0.4;
  }

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(cssWidth / 2, cssHeight / 2, radius, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = isActive ? 2.5 : 1;
  if (!isActive) {
    ctx.setLineDash([3, 7]);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  if (isActive) {
    // the seats of everyone whose moment has landed — the ring fills in as the wave syncs
    for (const seat of activeSeats) {
      const angle = angleOfId(seat.id);
      dot(angle, radius, '#f5f5f5', 5, null);
      drawFlagAt(angle, radius - 18, 16, flagOf(seat.country));
    }
  }
  drawWaveLabel(entry, isActive);
  if (entry.waveId === hoverWaveId) {
    drawDismissBadge(entry);
  }
  ctx.restore();
}

// The dismiss affordance: a ✕ shown only on the ring under the pointer, so the field stays clean
// until you reach for one. Clicking it frees that wave's cores and drops it for good — the manual
// counterpart of the automatic linger → fade → drop, available at any phase.
function drawDismissBadge(entry) {
  const [x, y] = dismissPointOf(entry);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(x, y, DISMISS_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(20,12,4,0.95)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(245,245,245,0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = 'rgba(245,245,245,0.9)';
  ctx.font = '13px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('✕', x, y);
  ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

// Anything past the radial budget isn't drawn — say so rather than silently dropping waves.
function drawHiddenCount(hidden) {
  if (hidden <= 0) {
    return;
  }
  ctx.save();
  ctx.fillStyle = 'rgba(245,245,245,0.55)';
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(
    `+${hidden} more wave${hidden === 1 ? '' : 's'} (no room to draw)`,
    cssWidth / 2,
    cssHeight - 8
  );
  ctx.restore();
}

// --- the centre moment ------------------------------------------------------
function ensureImg(url) {
  if (!url) {
    return null;
  }
  let img = imgCache.get(url);
  if (!img) {
    img = document.createElement('img');
    img.src = url;
    imgCache.set(url, img);
  }
  return img;
}

// Draw `img` centred at (x, y), scaled to cover a size×size square (like CSS object-fit: cover).
function drawCover(img, x, y, size) {
  const aspect = img.naturalWidth / img.naturalHeight;
  let drawWidth = size;
  let drawHeight = size / aspect;
  if (drawHeight < size) {
    drawHeight = size;
    drawWidth = size * aspect;
  }
  ctx.drawImage(
    img,
    x - drawWidth / 2,
    y - drawHeight / 2,
    drawWidth,
    drawHeight
  );
}

function drawCenterMoment(centerX, centerY) {
  if (!center) {
    return;
  }
  const momentRadius = 108; // the stage — STAGE_RADIUS keeps every ring clear of it

  ctx.save();
  ctx.beginPath();
  ctx.arc(centerX, centerY, momentRadius, 0, Math.PI * 2);
  ctx.clip();
  const safeSrc = safeImage(center.image);
  const img = ensureImg(safeSrc);
  if (safeSrc && img && img.complete && img.naturalWidth) {
    drawCover(img, centerX, centerY, momentRadius * 2);
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(
      centerX - momentRadius,
      centerY - momentRadius,
      momentRadius * 2,
      momentRadius * 2
    );
    ctx.fillStyle = '#f5f5f5';
    ctx.font = '40px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('📷', centerX, centerY);
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(centerX, centerY, momentRadius, 0, Math.PI * 2);
  ctx.strokeStyle = '#f7931a';
  ctx.lineWidth = 3;
  ctx.stroke();

  // flag badge (the country this person is in) at the bottom-right of the moment
  const flag = flagOf(center.country);
  if (flag) {
    const flagX = centerX + momentRadius * 0.62;
    const flagY = centerY + momentRadius * 0.62;
    ctx.beginPath();
    ctx.arc(flagX, flagY, 20, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20,12,4,0.85)';
    ctx.fill();
    ctx.font = '26px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(flag, flagX, flagY);
    ctx.textBaseline = 'alphabetic';
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(245,245,245,0.92)';
  ctx.font = '13px -apple-system, sans-serif';
  const caption = safeCaption(center.caption) || center.peerId.slice(0, 6);
  ctx.fillText(
    `hop ${center.hopCount} · ${caption}`,
    centerX,
    centerY + momentRadius + 20
  );
}

// --- frame ------------------------------------------------------------------
// The field is responsive, so the backing store is resized to its CSS box (× devicePixelRatio)
// and every coordinate below is CSS px — one transform, set once per resize.
function resize() {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  if (!rect.width || !rect.height) {
    return;
  }
  cssWidth = rect.width;
  cssHeight = rect.height;
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function render() {
  const centerX = cssWidth / 2;
  const centerY = cssHeight / 2;
  const frameAt = performance.now();
  // Real elapsed time drives the drift. Clamped: a backgrounded window can hand us a gap of many
  // seconds, and without the clamp every ring would teleport to its target on the first frame back
  // (the animation would be skipped exactly when the user returns to look at it).
  const elapsedMs = Math.min(100, lastFrameAt ? frameAt - lastFrameAt : 16);
  const computed = computeLayout(elapsedMs);
  lastFrameAt = frameAt;
  layout = computed.rings; // cached for hit-testing between frames
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  drawTopicRing();
  for (const entry of layout) {
    drawWaveRing(entry);
  }
  drawHiddenCount(computed.hidden);

  // replay sweep on the ACTIVE wave's ring: drive the ball + notify listeners (gallery featuring,
  // scrubber handle)
  if (origin !== null) {
    const progress = currentFrac();
    const frozen = playStart === 0; // sweep finished (or user is scrubbing) → interactive
    const ballAngle = (origin + progress * 360) % 360;
    const radius = activeRadius();
    if (frozen) {
      drawScrubTrack(centerX, centerY, radius);
    }
    drawBall(ballAngle, radius, frozen);
    for (const listener of frameListeners) {
      listener(progress, origin);
    }
  }
  drawCenterMoment(centerX, centerY);
  drawFlourish(centerX, centerY); // celebratory pulse + confetti overlay when a wave just completed
}

export function start() {
  resize();
  new window.ResizeObserver(resize).observe(canvas);
  canvas.addEventListener('click', onCanvasClick);
  canvas.addEventListener('pointermove', onCanvasPointerMove);
  canvas.addEventListener('pointerdown', onCanvasPointerDown);
  canvas.addEventListener('pointerleave', onCanvasPointerLeave);
  const loop = () => {
    render();
    requestAnimationFrame(loop);
  };
  loop();
}
