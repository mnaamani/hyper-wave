// The wave gallery: which moment to feature in the ring centre (one at a time). While the wave
// races, the spark sweeps the ring (started at wave-active) and we feature the moment it's passing
// (featureByFrac); when there's no moment to show yet (post-capture wait, or before the first
// arrival) a centred spinner + "collecting moments" status fills the centre instead of leaving it
// blank (refreshStage). When the sweep freezes, the user drags the spark (scrubber.js → ring.scrubTo
// → featureByFrac) to browse — no auto-cycle. Moments are always hopCount-ordered (buildGallery),
// so the sweep reproduces ring order regardless of arrival timing.
import * as ring from './ring.js';
import { tip, note, dm } from './ipc.js';
import { unitLabel, isCashu } from './wallet-meta.js';
import { classify as classifyNsfw } from './nsfw.js';
import { txLink } from './explorer.js';

const stageEl = document.getElementById('stage-status');
const stageTextEl = document.getElementById('stage-status-text');
const tipBtn = document.getElementById('tip');
const toastEl = document.getElementById('tip-toast');
const nsfwCover = document.getElementById('nsfw-cover');
const nsfwRevealBtn = document.getElementById('nsfw-reveal');
// The tip amount, in the active wallet's unit. Cashu is in sats — a few sats so the tip
// survives the mint's ~1-sat swap fee; a chain wallet tips 1 whole unit (TRX).
const tipAmount = () => (isCashu() ? 5 : 1);

let items = [];
let centerIdx = 0;
let expected = 0;
let active = false;
let closed = false; // gallery view closed (a new wave's lobby/capture owns the ring centre)
let myAddress = null; // my own wallet — never tip myself
let lastTip = null; // the entry we just tipped (captured at click; announced on success)
let pendingReplay = false; // replay requested but waiting for the first moment (see startReplay)
let waitingText = ''; // app-set centre message before racing (e.g. post-capture wait)
const shownKeys = new Set(); // waveId|peerId already featured
// Local NSFW safety filter (nsfw.js): waveId|peerId -> 'pending' | true (unsafe) | false (safe).
// `revealed` holds keys the user chose to un-hide. A flagged, un-revealed featured moment is
// covered by an opaque overlay (#nsfw-cover) instead of shown.
const nsfwVerdicts = new Map();
const nsfwRevealed = new Set();

// Stable per-moment key (a peer posts one entry per wave).
function keyOf(item) {
  return item.waveId + '|' + item.peerId;
}

// Tell the gallery our own wallet address so it hides the tip button on our own moments.
export function setMyAddress(addr) {
  myAddress = addr;
  refreshTip();
}

// Show the tip button when the featured moment has a payable address that isn't mine.
function refreshTip() {
  const featured = items[centerIdx];
  const payable =
    featured && featured.address && featured.address !== myAddress;
  tipBtn.classList.toggle('show', !!payable);
  tipBtn.disabled = false;
  tipBtn.innerText = `⚡ Tip ${tipAmount()} ${unitLabel(tipAmount())}`;
}

tipBtn.onclick = () => {
  const featured = items[centerIdx];
  if (!featured || !featured.address || featured.address === myAddress) {
    return;
  }
  tipBtn.disabled = true;
  tipBtn.innerText = '💸 sending…';
  // Remember the target now — by the time the result comes back the user may have scrubbed to
  // another moment. Used to announce the tip on the wave once it confirms (tipResult).
  const amount = tipAmount();
  lastTip = {
    waveId: featured.waveId,
    peerId: featured.peerId,
    address: featured.address,
    amount
  };
  tip(featured.address, amount, featured.peerId);
};

export function count() {
  return items.length;
}

export function setActive(on) {
  active = on;
  // Any wave-lifecycle transition (racing → true, idle → false) means the forming/capture stage is
  // over and the ring centre is the gallery's again — reopen it (close() sets this while capturing).
  closed = false;
  refreshStage();
}

export function setExpected(count) {
  expected = count;
  refreshStage();
}

// App-set centre message shown before racing (e.g. "captured — waiting for the wave…"), while
// there's no moment to feature yet. Cleared when a moment appears or a new wave forms.
export function setWaiting(text) {
  waitingText = text || '';
  refreshStage();
}

// Keep the ring centre useful when there's no moment to show: a spinner + message during the
// post-capture wait and while moments are still syncing in — instead of a blank centre.
function refreshStage() {
  const hasFeatured = !!items[centerIdx];
  let text = '';
  if (!hasFeatured) {
    if (active) {
      const total = Math.max(expected, items.length, 1);
      text = items.length
        ? `collecting moments… ${items.length} / ${total}`
        : 'the wave is rolling — moments incoming…';
    } else if (waitingText) {
      text = waitingText;
    }
  }
  stageEl.classList.toggle('show', !!text);
  stageTextEl.textContent = text;
}

function feature(index) {
  centerIdx = index;
  const item = items[centerIdx] || null;
  ring.setCenter(item);
  refreshTip();
  refreshStage(); // a moment is featured now → hide the "collecting" placeholder
  classifyItem(item); // kick off (or reuse a cached) local NSFW check
  updateCover(item); // show/hide the "possibly unsafe" cover for this moment
}

// Classify a moment locally the first time it's featured (cached by key). Fail-open: the moment is
// shown while the (fast, ~ms) check runs, then covered if the verdict comes back unsafe — so a safe
// moment never flickers, and the classifier can't blank the gallery if it's unavailable.
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
    // if this moment is still the featured one, reflect the verdict now
    const featured = items[centerIdx];
    if (featured && keyOf(featured) === key) {
      updateCover(featured);
    }
  });
}

// Show the opaque cover iff the featured moment is flagged unsafe and the user hasn't revealed it.
function updateCover(item) {
  const key = item ? keyOf(item) : null;
  const flagged =
    !!key && nsfwVerdicts.get(key) === true && !nsfwRevealed.has(key);
  nsfwCover.classList.toggle('show', flagged);
}

// "Show anyway": reveal the featured moment for the rest of the session.
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
    // Chain tip → a clickable explorer tx; Cashu tip → `hash` is a bearer token (no explorer).
    if (isCashu()) {
      toastEl.textContent = '✅ tipped';
    } else {
      toastEl.replaceChildren('✅ tipped — ', txLink(hash));
    }
    if (lastTip) {
      if (isCashu()) {
        // Cashu: deliver the bearer token PRIVATELY (unicast to the recipient) so the token + the
        // who-tipped-whom don't hit the flood — Chaumian privacy at the network layer too. Then a
        // STRIPPED social-proof note (no token, no recipient) for the gallery celebration.
        dm(lastTip.waveId, lastTip.peerId, {
          kind: 'tip',
          token: hash,
          amount: lastTip.amount
        });
        note(lastTip.waveId, { kind: 'tip', amount: lastTip.amount });
      } else {
        // Chain (Tron): the tip is public on-chain anyway — flood the full note (to + tx hash) so
        // the recipient celebrates and everyone sees the social proof. (Roster-gated in the engine.)
        note(lastTip.waveId, {
          kind: 'tip',
          to: lastTip.address,
          peerId: lastTip.peerId,
          amount: lastTip.amount,
          hash
        });
      }
    }
  } else {
    toastEl.textContent = `⚠️ tip failed: ${error || 'unknown'}`;
  }
  lastTip = null;
  setTimeout(() => toastEl.replaceChildren(), 6000);
  refreshTip();
}

// Start the completion replay: roll the spark once around the ring from hop 0's seat, featuring
// each moment as it passes. Origin = the first (hop 0 / originator) entry's seat angle, so the
// sweep's angular progress lines up with the hopCount-ordered gallery. At network speed the
// `completed` event can beat the local moment's async append, so `items` may still be empty here
// — mark the replay PENDING (`pendingReplay`, top of module) and start it the moment the first
// moment lands (see handle()).
export function startReplay() {
  pendingReplay = true;
  tryStartReplay();
}

// Restore the spark for a wave whose replay ALREADY ran — switching back to an ended wave from
// the directory. Re-playing the 8s lap on every switch would fight the user, so park the spark at
// the lap's end instead: the same state the wave was left in, and immediately scrubbable. Deferred
// like startReplay, since the cached feed may not have landed yet.
export function restoreReplay() {
  pendingReplay = 'frozen';
  tryStartReplay();
}

function tryStartReplay() {
  if (!pendingReplay || !items.length) {
    return; // waiting for the first moment to arrive
  }
  if (ring.sweepOrigin() !== null) {
    return; // already replaying
  }
  const frozen = pendingReplay === 'frozen';
  pendingReplay = false;
  ring.startSweep(ring.angleOfId(items[0].peerId));
  if (frozen) {
    ring.scrubTo(1); // skip the auto-play; hand the ring straight to the scrubber
  }
}

// Cancel a not-yet-started replay (a new wave formed before moments for the old one arrived).
export function cancelReplay() {
  pendingReplay = false;
}

// Drop the previous wave's moments + centre image. Used when this peer leaves the old gallery to
// take part in a new wave (initiator start, or on join).
export function clearView() {
  items = [];
  centerIdx = 0;
  shownKeys.clear();
  pendingReplay = false;
  waitingText = '';
  ring.setCenter(null);
  refreshStage();
  refreshTip(); // no featured moment now → hide the tip button (don't leave it over the capture)
  nsfwCover.classList.remove('show'); // no featured moment → no safety cover
}

// Close the gallery view: clear it AND stop rendering feed updates until the wave next races/idles
// (setActive reopens it). The lobby/capture now owns the ring centre, and a lingering wave's feed
// keeps ticking (the engine re-emits every held wave's feed periodically), so without this a stale
// moment would repaint onto the canvas BEHIND the capture modal. Called when we open the capture.
export function close() {
  active = false; // capture/lobby owns the centre now — stop any "collecting" placeholder
  clearView();
  closed = true;
}

// Per-frame callback from the sweep: feature the last moment whose seat the spark has passed.
// `items` is hopCount-ordered = clockwise-from-origin, so its angular distances from `origin`
// increase monotonically; the furthest one within the spark's travelled arc is the current one.
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
  // periodic re-emit can't paint a moment behind the capture modal. setActive() reopens.
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
  tryStartReplay(); // a deferred post-completion replay starts as soon as the first moment lands
  // don't fight an active replay/scrub: the sweep owns featuring once it's running
  if (ring.sweepOrigin() !== null) {
    refreshStage();
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
  refreshStage();
  refreshTip();
}

// Clear the centre placeholder (app.js calls this when a new wave forms).
export function hideProgress() {
  waitingText = '';
  refreshStage();
}
