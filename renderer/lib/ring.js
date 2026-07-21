// The field: all <canvas> rendering — the ring, peer dots + flags, the travelling
// spark, and the centre moment. Owns a rAF loop and reads state pushed via the
// setters. No worker/DOM-UI concerns here.
import { flagOf } from './countries.js';

const canvas = document.getElementById('ring');
const ctx = canvas.getContext('2d');
const RING_RADIUS = 170;
const SWEEP_MS = 8000; // replay sweep duration — the spark's lap around the ring
const FLOURISH_MS = 1500; // completion flourish duration (ring pulses + confetti)

// Module state — all declared up front (CLAUDE.md Code Style); each group's behaviour is
// documented at the section that drives it below.
let state = { me: null, peers: [] };
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

// --- geometry ---------------------------------------------------------------
// [x, y] of the point at `angleDeg` on the circle of `orbitRadius` around the canvas centre.
function pointOn(angleDeg, orbitRadius) {
  const radians = ((angleDeg - 90) * Math.PI) / 180; // 0° at top, clockwise
  return [
    canvas.width / 2 + orbitRadius * Math.cos(radians),
    canvas.height / 2 + orbitRadius * Math.sin(radians)
  ];
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

// Ring angle (seat) derived from a hex peer id — mirrors ring.js `angleOf` in the engine
// (top 6 bytes, big-endian, mapped onto [0, 360)). Used to place a gallery entry on the ring.
export function angleOfId(hex) {
  let topBytes = 0;
  for (let i = 0; i < 6; i++) {
    topBytes = topBytes * 256 + parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return (topBytes / 2 ** 48) * 360;
}

// --- the sweep: a local REPLAY sweep, decoupled from the (near-instant) race ---
// The protocol races at network speed; visual pacing lives here. On
// completion the host starts a fixed-duration sweep: the spark rolls clockwise once around the
// ring over SWEEP_MS regardless of N, and each frame we report progress so the gallery can
// feature the moment the spark is passing. When the sweep reaches the end it FREEZES (the spark
// parks and stays); the user can then drag it (see scrubber.js → scrubTo) to browse. `origin`
// is the originator's seat angle (hop 0) — frac 0 sits there, frac 1 completes the lap.
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

function drawBall(angle, asHandle) {
  if (angle === null) {
    return;
  }
  const [ballX, ballY] = pointOn(angle, RING_RADIUS);
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
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  confetti = [];
  for (let i = 0; i < PARTICLES; i++) {
    // start on the ring edge
    const [startX, startY] = pointOn(
      (i / PARTICLES) * 360 + Math.random() * 8,
      RING_RADIUS
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
  // two staggered orange ring pulses expanding outward from the ring
  for (let pulse = 0; pulse < 2; pulse++) {
    const pulseProgress = progress - pulse * 0.18;
    if (pulseProgress < 0 || pulseProgress > 1) {
      continue;
    }
    ctx.beginPath();
    ctx.arc(centerX, centerY, RING_RADIUS + pulseProgress * 70, 0, Math.PI * 2);
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

// A dashed track around the ring while the replay is frozen — signals the ring is now an
// interactive circular scrubber (drag the spark around it to browse the moments).
function drawScrubTrack(centerX, centerY) {
  ctx.save();
  ctx.setLineDash([4, 7]);
  ctx.beginPath();
  ctx.arc(centerX, centerY, RING_RADIUS, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(247,147,26,0.4)';
  ctx.lineWidth = 2;
  ctx.stroke();
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
  const momentRadius = 108; // bigger centre moment (RING_RADIUS=170, so still clears the seats)

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
function render() {
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.beginPath();
  ctx.arc(centerX, centerY, RING_RADIUS, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.stroke();

  for (const peer of state.peers) {
    dot(peer.angle, RING_RADIUS, '#f5f5f5', 6, peer.id.slice(0, 6));
    drawFlagAt(peer.angle, RING_RADIUS + 20, 22, flagOf(peer.country));
  }
  if (state.me) {
    dot(state.me.angle, RING_RADIUS, '#f7931a', 9, 'you');
    drawFlagAt(state.me.angle, RING_RADIUS + 22, 26, flagOf(state.me.country));
  }

  // replay sweep: drive the ball + notify listeners (gallery featuring, scrubber handle)
  if (origin !== null) {
    const progress = currentFrac();
    const frozen = playStart === 0; // sweep finished (or user is scrubbing) → interactive
    const ballAngle = (origin + progress * 360) % 360;
    if (frozen) {
      drawScrubTrack(centerX, centerY);
    }
    drawBall(ballAngle, frozen);
    for (const listener of frameListeners) {
      listener(progress, origin);
    }
  }
  drawCenterMoment(centerX, centerY);
  drawFlourish(centerX, centerY); // celebratory pulse + confetti overlay when a wave just completed
}

export function start() {
  const loop = () => {
    render();
    requestAnimationFrame(loop);
  };
  loop();
}
