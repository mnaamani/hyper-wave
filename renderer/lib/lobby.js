// Lobby panel (opt in before the wave starts) — the countdown + join button shown
// in the centre of the ring while a wave is forming.
import { joinWave } from './ipc.js';
import { unitLabel } from './wallet-meta.js';

const lobbyEl = document.getElementById('lobby');
const msgEl = document.getElementById('lobby-msg');
const countEl = document.getElementById('lobby-count');
const joinBtn = document.getElementById('join');
const cancelBtn = document.getElementById('cancel');

let count = 0;
let joined = false;
let deadline = 0;
let timer = null;
let onCancelCb = null;
let fee = null; // the initiator-set participation fee (TRX), null on an unpaid/wallet-less wave

// Register what happens when a non-joiner dismisses the lobby (app.js un-dims + resumes browsing).
export function onCancel(cb) {
  onCancelCb = cb;
}

export function open(evt) {
  count = evt.count || 1;
  joined = !!evt.mine || !!evt.joined;
  fee = typeof evt.fee === 'number' ? evt.fee : null;
  deadline = performance.now() + (evt.lobbyMs || 15000);
  // a non-joiner gets Join + "Not now" (dismiss to keep browsing the previous gallery)
  joinBtn.style.display = joined ? 'none' : 'inline-block';
  cancelBtn.style.display = joined ? 'none' : 'inline-block';
  lobbyEl.classList.add('show');
  clearTimeout(timer);
  paintLoop();
}

export function update(newCount) {
  if (typeof newCount === 'number') {
    count = newCount;
  }
  paint();
}

// Gate the join button on the the wave start payment being verified (anti-spam): show a
// "verifying…" state until the initiator's burn is confirmed, then enable joining.
export function setJoinable(ok) {
  if (joined) {
    return;
  }
  joinBtn.disabled = !ok;
  // Show the fee on the button so a joiner sees the cost before opting in (the initiator sets it).
  const feeSuffix = fee !== null ? ` (${fee} ${unitLabel()})` : '';
  joinBtn.innerText = ok
    ? `✋ Count me in${feeSuffix}`
    : '⏳ verifying payment…';
}

export function close() {
  clearTimeout(timer);
  lobbyEl.classList.remove('show');
}

function paint() {
  if (!lobbyEl.classList.contains('show')) {
    return;
  }
  const secs = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
  countEl.innerText = secs;
  const feeNote = fee !== null ? ` · fee ${fee} ${unitLabel()}` : '';
  msgEl.innerText = `wave forming · ${joined ? 'you are in' : 'join in?'} · ${count} in${feeNote}`;
}

// Paint now, then re-arm — a self-rescheduling timeout (CLAUDE.md Code Style: no setInterval).
function paintLoop() {
  paint();
  timer = setTimeout(paintLoop, 200);
}

joinBtn.onclick = () => {
  joined = true;
  joinBtn.style.display = 'none';
  cancelBtn.style.display = 'none';
  joinWave();
};

// "Not now": dismiss the lobby without joining. The wave still forms/runs (this peer just
// spectates); closing lets them keep browsing the gallery of the wave they just took part in.
cancelBtn.onclick = () => {
  close();
  if (onCancelCb) {
    onCancelCb();
  }
};
