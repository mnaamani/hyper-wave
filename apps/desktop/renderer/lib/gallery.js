// The wave gallery: which selfie to feature in the ring centre (one at a time), and
// the collection-progress bar. During collection we feature each new arrival; once the wave
// completes the host runs a fixed-duration REPLAY sweep (ring.js) and we feature the selfie the
// ball is passing (featureByFrac). When the sweep freezes, the user drags the ball (scrubber.js
// → ring.scrubTo → featureByFrac) to browse — no auto-cycle. Selfies are always hopCount-ordered
// (buildGallery), so the sweep reproduces ring order regardless of arrival timing.
import * as ring from './ring.js';
import { tip, note } from './ipc.js';
import { classify as classifyNsfw } from './nsfw.js';
import { txLink } from './explorer.js';

const progressEl = document.getElementById('progress');
const progressFill = document.getElementById('progress-fill');
const progressLabel = document.getElementById('progress-label');
const tipBtn = document.getElementById('tip');
const toastEl = document.getElementById('tip-toast');
const nsfwCover = document.getElementById('nsfw-cover');
const nsfwRevealBtn = document.getElementById('nsfw-reveal');
const TIP_TRX = 1;

let items = [];
let centerIdx = 0;
let expected = 0;
let active = false;
let closed = false; // gallery view closed (a new wave's lobby/capture owns the ring centre)
let myAddress = null; // my own wallet — never tip myself
let lastTip = null; // the entry we just tipped (captured at click; announced on success)
let pendingReplay = false; // replay requested but waiting for the first selfie (see startReplay)
const shownKeys = new Set(); // waveId|peerId already featured
// Local NSFW safety filter (nsfw.js): waveId|peerId -> 'pending' | true (unsafe) | false (safe).
// `revealed` holds keys the user chose to un-hide. A flagged, un-revealed featured selfie is
// covered by an opaque overlay (#nsfw-cover) instead of shown.
const nsfwVerdicts = new Map();
const nsfwRevealed = new Set();

// Stable per-selfie key (a peer posts one entry per wave).
function keyOf(item) {
  return item.waveId + '|' + item.peerId;
}

// Tell the gallery our own wallet address so it hides the tip button on our own selfies.
export function setMyAddress(addr) {
  myAddress = addr;
  refreshTip();
}

// Show the tip button when the featured selfie has a payable address that isn't mine.
function refreshTip() {
  const featured = items[centerIdx];
  const payable =
    featured && featured.address && featured.address !== myAddress;
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
  // Remember the target now — by the time the result comes back the user may have scrubbed to
  // another selfie. Used to announce the tip on the wave once it confirms (tipResult).
  lastTip = {
    waveId: featured.waveId,
    peerId: featured.peerId,
    address: featured.address,
    amount: TIP_TRX
  };
  tip(featured.address, TIP_TRX, featured.peerId);
};

export function count() {
  return items.length;
}

export function setActive(on) {
  active = on;
  // Any wave-lifecycle transition (racing → true, idle → false) means the forming/capture stage is
  // over and the ring centre is the gallery's again — reopen it (close() sets this while capturing).
  closed = false;
  updateProgress();
}

export function setExpected(count) {
  expected = count;
  updateProgress();
}

function feature(index) {
  centerIdx = index;
  const item = items[centerIdx] || null;
  ring.setCenter(item);
  refreshTip();
  classifyItem(item); // kick off (or reuse a cached) local NSFW check
  updateCover(item); // show/hide the "possibly unsafe" cover for this selfie
}

// Classify a selfie locally the first time it's featured (cached by key). Fail-open: the selfie is
// shown while the (fast, ~ms) check runs, then covered if the verdict comes back unsafe — so a safe
// selfie never flickers, and the classifier can't blank the gallery if it's unavailable.
function classifyItem(item) {
  if (!item || !item.image) {
    return;
  }
  const key = keyOf(item);
  if (nsfwVerdicts.has(key)) {
    return;
  }
  nsfwVerdicts.set(key, 'pending');
  classifyNsfw(item.image).then(({ unsafe }) => {
    nsfwVerdicts.set(key, unsafe);
    // if this selfie is still the featured one, reflect the verdict now
    const featured = items[centerIdx];
    if (featured && keyOf(featured) === key) {
      updateCover(featured);
    }
  });
}

// Show the opaque cover iff the featured selfie is flagged unsafe and the user hasn't revealed it.
function updateCover(item) {
  const key = item ? keyOf(item) : null;
  const flagged =
    !!key && nsfwVerdicts.get(key) === true && !nsfwRevealed.has(key);
  nsfwCover.classList.toggle('show', flagged);
}

// "Show anyway": reveal the featured selfie for the rest of the session.
nsfwRevealBtn.onclick = () => {
  const item = items[centerIdx];
  if (item) {
    nsfwRevealed.add(keyOf(item));
    updateCover(item);
  }
};

// Worker reply to a tip: show the clickable tx (success) or the error, then re-enable.
export function tipResult({ hash, error }) {
  if (hash) {
    toastEl.replaceChildren('✅ tipped — ', txLink(hash));
    // Announce the tip on the wave so the recipient (and everyone) sees it. Roster-gated in the
    // engine — a no-op if we only spectated this wave (the on-chain tip still went through).
    if (lastTip) {
      note(lastTip.waveId, {
        kind: 'tip',
        to: lastTip.address,
        peerId: lastTip.peerId,
        amount: lastTip.amount,
        hash
      });
    }
  } else {
    toastEl.textContent = `⚠️ tip failed: ${error || 'unknown'}`;
  }
  lastTip = null;
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

// Drop the previous wave's selfies + centre image. Used when this peer leaves the old gallery to
// take part in a new wave (initiator kick-off, or on join).
export function clearView() {
  items = [];
  centerIdx = 0;
  shownKeys.clear();
  pendingReplay = false;
  ring.setCenter(null);
  hideProgress();
  refreshTip(); // no featured selfie now → hide the tip button (don't leave it over the capture)
  nsfwCover.classList.remove('show'); // no featured selfie → no safety cover
}

// Close the gallery view: clear it AND stop rendering feed updates until the wave next races/idles
// (setActive reopens it). The lobby/capture now owns the ring centre, and a lingering wave's feed
// keeps ticking (the engine re-emits every held wave's feed periodically), so without this a stale
// selfie would repaint onto the canvas BEHIND the capture modal. Called when we open the capture.
export function close() {
  clearView();
  closed = true;
}

// Per-frame callback from the sweep: feature the last selfie whose seat the ball has passed.
// `items` is hopCount-ordered = clockwise-from-origin, so its angular distances from `origin`
// increase monotonically; the furthest one within the ball's travelled arc is the current one.
function featureByFrac(frac, origin) {
  const travelled = frac * 360;
  let pick = -1;
  for (let i = 0; i < items.length; i++) {
    const arcFromOrigin =
      (ring.angleOfId(items[i].peerId) - origin + 360) % 360;
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
  // Closed (a new wave's lobby/capture owns the centre): ignore feed repaints so a lingering wave's
  // periodic re-emit can't paint a selfie behind the capture modal. setActive() reopens.
  if (closed) {
    return;
  }
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
