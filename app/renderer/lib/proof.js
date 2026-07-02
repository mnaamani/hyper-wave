// Proof window: the circular webcam selfie capture shown in the centre of the ring
// when the ball reaches an opted-in peer. Captures a frame and posts it to the gallery.
import { postSelfie } from './ipc.js'

const proofEl = document.getElementById('proof')
const preview = document.getElementById('preview')
const countdownEl = document.getElementById('countdown')
const captionEl = document.getElementById('caption')
const snap = document.getElementById('snap')

let stream = null
let ctx = null // { waveId, hopCount, receiptSig, chainHash, receiptTs }
let countdownTimer = null

export async function open(e) {
  if (ctx) return // already capturing for a hop; ignore re-entry
  ctx = {
    waveId: e.waveId,
    hopCount: e.hopCount,
    receiptSig: e.receiptSig,
    chainHash: e.chainHash,
    receiptTs: e.receiptTs
  }
  captionEl.value = ''
  proofEl.classList.add('show')

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
  if (!ctx) return
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
  postSelfie({ ...ctx, caption: captionEl.value, image })
  close()
}

export function close() {
  if (countdownTimer) clearInterval(countdownTimer)
  if (stream) {
    for (const t of stream.getTracks()) t.stop()
    stream = null
  }
  preview.style.display = ''
  countdownEl.innerText = ''
  proofEl.classList.remove('show')
  ctx = null
}

document.getElementById('capture').onclick = capture
document.getElementById('skip').onclick = close
