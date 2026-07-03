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

// --- the football: rolls clockwise from holder to holder --------------------
let ball = null // { from, to, startedAt }
let ballSeenAt = 0
const TRAVEL_MS = 1100 // ~= the per-hop dwell, so the roll is continuous
const BALL_FADE_MS = 4000 // hide the ball this long after the last position update

function ballAngle() {
  if (!ball) return null
  const p = Math.min(1, (performance.now() - ball.startedAt) / TRAVEL_MS)
  let d = (ball.to - ball.from) % 360
  if (d < 0) d += 360 // always roll clockwise (increasing angle)
  return (ball.from + d * p) % 360
}

export function setBall(toAngle) {
  if (toAngle === null || toAngle === undefined) return
  const from = ball ? ballAngle() : toAngle // continue from where it is, or drop in
  ball = { from, to: toAngle, startedAt: performance.now() }
  ballSeenAt = performance.now()
}

function drawBall() {
  if (!ball) return
  if (performance.now() - ballSeenAt >= BALL_FADE_MS) {
    ball = null
    return
  }
  const a = ballAngle()
  const [bx, by] = pointOn(a, R)
  ctx.save()
  ctx.translate(bx, by)
  ctx.rotate((a * Math.PI) / 180) // spin as it rolls around the ring
  ctx.font = '26px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('⚽', 0, 0)
  ctx.restore()
  ctx.textBaseline = 'alphabetic'
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
  const img = ensureImg(center.image)
  if (center.image && img && img.complete && img.naturalWidth) {
    drawCover(img, cx, cy, rad * 2)
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.06)'
    ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2)
    ctx.fillStyle = '#eafff0'
    ctx.font = '40px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('🌊', cx, cy)
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
  const cap = center.caption || center.peerId.slice(0, 6)
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

  drawBall()
  drawCenterSelfie(cx, cy)

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
