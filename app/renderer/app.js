const bridge = window.bridge
const decoder = new TextDecoder('utf-8')

document.getElementById('v').innerText = 'v' + bridge.pkg().version

const statusEl = document.getElementById('status')
const meEl = document.getElementById('me')
const canvas = document.getElementById('ring')
const ctx = canvas.getContext('2d')

let state = { me: null, peers: [] }

// --- HyperWave worker: discovery + ring state ---------------------------------
const HYPERWAVE = '/workers/hyperwave.js'
bridge.startWorker(HYPERWAVE)

const startBtn = document.getElementById('start')
let ballActive = false // is the football currently animating on the ring?
let waveActive = false // is a wave in progress (single active wave at a time)?

bridge.onWorkerIPC(HYPERWAVE, (data) => {
  let msg
  try {
    msg = JSON.parse(decoder.decode(data))
  } catch {
    return
  }
  if (msg.type === 'state') {
    state = msg
    if (!waveActive) setIdleStatus()
  } else if (msg.type === 'token') {
    onTokenEvent(msg)
  } else if (msg.type === 'gallery') {
    handleGallery(msg.items)
  }
})

function setIdleStatus() {
  const n = state.peers.length
  statusEl.innerText =
    n === 0
      ? 'in the ring — waiting for peers…'
      : `${n} peer${n === 1 ? '' : 's'} in the ring — kick off a wave`
}

function onTokenEvent(e) {
  switch (e.event) {
    case 'wave-announce':
      waveActive = true
      startBtn.disabled = true
      openLobby(e)
      break
    case 'joined':
      lobbyJoined = true
      joinBtn.style.display = 'none'
      updateLobby(e.count)
      break
    case 'roster':
      updateLobby(e.count)
      break
    case 'wave-active':
      waveActive = true
      startBtn.disabled = true
      closeLobby()
      statusEl.innerText = e.joined ? '📣 you are in — get ready!' : '👀 spectating this wave'
      break
    case 'wave-idle':
      waveActive = false
      startBtn.disabled = false
      closeLobby()
      setIdleStatus()
      break
    case 'busy':
      statusEl.innerText = '⏳ a wave is already forming — wait for it to finish'
      break
    case 'started':
      statusEl.innerText = '⚽ the wave is off!'
      break
    case 'holding':
      statusEl.innerText = e.canSelfie
        ? `📸 your turn! — hop ${e.hopCount ?? ''}`
        : `wave passing you — hop ${e.hopCount ?? ''}`
      setBall(e.angle) // roll the football to my seat
      if (e.canSelfie) openProofWindow(e) // only opted-in peers selfie
      break
    case 'position':
      statusEl.innerText = `wave rolling — hop ${e.hopCount ?? ''}`
      setBall(e.angle) // roll the football to the current holder
      break
    case 'completed':
      statusEl.innerText = `✅ wave completed — ${e.hops} hops, chain ${e.chainHash.slice(0, 8)}…`
      setBall(e.angle) // roll it home to the originator
      break
    case 'healed':
      statusEl.innerText = '🩹 routing around a dropped peer…'
      break
    case 'gallery-error':
      statusEl.innerText = `⚠️ couldn't post your selfie (${e.reason})`
      break
    case 'stalled':
      statusEl.innerText = `⚠️ wave stalled (${e.reason})`
      break
  }
}

startBtn.onclick = () => {
  bridge.writeWorkerIPC(HYPERWAVE, JSON.stringify({ type: 'start-wave' }))
}

// --- lobby (opt in before the wave starts) ------------------------------------
const lobbyEl = document.getElementById('lobby')
const lobbyMsgEl = document.getElementById('lobby-msg')
const lobbySubEl = document.getElementById('lobby-sub')
const joinBtn = document.getElementById('join')
let lobbyCount = 0
let lobbyJoined = false
let lobbyDeadline = 0
let lobbyTimer = null

function openLobby(e) {
  lobbyCount = e.count || 1
  lobbyJoined = !!e.mine || !!e.joined
  lobbyDeadline = performance.now() + (e.lobbyMs || 15000)
  lobbyMsgEl.innerText = e.mine ? '📣 you are forming a wave' : '🌊 a wave is forming — join in?'
  joinBtn.style.display = lobbyJoined ? 'none' : 'inline-block'
  joinBtn.disabled = false
  lobbyEl.classList.add('show')
  clearInterval(lobbyTimer)
  lobbyTimer = setInterval(paintLobby, 200)
  paintLobby()
}

function updateLobby(count) {
  if (typeof count === 'number') lobbyCount = count
  paintLobby()
}

function paintLobby() {
  if (!lobbyEl.classList.contains('show')) return
  const secs = Math.max(0, Math.ceil((lobbyDeadline - performance.now()) / 1000))
  lobbySubEl.innerText = `starting in ${secs}s · ${lobbyCount} in`
}

function closeLobby() {
  clearInterval(lobbyTimer)
  lobbyEl.classList.remove('show')
}

joinBtn.onclick = () => {
  lobbyJoined = true
  joinBtn.style.display = 'none'
  bridge.writeWorkerIPC(HYPERWAVE, JSON.stringify({ type: 'join-wave' }))
}
bridge.onWorkerStdout(HYPERWAVE, (d) => console.log('[hyperwave]', decoder.decode(d)))
bridge.onWorkerStderr(HYPERWAVE, (d) => console.error('[hyperwave]', decoder.decode(d)))

// --- OTA updater worker (kept from template) ----------------------------------
const UPDATER = '/workers/main.js'
bridge.startWorker(UPDATER)
bridge.onWorkerIPC(UPDATER, (data) => {
  const m = decoder.decode(data)
  if (m === 'updating') statusEl.innerText = 'updating…'
})

// --- Proof window: webcam selfie ---------------------------------------------
const modal = document.getElementById('modal')
const preview = document.getElementById('preview')
const countdownEl = document.getElementById('countdown')
const captionEl = document.getElementById('caption')
const snap = document.getElementById('snap')

let stream = null
let proofCtx = null // { waveId, hopCount, receiptSig, chainHash }
let countdownTimer = null

async function openProofWindow(e) {
  if (proofCtx) return // already capturing for a hop; ignore re-entry
  proofCtx = {
    waveId: e.waveId,
    hopCount: e.hopCount,
    receiptSig: e.receiptSig,
    chainHash: e.chainHash,
    receiptTs: e.receiptTs
  }
  document.getElementById('modal-sub').innerText = `Hop ${e.hopCount} — you're in the chain.`
  captionEl.value = ''
  modal.classList.add('show')

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    preview.srcObject = stream
  } catch (err) {
    // no camera / denied — still allow posting a placeholder so the flow works
    console.warn('camera unavailable:', err.message)
    preview.style.display = 'none'
  }

  // auto-capture after a short countdown (feels like a stadium moment)
  let n = 5
  countdownEl.innerText = n
  countdownTimer = setInterval(() => {
    n -= 1
    countdownEl.innerText = n > 0 ? n : ''
    if (n <= 0) {
      clearInterval(countdownTimer)
      capture()
    }
  }, 1000)
}

function capture() {
  if (!proofCtx) return
  let image = ''
  if (stream) {
    const sctx = snap.getContext('2d')
    // mirror to match the preview
    sctx.save()
    sctx.scale(-1, 1)
    sctx.drawImage(preview, -snap.width, 0, snap.width, snap.height)
    sctx.restore()
    image = snap.toDataURL('image/jpeg', 0.5)
  }
  bridge.writeWorkerIPC(
    HYPERWAVE,
    JSON.stringify({
      type: 'post-selfie',
      selfie: { ...proofCtx, caption: captionEl.value, image }
    })
  )
  closeProofWindow()
}

function closeProofWindow() {
  if (countdownTimer) clearInterval(countdownTimer)
  if (stream) {
    for (const t of stream.getTracks()) t.stop()
    stream = null
  }
  preview.style.display = ''
  modal.classList.remove('show')
  proofCtx = null
}

document.getElementById('capture').onclick = capture
document.getElementById('skip').onclick = closeProofWindow

// --- Gallery: one selfie at a time in the centre of the ring ------------------
// New selfies (as they land in the Autobase) jump to the centre — the faces light
// up following the wave. When no new ones arrive we auto-cycle through the rest.
let galleryItems = []
let centerIdx = 0
const shownKeys = new Set() // waveId|peerId already displayed
const imgCache = new Map() // dataURL -> HTMLImageElement
let advanceTimer = null
const ADVANCE_MS = 3500

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

function scheduleAdvance() {
  clearTimeout(advanceTimer)
  advanceTimer = setTimeout(() => {
    if (galleryItems.length > 1) {
      centerIdx = (centerIdx + 1) % galleryItems.length
      scheduleAdvance()
    }
  }, ADVANCE_MS)
}

function handleGallery(items) {
  // find the newest arrival (highest hop among not-yet-shown) to feature next
  let jumpTo = -1
  let jumpHop = -Infinity
  for (let i = 0; i < items.length; i++) {
    ensureImg(items[i].image)
    const k = items[i].waveId + '|' + items[i].peerId
    if (!shownKeys.has(k)) {
      shownKeys.add(k)
      if (items[i].hopCount >= jumpHop) {
        jumpHop = items[i].hopCount
        jumpTo = i
      }
    }
  }
  galleryItems = items
  if (jumpTo >= 0) {
    centerIdx = jumpTo // feature the freshly-arrived selfie
    scheduleAdvance()
  } else if (centerIdx >= galleryItems.length) {
    centerIdx = 0
  }
}

// draw an image cropped to cover a square centred at (x,y)
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
  const item = galleryItems[centerIdx]
  if (!item) return
  const rad = 78

  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, rad, 0, Math.PI * 2)
  ctx.clip()
  const img = ensureImg(item.image)
  if (item.image && img && img.complete && img.naturalWidth) {
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

  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(234,255,240,0.92)'
  ctx.font = '13px -apple-system, sans-serif'
  const cap = item.caption || item.peerId.slice(0, 6)
  ctx.fillText(`hop ${item.hopCount} · ${cap}`, cx, cy + rad + 20)
  ctx.fillStyle = 'rgba(234,255,240,0.5)'
  ctx.font = '11px ui-monospace, Menlo, monospace'
  ctx.fillText(`${centerIdx + 1} / ${galleryItems.length}`, cx, cy + rad + 37)
}

// --- Ring rendering -----------------------------------------------------------
function dot(angleDeg, r, color, radius, label) {
  const cx = canvas.width / 2
  const cy = canvas.height / 2
  const a = ((angleDeg - 90) * Math.PI) / 180 // 0° at top, clockwise
  const x = cx + r * Math.cos(a)
  const y = cy + r * Math.sin(a)
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

function pointOn(angleDeg, r) {
  const a = ((angleDeg - 90) * Math.PI) / 180
  return [canvas.width / 2 + r * Math.cos(a), canvas.height / 2 + r * Math.sin(a)]
}

// --- the football: rolls clockwise from holder to holder on every screen ------
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

function setBall(toAngle) {
  if (toAngle === null) return
  const from = ball ? ballAngle() : toAngle // continue from where it is, or drop in
  ball = { from, to: toAngle, startedAt: performance.now() }
  ballSeenAt = performance.now()
  ballActive = true
}

function drawBall(R) {
  if (!ball) return
  if (performance.now() - ballSeenAt >= BALL_FADE_MS) {
    ball = null
    ballActive = false
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

function render() {
  const cx = canvas.width / 2
  const cy = canvas.height / 2
  const R = 170
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // the ring
  ctx.beginPath()
  ctx.arc(cx, cy, R, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  ctx.lineWidth = 2
  ctx.stroke()

  const succId = state.successor?.id

  // baton direction: line from me to my successor (who I'd pass the wave to)
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
  }
  if (state.me) dot(state.me.angle, R, '#ffd166', 9, 'you')

  // the football: rolls clockwise around the ring, holder to holder, on every screen
  drawBall(R)

  // the wave gallery: one selfie at a time, in the centre of the ring
  drawCenterSelfie(cx, cy)

  if (state.me) {
    meEl.innerText = `you: ${state.me.id.slice(0, 12)}…  @ ${state.me.angle.toFixed(1)}°  ·  ${state.peers.length} peer${state.peers.length === 1 ? '' : 's'}`
  }
}

// continuous loop so ring updates + football animation both render smoothly
function loop() {
  render()
  requestAnimationFrame(loop)
}
loop()

render()
