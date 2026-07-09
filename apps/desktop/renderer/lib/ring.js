// The field: all <canvas> rendering — the ring, peer dots + flags, the rolling
// football, and the centre selfie. Owns a rAF loop and reads state pushed via the
// setters. No worker/DOM-UI concerns here.
import { flagOf } from './countries.js'

const canvas = document.getElementById('ring')
const ctx = canvas.getContext('2d')
const meEl = document.getElementById('me')
const R = 170

let state = { me: null, peers: [], successor: null }
let center = null // gallery item shown in the centre (or null)
const imgCache = new Map() // dataURL -> HTMLImageElement

// Captions come from other peers' gallery entries — treat them as untrusted. We render on
// <canvas> (fillText), so HTML/JS injection is already impossible; this strips control &
// bidi-override characters (e.g. U+202E, which can visually spoof/scramble text) and clamps
// the length as defence-in-depth. Newlines/control chars are stripped so a caption stays on
// its single row and can't paint outside it.
function safeCaption(s) {
  return String(s || '')
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .slice(0, 60)
}

// The centre selfie image is peer-supplied and is only ever an inline JPEG dataURL. Reject
// anything else (e.g. a crafted http(s) URL) so a malicious entry can't turn viewers into a
// tracking beacon / leak their IP via a remote fetch. Canvas-only, so no script exec either.
function safeImage(url) {
  return typeof url === 'string' && url.startsWith('data:image/') ? url : ''
}

export function setState(s) {
  state = s
}
export function setCenter(item) {
  center = item
}

// --- geometry ---------------------------------------------------------------
function pointOn(angleDeg, r) {
  const a = ((angleDeg - 90) * Math.PI) / 180 // 0° at top, clockwise
  return [canvas.width / 2 + r * Math.cos(a), canvas.height / 2 + r * Math.sin(a)]
}

function dot(angleDeg, r, color, radius, label) {
  const [x, y] = pointOn(angleDeg, r)
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  if (label) {
    ctx.fillStyle = 'rgba(234,255,240,0.7)'
    ctx.font = '10px ui-monospace, Menlo, monospace'
    ctx.textAlign = 'center'
    ctx.fillText(label, x, y - radius - 4)
  }
}

function drawFlagAt(angleDeg, r, size, flag) {
  if (!flag) return
  const [x, y] = pointOn(angleDeg, r)
  ctx.font = `${size}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(flag, x, y)
  ctx.textBaseline = 'alphabetic'
}

// Ring angle (seat) derived from a hex peer id — mirrors ring.js `angleOf` in the engine
// (top 6 bytes, big-endian, mapped onto [0, 360)). Used to place a gallery entry on the ring.
export function angleOfId(hex) {
  let n = 0
  for (let i = 0; i < 6; i++) n = n * 256 + parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return (n / 2 ** 48) * 360
}

// --- the football: a local REPLAY sweep, decoupled from the (near-instant) race ---
// The protocol races at network speed; visual pacing lives here. On
// completion the host starts a fixed-duration sweep: the ⚽ rolls clockwise once around the
// ring over SWEEP_MS regardless of N, and each frame we report progress so the gallery can
// feature the selfie the ball is passing. When the sweep reaches the end it FREEZES (the ball
// parks and stays); the user can then drag it (see scrubber.js → scrubTo) to browse. `origin`
// is the originator's seat angle (hop 0) — frac 0 sits there, frac 1 completes the lap.
export const SWEEP_MS = 8000

let origin = null // null = no active replay (ball hidden); else the sweep's start angle
let sweepMs = SWEEP_MS
let playStart = 0 // performance.now() while auto-playing; 0 when frozen/scrubbing
let frac = 0 // authoritative progress [0,1] when not auto-playing
const frameListeners = [] // fn(frac, origin) called each render frame while a replay is live

// Register a per-frame progress listener (gallery featuring, scrubber handle).
export function onSweepFrame(fn) {
  frameListeners.push(fn)
}

// Begin the replay sweep from `originAngle` (hop 0's seat). Auto-plays over `ms`.
export function startSweep(originAngle, ms = SWEEP_MS) {
  origin = originAngle ?? 0
  sweepMs = ms
  playStart = performance.now()
  frac = 0
}

// Manual scrub (from the scrubber): pause auto-play and park the ball at `f` ∈ [0,1].
export function scrubTo(f) {
  if (origin === null) return
  playStart = 0 // freeze auto-advance; the user is driving now
  frac = Math.max(0, Math.min(1, f))
}

// The sweep's start angle (hop 0), or null if no replay is active. Used by the scrubber to
// map a pointer angle to a progress fraction.
export function sweepOrigin() {
  return origin
}

// End the replay entirely (hide the ball) — on wave-idle.
export function stopSweep() {
  origin = null
  playStart = 0
  frac = 0
}

function currentFrac() {
  if (origin === null) return 0
  if (playStart) {
    frac = Math.min(1, (performance.now() - playStart) / sweepMs)
    if (frac >= 1) playStart = 0 // reached the end → freeze in place (manual scrub only)
  }
  return frac
}

function drawBall(angle, handle) {
  if (angle === null) return
  const [bx, by] = pointOn(angle, R)
  // when the replay has frozen, the ⚽ is the scrubber handle — draw a grab halo so it reads
  // as draggable (paired with the cursor:grab from scrubber.js and the dashed track below)
  if (handle) {
    ctx.beginPath()
    ctx.arc(bx, by, 20, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255,209,102,0.9)'
    ctx.lineWidth = 2
    ctx.stroke()
  }
  ctx.save()
  ctx.translate(bx, by)
  ctx.rotate((angle * Math.PI) / 180) // spin as it rolls around the ring
  ctx.font = '26px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('⚽', 0, 0)
  ctx.restore()
  ctx.textBaseline = 'alphabetic'
}

// --- completion flourish: a golden ring pulse + light confetti when the wave makes it home ---
let flourish = null // { startedAt } | null
let confetti = [] // particles for the current flourish (browser rAF, so Math.random is fine here)
const FLOURISH_MS = 1500

export function startFlourish() {
  const N = 26
  const cx = canvas.width / 2
  const cy = canvas.height / 2
  confetti = []
  for (let i = 0; i < N; i++) {
    const [sx, sy] = pointOn((i / N) * 360 + Math.random() * 8, R) // start on the ring edge
    const dx = sx - cx
    const dy = sy - cy
    const len = Math.hypot(dx, dy) || 1
    const speed = 70 + Math.random() * 90
    confetti.push({
      x: sx,
      y: sy,
      vx: (dx / len) * speed, // radiate outward from the ring (keeps clear of the centre selfie)
      vy: (dy / len) * speed - 30,
      color: ['#ffd166', '#39d98a', '#eafff0', '#ff8c42'][i % 4],
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 12,
      size: 4 + Math.random() * 4
    })
  }
  flourish = { startedAt: performance.now() }
}

function drawFlourish(cx, cy) {
  if (!flourish) return
  const t = (performance.now() - flourish.startedAt) / FLOURISH_MS
  if (t >= 1) {
    flourish = null
    confetti = []
    return
  }
  // two staggered golden ring pulses expanding outward from the ring
  for (let k = 0; k < 2; k++) {
    const pt = t - k * 0.18
    if (pt < 0 || pt > 1) continue
    ctx.beginPath()
    ctx.arc(cx, cy, R + pt * 70, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(255,209,102,${(1 - pt) * 0.55})`
    ctx.lineWidth = 3
    ctx.stroke()
  }
  // light confetti with gravity, fading out over the flourish
  const tt = (t * FLOURISH_MS) / 1000 // seconds
  const g = 240
  for (const p of confetti) {
    ctx.save()
    ctx.globalAlpha = 1 - t
    ctx.translate(p.x + p.vx * tt, p.y + p.vy * tt + 0.5 * g * tt * tt)
    ctx.rotate(p.rot + p.spin * tt)
    ctx.fillStyle = p.color
    ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6)
    ctx.restore()
  }
  ctx.globalAlpha = 1
}

// A dashed track around the ring while the replay is frozen — signals the ring is now an
// interactive circular scrubber (drag the ⚽ around it to browse the gallery).
function drawScrubTrack(cx, cy) {
  ctx.save()
  ctx.setLineDash([4, 7])
  ctx.beginPath()
  ctx.arc(cx, cy, R, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(255,209,102,0.4)'
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.restore()
}

// --- the centre selfie ------------------------------------------------------
function ensureImg(url) {
  if (!url) return null
  let img = imgCache.get(url)
  if (!img) {
    img = document.createElement('img')
    img.src = url
    imgCache.set(url, img)
  }
  return img
}

function drawCover(img, x, y, size) {
  const ar = img.naturalWidth / img.naturalHeight
  let dw = size
  let dh = size / ar
  if (dh < size) {
    dh = size
    dw = size * ar
  }
  ctx.drawImage(img, x - dw / 2, y - dh / 2, dw, dh)
}

function drawCenterSelfie(cx, cy) {
  if (!center) return
  const rad = 108 // bigger centre selfie (ring R=170, so still clears the seats)

  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, rad, 0, Math.PI * 2)
  ctx.clip()
  const safeSrc = safeImage(center.image)
  const img = ensureImg(safeSrc)
  if (safeSrc && img && img.complete && img.naturalWidth) {
    drawCover(img, cx, cy, rad * 2)
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.06)'
    ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2)
    ctx.fillStyle = '#eafff0'
    ctx.font = '40px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('📷', cx, cy)
    ctx.textBaseline = 'alphabetic'
  }
  ctx.restore()

  ctx.beginPath()
  ctx.arc(cx, cy, rad, 0, Math.PI * 2)
  ctx.strokeStyle = '#ffd166'
  ctx.lineWidth = 3
  ctx.stroke()

  // flag badge (the nation this person supports) at the bottom-right of the selfie
  const flag = flagOf(center.country)
  if (flag) {
    const fx = cx + rad * 0.62
    const fy = cy + rad * 0.62
    ctx.beginPath()
    ctx.arc(fx, fy, 20, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(6,33,13,0.85)'
    ctx.fill()
    ctx.font = '26px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(flag, fx, fy)
    ctx.textBaseline = 'alphabetic'
  }

  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(234,255,240,0.92)'
  ctx.font = '13px -apple-system, sans-serif'
  const cap = safeCaption(center.caption) || center.peerId.slice(0, 6)
  ctx.fillText(`hop ${center.hopCount} · ${cap}`, cx, cy + rad + 20)
}

// --- frame ------------------------------------------------------------------
function render() {
  const cx = canvas.width / 2
  const cy = canvas.height / 2
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  ctx.beginPath()
  ctx.arc(cx, cy, R, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  ctx.lineWidth = 2
  ctx.stroke()

  const succId = state.successor?.id

  // baton direction: line from me to my successor
  if (state.me && state.successor) {
    const [mx, my] = pointOn(state.me.angle, R)
    const [sx, sy] = pointOn(state.successor.angle, R)
    ctx.beginPath()
    ctx.moveTo(mx, my)
    ctx.lineTo(sx, sy)
    ctx.strokeStyle = 'rgba(255,209,102,0.5)'
    ctx.lineWidth = 2
    ctx.stroke()
  }

  for (const p of state.peers) {
    const isSucc = p.id === succId
    dot(
      p.angle,
      R,
      isSucc ? '#ff8c42' : '#39d98a',
      isSucc ? 8 : 6,
      isSucc ? 'next ▸ ' + p.id.slice(0, 6) : p.id.slice(0, 6)
    )
    drawFlagAt(p.angle, R + 20, 22, flagOf(p.country))
  }
  if (state.me) {
    dot(state.me.angle, R, '#ffd166', 9, 'you')
    drawFlagAt(state.me.angle, R + 22, 26, flagOf(state.me.country))
  }

  // replay sweep: drive the ball + notify listeners (gallery featuring, scrubber handle)
  if (origin !== null) {
    const f = currentFrac()
    const frozen = playStart === 0 // sweep finished (or user is scrubbing) → interactive
    const ballAngle = (origin + f * 360) % 360
    if (frozen) drawScrubTrack(cx, cy)
    drawBall(ballAngle, frozen)
    for (const fn of frameListeners) fn(f, origin)
  }
  drawCenterSelfie(cx, cy)
  drawFlourish(cx, cy) // celebratory pulse + confetti overlay when a wave just completed

  if (state.me) {
    meEl.innerText = `you: ${state.me.id.slice(0, 12)}…  @ ${state.me.angle.toFixed(1)}°  ·  ${state.peers.length} peer${state.peers.length === 1 ? '' : 's'}`
  }
}

export function start() {
  const loop = () => {
    render()
    requestAnimationFrame(loop)
  }
  loop()
}
