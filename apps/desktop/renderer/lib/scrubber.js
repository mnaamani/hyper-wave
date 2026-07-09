// The circular scrubber: once the completion replay is running (or has frozen), the ring
// canvas itself is a circular slider and the ⚽ is its handle. Dragging around the ring maps
// the pointer angle to a progress fraction and parks the ball there (ring.scrubTo), so the
// gallery features the selfie at that point in the ring order. Only active while a replay
// exists (ring.sweepOrigin() !== null); otherwise the ring is just a display.
import * as ring from './ring.js';

const canvas = document.getElementById('ring');
let dragging = false;

// Pointer position → progress fraction [0,1], measured CLOCKWISE from the sweep origin (hop 0).
// Inverse of ring.js `pointOn` (0° at top, clockwise): angle = atan2(dy, dx) + 90°.
function fracFromEvent(ev) {
  const origin = ring.sweepOrigin();
  if (origin === null) {
    return null;
  }
  const rect = canvas.getBoundingClientRect();
  const dx = ev.clientX - (rect.left + rect.width / 2);
  const dy = ev.clientY - (rect.top + rect.height / 2);
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  deg = ((deg % 360) + 360) % 360;
  return ((deg - origin + 360) % 360) / 360;
}

function onDown(ev) {
  const frac = fracFromEvent(ev);
  if (frac === null) {
    return; // no replay active — leave the ring as a plain display
  }
  dragging = true;
  canvas.style.cursor = 'grabbing';
  ring.scrubTo(frac);
  canvas.setPointerCapture?.(ev.pointerId);
}

function onMove(ev) {
  if (!dragging) {
    return;
  }
  const frac = fracFromEvent(ev);
  if (frac !== null) {
    ring.scrubTo(frac);
  }
}

function onUp() {
  dragging = false;
  canvas.style.cursor = ring.sweepOrigin() !== null ? 'grab' : 'default';
}

export function init() {
  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// Reflect grab-ability in the cursor as replays start/stop (called from the frame listener).
ring.onSweepFrame(() => {
  if (!dragging) {
    canvas.style.cursor = 'grab';
  }
});
