// Lobby selfie capture (shown in the centre of the ring while the wave is forming).
// Opted-in peers frame their selfie during the lobby countdown; the frame is captured
// — automatically at kickoff, or manually earlier — and STAGED to the worker, which
// posts it to the gallery when the token reaches this peer. This decouples the human
// moment (leisurely, synchronized) from the fast token race.
import { stageSelfie } from './ipc.js'

const proofEl = document.getElementById('proof')
const preview = document.getElementById('preview')
const countdownEl = document.getElementById('countdown')
const hintEl = document.getElementById('proof-hint')
const captionEl = document.getElementById('caption')
const snap = document.getElementById('snap')
const captureBtn = document.getElementById('capture')
const skipBtn = document.getElementById('skip')

let stream = null
let deadline = 0
let timer = null
let captured = false
let isOpen = false

// Open the capture modal for the remaining lobby time (ms until kickoff).
export async function open(lobbyMsLeft) {
  if (isOpen) return
  isOpen = true
  captured = false
  deadline = performance.now() + Math.max(0, lobbyMsLeft || 0)
  captionEl.value = ''
  captionEl.disabled = false
  captureBtn.style.display = ''
  proofEl.classList.add('show')

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    preview.srcObject = stream
    preview.style.display = ''
  } catch (err) {
    // no camera / denied — still allow staging a placeholder so the flow works
    console.warn('camera unavailable:', err.message)
    preview.style.display = 'none'
  }

  clearInterval(timer)
  timer = setInterval(paint, 200)
  paint()
}

function paint() {
  if (!isOpen || captured) return
  const secs = Math.max(0, Math.ceil((deadline - performance.now()) / 1000))
  countdownEl.innerText = secs > 0 ? `📸 ${secs}` : '📸'
  // keep a clear countdown to auto-capture visible (the big lobby countdown is gone once you're in)
  hintEl.innerText =
    secs > 0 ? `📸 auto-capturing in ${secs}s — or press Capture now` : '📸 capturing…'
}

// Grab the current frame + caption and hand it to the worker. Stays open (showing a
// "ready" state) until kickoff frees the centre for the gallery.
function capture() {
  if (captured) return
  captured = true
  clearInterval(timer)
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
  stageSelfie({ image, caption: captionEl.value })
  countdownEl.innerText = '✅'
  hintEl.innerText = '✅ captured — you’re in the wave!'
  captureBtn.style.display = 'none'
  captionEl.disabled = true
}

// Kickoff: ensure we've captured (auto if the person didn't press the button), then
// close so the ring centre is free for the gallery during the race.
export function captureAndStage() {
  if (!isOpen) return
  if (!captured) capture()
  close()
}

export function close() {
  clearInterval(timer)
  timer = null
  if (stream) {
    for (const t of stream.getTracks()) t.stop()
    stream = null
  }
  preview.style.display = ''
  countdownEl.innerText = ''
  hintEl.innerText = ''
  captionEl.disabled = false
  proofEl.classList.remove('show')
  isOpen = false
  captured = false
}

captureBtn.onclick = capture
skipBtn.onclick = close // opt out of the photo (the ball still passes through you)
