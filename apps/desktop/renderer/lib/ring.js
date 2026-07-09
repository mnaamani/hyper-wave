// The field: all <canvas> rendering — the ring, peer dots + flags, the rolling
// football, and the centre selfie. Owns a rAF loop and reads state pushed via the
// setters. No worker/DOM-UI concerns here.
import { flagOf } from './countries.js';

const canvas = document.getElementById('ring');
const ctx = canvas.getContext('2d');
const meEl = document.getElementById('me');
const RING_RADIUS = 170;

let state = { me: null, peers: [], successor: null };
let center = null; // gallery item shown in the centre (or null)
const imgCache = new Map(); // dataURL -> HTMLImageElement

// Captions come from other peers' gallery entries — treat them as untrusted. We render on
// <canvas> (fillText), so HTML/JS injection is already impossible; this strips control &
// bidi-override characters (e.g. U+202E, which can visually spoof/scramble text) and clamps
// the length as defence-in-depth. Newlines/control chars are stripped so a caption stays on
// its single row and can't paint outside it.
function safeCaption(text) {
  return String(text || '')
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .slice(0, 60);
}

// The centre selfie image is peer-supplied and is only ever an inline JPEG dataURL. Reject
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
    ctx.fillStyle = 'rgba(234,255,240,0.7)';
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

// --- the football: a local REPLAY sweep, decoupled from the (near-instant) race ---
// The protocol races at network speed; visual pacing lives here. On
// completion the host starts a fixed-duration sweep: the ⚽ rolls clockwise once around the
// ring over SWEEP_MS regardless of N, and each frame we report progress so the gallery can
// feature the selfie the ball is passing. When the sweep reaches the end it FREEZES (the ball
// parks and stays); the user can then drag it (see scrubber.js → scrubTo) to browse. `origin`
// is the originator's seat angle (hop 0) — frac 0 sits there, frac 1 completes the lap.
const SWEEP_MS = 8000;

let origin = null; // null = no active replay (ball hidden); else the sweep's start angle
let sweepMs = SWEEP_MS;
let playStart = 0; // performance.now() while auto-playing; 0 when frozen/scrubbing
let frac = 0; // authoritative progress [0,1] when not auto-playing
const frameListeners = []; // fn(frac, origin) called each render frame while a replay is live

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

function drawBall(angle, asHandle) {
  if (angle === null) {
    return;
  }
  const [ballX, ballY] = pointOn(angle, RING_RADIUS);
  // when the replay has frozen, the ⚽ is the scrubber handle — draw a grab halo so it reads
  // as draggable (paired with the cursor:grab from scrubber.js and the dashed track below)
  if (asHandle) {
    ctx.beginPath();
    ctx.arc(ballX, ballY, 20, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,209,102,0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.save();
  ctx.translate(ballX, ballY);
  ctx.rotate((angle * Math.PI) / 180); // spin as it rolls around the ring
  ctx.font = '26px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('⚽', 0, 0);
  ctx.restore();
  ctx.textBaseline = 'alphabetic';
}

// --- completion flourish: a golden ring pulse + light confetti when the wave makes it home ---
let flourish = null; // { startedAt } | null
let confetti = []; // particles for the current flourish (browser rAF, so Math.random is fine here)
const FLOURISH_MS = 1500;

export function startFlourish() {
  const PARTICLES = 26;
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  confetti = [];
  for (let i = 0; i < PARTICLES; i++) {
    // start on the ring edge
    const [startX, startY] = pointOn((i / PARTICLES) * 360 + Math.random() * 8, RING_RADIUS);
    const offsetX = startX - centerX;
    const offsetY = startY - centerY;
    const distance = Math.hypot(offsetX, offsetY) || 1;
    const speed = 70 + Math.random() * 90;
    confetti.push({
      x: startX,
      y: startY,
      vx: (offsetX / distance) * speed, // radiate outward from the ring (clear of the centre selfie)
      vy: (offsetY / distance) * speed - 30,
      color: ['#ffd166', '#39d98a', '#eafff0', '#ff8c42'][i % 4],
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
  // two staggered golden ring pulses expanding outward from the ring
  for (let pulse = 0; pulse < 2; pulse++) {
    const pulseProgress = progress - pulse * 0.18;
    if (pulseProgress < 0 || pulseProgress > 1) {
      continue;
    }
    ctx.beginPath();
    ctx.arc(centerX, centerY, RING_RADIUS + pulseProgress * 70, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,209,102,${(1 - pulseProgress) * 0.55})`;
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
      particle.y + particle.vy * elapsedSec + 0.5 * GRAVITY * elapsedSec * elapsedSec
    );
    ctx.rotate(particle.rot + particle.spin * elapsedSec);
    ctx.fillStyle = particle.color;
    ctx.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size * 0.6);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

// A dashed track around the ring while the replay is frozen — signals the ring is now an
// interactive circular scrubber (drag the ⚽ around it to browse the gallery).
function drawScrubTrack(centerX, centerY) {
  ctx.save();
  ctx.setLineDash([4, 7]);
  ctx.beginPath();
  ctx.arc(centerX, centerY, RING_RADIUS, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,209,102,0.4)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

// --- the centre selfie ------------------------------------------------------
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
  ctx.drawImage(img, x - drawWidth / 2, y - drawHeight / 2, drawWidth, drawHeight);
}

function drawCenterSelfie(centerX, centerY) {
  if (!center) {
    return;
  }
  const selfieRadius = 108; // bigger centre selfie (RING_RADIUS=170, so still clears the seats)

  ctx.save();
  ctx.beginPath();
  ctx.arc(centerX, centerY, selfieRadius, 0, Math.PI * 2);
  ctx.clip();
  const safeSrc = safeImage(center.image);
  const img = ensureImg(safeSrc);
  if (safeSrc && img && img.complete && img.naturalWidth) {
    drawCover(img, centerX, centerY, selfieRadius * 2);
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(
      centerX - selfieRadius,
      centerY - selfieRadius,
      selfieRadius * 2,
      selfieRadius * 2
    );
    ctx.fillStyle = '#eafff0';
    ctx.font = '40px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('📷', centerX, centerY);
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(centerX, centerY, selfieRadius, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffd166';
  ctx.lineWidth = 3;
  ctx.stroke();

  // flag badge (the nation this person supports) at the bottom-right of the selfie
  const flag = flagOf(center.country);
  if (flag) {
    const flagX = centerX + selfieRadius * 0.62;
    const flagY = centerY + selfieRadius * 0.62;
    ctx.beginPath();
    ctx.arc(flagX, flagY, 20, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(6,33,13,0.85)';
    ctx.fill();
    ctx.font = '26px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(flag, flagX, flagY);
    ctx.textBaseline = 'alphabetic';
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(234,255,240,0.92)';
  ctx.font = '13px -apple-system, sans-serif';
  const caption = safeCaption(center.caption) || center.peerId.slice(0, 6);
  ctx.fillText(`hop ${center.hopCount} · ${caption}`, centerX, centerY + selfieRadius + 20);
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

  const successorId = state.successor?.id;

  // baton direction: line from me to my successor
  if (state.me && state.successor) {
    const [myX, myY] = pointOn(state.me.angle, RING_RADIUS);
    const [succX, succY] = pointOn(state.successor.angle, RING_RADIUS);
    ctx.beginPath();
    ctx.moveTo(myX, myY);
    ctx.lineTo(succX, succY);
    ctx.strokeStyle = 'rgba(255,209,102,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  for (const peer of state.peers) {
    const isSuccessor = peer.id === successorId;
    dot(
      peer.angle,
      RING_RADIUS,
      isSuccessor ? '#ff8c42' : '#39d98a',
      isSuccessor ? 8 : 6,
      isSuccessor ? 'next ▸ ' + peer.id.slice(0, 6) : peer.id.slice(0, 6)
    );
    drawFlagAt(peer.angle, RING_RADIUS + 20, 22, flagOf(peer.country));
  }
  if (state.me) {
    dot(state.me.angle, RING_RADIUS, '#ffd166', 9, 'you');
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
  drawCenterSelfie(centerX, centerY);
  drawFlourish(centerX, centerY); // celebratory pulse + confetti overlay when a wave just completed

  if (state.me) {
    meEl.innerText = `you: ${state.me.id.slice(0, 12)}…  @ ${state.me.angle.toFixed(1)}°  ·  ${state.peers.length} peer${state.peers.length === 1 ? '' : 's'}`;
  }
}

export function start() {
  const loop = () => {
    render();
    requestAnimationFrame(loop);
  };
  loop();
}
