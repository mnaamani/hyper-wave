// Lobby moment capture (shown in the centre of the ring while the wave is forming).
// Opted-in peers frame their moment during the lobby countdown; the frame is captured
// — automatically when the wave starts, or manually earlier — and STAGED to the worker, which
// posts it to the gallery when this peer's sweep slot fires. This decouples the human
// moment (leisurely, synchronized) from the fast sweep.
import { stageMoment } from './ipc.js';
import { getActiveWave } from './active.js';

const proofEl = document.getElementById('proof');
const preview = document.getElementById('preview');
const countdownEl = document.getElementById('countdown');
const hintEl = document.getElementById('proof-hint');
const captionEl = document.getElementById('caption');
const snap = document.getElementById('snap');
const captureBtn = document.getElementById('capture');
const skipBtn = document.getElementById('skip');

let stream = null;
let deadline = 0;
let timer = null;
let captured = false;
let isOpen = false;
let onCapturedCb = null; // host hook: confirm the capture (status line) as the preview closes

// Register what happens right after a moment is captured (app.js shows a status — the preview closes,
// so this is the user's confirmation the frame was taken).
export function onCaptured(cb) {
  onCapturedCb = cb;
}

// Open the capture modal for the remaining lobby time (ms until the wave starts).
export async function open(lobbyMsLeft) {
  if (isOpen) {
    return;
  }
  isOpen = true;
  captured = false;
  deadline = performance.now() + Math.max(0, lobbyMsLeft || 0);
  captionEl.value = '';
  captionEl.disabled = false;
  captureBtn.style.display = '';
  proofEl.classList.add('show');

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false
    });
    preview.srcObject = stream;
    preview.style.display = '';
  } catch (err) {
    // no camera / denied — still allow staging a placeholder so the flow works
    console.warn('camera unavailable:', err.message);
    preview.style.display = 'none';
  }

  clearTimeout(timer);
  paintLoop();
}

function paint() {
  if (!isOpen || captured) {
    return;
  }
  const secs = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
  countdownEl.innerText = secs > 0 ? `📸 ${secs}` : '📸';
  // keep a clear countdown to auto-capture visible (the big lobby countdown is gone once you're in)
  hintEl.innerText =
    secs > 0
      ? `📸 auto-capturing in ${secs}s — or press Capture now`
      : '📸 capturing…';
}

// Paint now, then re-arm — a self-rescheduling timeout (CLAUDE.md Code Style: no setInterval).
function paintLoop() {
  paint();
  timer = setTimeout(paintLoop, 200);
}

// Grab the current frame + caption and hand it to the worker, then CLOSE the preview — the frame is
// staged (it posts to the gallery at this peer's sweep slot), so there's no reason to keep the camera
// up until the wave starts. The `onCaptured` hook lets the host confirm it on the status line.
function capture() {
  if (captured) {
    return;
  }
  let image = '';
  captured = true;
  clearTimeout(timer);
  if (stream) {
    const snapCtx = snap.getContext('2d');
    // mirror to match the preview
    snapCtx.save();
    snapCtx.scale(-1, 1);
    snapCtx.drawImage(preview, -snap.width, 0, snap.width, snap.height);
    snapCtx.restore();
    // Privacy: the frame is drawn from a live getUserMedia stream (raw pixels, no
    // metadata) and re-encoded here through the canvas. A canvas JPEG carries only pixel
    // data + a minimal JFIF header — no EXIF, GPS, device, OS, or timestamp tags. This
    // re-encode IS the metadata strip; keep capture on this path (never post a camera
    // file/blob directly) so nothing identifying can ride along with the moment.
    image = snap.toDataURL('image/jpeg', 0.5);
  }
  stageMoment({ image, caption: captionEl.value }, getActiveWave());
  if (onCapturedCb) {
    onCapturedCb();
  }
  close(); // frame staged — free the centre now (don't keep the camera on until the wave starts)
}

// Wave start: ensure we've captured (auto if the person didn't press the button), then
// close so the ring centre is free for the gallery during the race.
export function captureAndStage() {
  if (!isOpen) {
    return;
  }
  if (!captured) {
    capture();
  }
  close();
}

export function close() {
  clearTimeout(timer);
  timer = null;
  if (stream) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    stream = null;
  }
  preview.style.display = '';
  countdownEl.innerText = '';
  hintEl.innerText = '';
  captionEl.disabled = false;
  proofEl.classList.remove('show');
  isOpen = false;
  captured = false;
}

captureBtn.onclick = capture;
skipBtn.onclick = close; // opt out of the photo (the spark still passes through you)
