// The wave gallery: which selfie to feature in the ring centre (one at a time), and
// the collection-progress bar. During collection we feature each new arrival; once the wave
// completes the host runs a fixed-duration REPLAY sweep (ring.js) and we feature the selfie the
// ball is passing (featureByFrac). When the sweep freezes, the user drags the ball (scrubber.js
// → ring.scrubTo → featureByFrac) to browse — no auto-cycle. Selfies are always hopCount-ordered
// (buildGallery), so the sweep reproduces ring order regardless of arrival timing.
import * as ring from './ring.js';
import { tip } from './ipc.js';
import { txLink } from './explorer.js';

const progressEl = document.getElementById('progress');
const progressFill = document.getElementById('progress-fill');
const progressLabel = document.getElementById('progress-label');
const tipBtn = document.getElementById('tip');
const toastEl = document.getElementById('tip-toast');
const TIP_TRX = 1;

let items = [];
let centerIdx = 0;
let expected = 0;
let active = false;
let myAddress = null; // my own wallet — never tip myself
let pendingReplay = false; // replay requested but waiting for the first selfie (see startReplay)
const shownKeys = new Set(); // waveId|peerId already featured

// Tell the gallery our own wallet address so it hides the tip button on our own selfies.
export function setMyAddress(addr) {
  myAddress = addr;
  refreshTip();
}

// Show the tip button when the featured selfie has a payable address that isn't mine.
function refreshTip() {
  const featured = items[centerIdx];
  const payable = featured && featured.address && featured.address !== myAddress;
  tipBtn.classList.toggle('show', !!payable);
  tipBtn.disabled = false;
  tipBtn.innerText = `💵 Tip ${TIP_TRX} TRX`;
}

tipBtn.onclick = () => {
  const featured = items[centerIdx];
  if (!featured || !featured.address || featured.address === myAddress) {
    return;
  }
  tipBtn.disabled = true;
  tipBtn.innerText = '💸 sending…';
  tip(featured.address, TIP_TRX, featured.peerId);
};

export function count() {
  return items.length;
}

export function setActive(on) {
  active = on;
  updateProgress();
}

export function setExpected(count) {
  expected = count;
  updateProgress();
}

function feature(index) {
  centerIdx = index;
  ring.setCenter(items[centerIdx] || null);
  refreshTip();
}

// Worker reply to a tip: show the clickable tx (success) or the error, then re-enable.
export function tipResult({ hash, error }) {
  if (hash) {
    toastEl.replaceChildren('✅ tipped — ', txLink(hash));
  } else {
    toastEl.textContent = `⚠️ tip failed: ${error || 'unknown'}`;
  }
  setTimeout(() => toastEl.replaceChildren(), 6000);
  refreshTip();
}

// Start the completion replay: roll the ball once around the ring from hop 0's seat, featuring
// each selfie as it passes. Origin = the first (hop 0 / originator) entry's seat angle, so the
// sweep's angular progress lines up with the hopCount-ordered gallery. At network speed the
// `completed` event can beat the local selfie's async append, so `items` may still be empty here
// — mark the replay PENDING (`pendingReplay`, top of module) and start it the moment the first
// selfie lands (see handle()).
export function startReplay() {
  pendingReplay = true;
  tryStartReplay();
}

function tryStartReplay() {
  if (!pendingReplay || !items.length) {
    return; // waiting for the first selfie to arrive
  }
  if (ring.sweepOrigin() !== null) {
    return; // already replaying
  }
  pendingReplay = false;
  ring.startSweep(ring.angleOfId(items[0].peerId));
}

// Cancel a not-yet-started replay (a new wave formed before selfies for the old one arrived).
export function cancelReplay() {
  pendingReplay = false;
}

// Close the gallery view entirely: drop the previous wave's selfies + centre image. Used when
// this peer leaves the old gallery to take part in a new wave (initiator kick-off, or on join).
export function clearView() {
  items = [];
  centerIdx = 0;
  shownKeys.clear();
  pendingReplay = false;
  ring.setCenter(null);
  hideProgress();
}

// Per-frame callback from the sweep: feature the last selfie whose seat the ball has passed.
// `items` is hopCount-ordered = clockwise-from-origin, so its angular distances from `origin`
// increase monotonically; the furthest one within the ball's travelled arc is the current one.
function featureByFrac(frac, origin) {
  const travelled = frac * 360;
  let pick = -1;
  for (let i = 0; i < items.length; i++) {
    const arcFromOrigin = (ring.angleOfId(items[i].peerId) - origin + 360) % 360;
    if (arcFromOrigin <= travelled) {
      pick = i;
    } else {
      break; // monotonic — no later entry can be within the arc
    }
  }
  if (pick >= 0 && pick !== centerIdx) {
    feature(pick);
  }
}
ring.onSweepFrame(featureByFrac);

export function handle(newItems) {
  // during collection (before the replay), feature the newest arrival (highest unseen hop)
  let jumpTo = -1;
  let jumpHop = -Infinity;
  for (let i = 0; i < newItems.length; i++) {
    const item = newItems[i];
    const key = item.waveId + '|' + item.peerId;
    if (!shownKeys.has(key)) {
      shownKeys.add(key);
      if (item.hopCount >= jumpHop) {
        jumpHop = item.hopCount;
        jumpTo = i;
      }
    }
  }
  items = newItems;
  tryStartReplay(); // a deferred post-completion replay starts as soon as the first selfie lands
  // don't fight an active replay/scrub: the sweep owns featuring once it's running
  if (ring.sweepOrigin() !== null) {
    updateProgress();
    refreshTip();
    return;
  }
  if (jumpTo >= 0) {
    feature(jumpTo);
  } else if (centerIdx >= items.length) {
    feature(0);
  } else {
    ring.setCenter(items[centerIdx] || null);
  }
  updateProgress();
  refreshTip();
}

export function hideProgress() {
  progressEl.classList.remove('show');
}

function updateProgress() {
  const got = items.length;
  if (!active && got === 0) {
    hideProgress();
    return;
  }
  const total = Math.max(expected, got, 1);
  progressEl.classList.add('show');
  progressFill.style.width = Math.round((got / total) * 100) + '%';
  progressLabel.innerText =
    got >= total
      ? `📸 all ${got} selfie${got === 1 ? '' : 's'} in!`
      : `📸 collecting selfies… ${got} / ${total}`;
}
