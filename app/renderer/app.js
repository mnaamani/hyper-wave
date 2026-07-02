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

let pulse = null // { at } — recent token activity at my position

bridge.onWorkerIPC(HYPERWAVE, (data) => {
  let msg
  try {
    msg = JSON.parse(decoder.decode(data))
  } catch {
    return
  }
  if (msg.type === 'state') {
    state = msg
    // idle status = ring readiness, unless a wave is currently animating
    if (!pulse) {
      const n = state.peers.length
      statusEl.innerText =
        n === 0 ? 'in the ring — waiting for peers…' : `${n} peer${n === 1 ? '' : 's'} in the ring — press Start`
    }
  } else if (msg.type === 'token') {
    onTokenEvent(msg)
  } else if (msg.type === 'gallery') {
    renderGallery(msg.items)
  }
})

function onTokenEvent (e) {
  switch (e.event) {
    case 'started':
      statusEl.innerText = '🌊 you launched the wave!'
      pulse = { at: performance.now() }
      break
    case 'holding':
      statusEl.innerText = `wave passing you — hop ${e.hopCount ?? ''}`
      pulse = { at: performance.now() }
      openProofWindow(e) // capture a selfie for the gallery
      break
    case 'forwarded':
      statusEl.innerText = `wave passing you — hop ${e.hopCount ?? ''}`
      pulse = { at: performance.now() }
      break
    case 'completed':
      statusEl.innerText = `✅ wave completed — ${e.hops} hops, chain ${e.chainHash.slice(0, 8)}…`
      pulse = { at: performance.now() }
      break
    case 'stalled':
      statusEl.innerText = `⚠️ wave stalled (${e.reason})`
      break
  }
}

document.getElementById('start').onclick = () => {
  bridge.writeWorkerIPC(HYPERWAVE, JSON.stringify({ type: 'start-wave' }))
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

async function openProofWindow (e) {
  if (proofCtx) return // already capturing for a hop; ignore re-entry
  proofCtx = { waveId: e.waveId, hopCount: e.hopCount, receiptSig: e.receiptSig, chainHash: e.chainHash }
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

function capture () {
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

function closeProofWindow () {
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

// --- Gallery rendering --------------------------------------------------------
const galleryEl = document.getElementById('gallery')

function renderGallery (items) {
  galleryEl.innerHTML = ''
  for (const it of items) {
    const card = document.createElement('div')
    card.className = 'card'
    const media = it.image
      ? `<img src="${it.image}" alt="hop ${it.hopCount}" />`
      : `<div class="noimg">🌊</div>`
    card.innerHTML =
      media +
      `<div class="meta"><div class="hop">hop ${it.hopCount}</div>` +
      `<div class="cap">${escapeHtml(it.caption) || it.peerId.slice(0, 8)}</div></div>`
    galleryEl.appendChild(card)
  }
}

function escapeHtml (s) {
  return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

// --- Ring rendering -----------------------------------------------------------
function dot (angleDeg, r, color, radius, label) {
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

function pointOn (angleDeg, r) {
  const a = ((angleDeg - 90) * Math.PI) / 180
  return [canvas.width / 2 + r * Math.cos(a), canvas.height / 2 + r * Math.sin(a)]
}

function render () {
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
    dot(p.angle, R, isSucc ? '#ff8c42' : '#39d98a', isSucc ? 8 : 6, isSucc ? 'next ▸ ' + p.id.slice(0, 6) : p.id.slice(0, 6))
  }
  if (state.me) dot(state.me.angle, R, '#ffd166', 9, 'you')

  // token pulse: an expanding ring at my position when the wave passes through me
  if (pulse && state.me) {
    const age = performance.now() - pulse.at
    if (age < 700) {
      const [px, py] = pointOn(state.me.angle, R)
      ctx.beginPath()
      ctx.arc(px, py, 9 + age * 0.05, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255,209,102,${1 - age / 700})`
      ctx.lineWidth = 3
      ctx.stroke()
    } else {
      pulse = null
    }
  }

  if (state.me) {
    meEl.innerText = `you: ${state.me.id.slice(0, 12)}…  @ ${state.me.angle.toFixed(1)}°  ·  ${state.peers.length} peer${state.peers.length === 1 ? '' : 's'}`
  }
}

// continuous loop so ring updates + pulse animation both render smoothly
function loop () {
  render()
  requestAnimationFrame(loop)
}
loop()

render()
