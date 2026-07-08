// Lobby panel (opt in before the wave starts) — the countdown + join button shown
// in the centre of the ring while a wave is forming.
import { joinWave } from './ipc.js'

const lobbyEl = document.getElementById('lobby')
const msgEl = document.getElementById('lobby-msg')
const countEl = document.getElementById('lobby-count')
const joinBtn = document.getElementById('join')
const cancelBtn = document.getElementById('cancel')

let count = 0
let joined = false
let deadline = 0
let timer = null
let onCancelCb = null

// Register what happens when a non-joiner dismisses the lobby (app.js un-dims + resumes browsing).
export function onCancel(cb) {
  onCancelCb = cb
}

export function open(e) {
  count = e.count || 1
  joined = !!e.mine || !!e.joined
  deadline = performance.now() + (e.lobbyMs || 15000)
  // a non-joiner gets Join + "Not now" (dismiss to keep browsing the previous gallery)
  joinBtn.style.display = joined ? 'none' : 'inline-block'
  cancelBtn.style.display = joined ? 'none' : 'inline-block'
  lobbyEl.classList.add('show')
  clearInterval(timer)
  timer = setInterval(paint, 200)
  paint()
}

export function update(n) {
  if (typeof n === 'number') count = n
  paint()
}

export function markJoined() {
  joined = true
  joinBtn.style.display = 'none'
}

// Gate the join button on the wave's kick-off payment being verified (anti-spam): show a
// "verifying…" state until the initiator's burn is confirmed, then enable joining.
export function setJoinable(ok) {
  if (joined) return
  joinBtn.disabled = !ok
  joinBtn.innerText = ok ? '✋ Count me in' : '⏳ verifying payment…'
}

export function close() {
  clearInterval(timer)
  lobbyEl.classList.remove('show')
}

function paint() {
  if (!lobbyEl.classList.contains('show')) return
  const secs = Math.max(0, Math.ceil((deadline - performance.now()) / 1000))
  countEl.innerText = secs
  msgEl.innerText = `wave forming · ${joined ? 'you are in' : 'join in?'} · ${count} in`
}

joinBtn.onclick = () => {
  joined = true
  joinBtn.style.display = 'none'
  cancelBtn.style.display = 'none'
  joinWave()
}

// "Not now": dismiss the lobby without joining. The wave still forms/runs (this peer just
// spectates); closing lets them keep browsing the gallery of the wave they just took part in.
cancelBtn.onclick = () => {
  close()
  if (onCancelCb) onCancelCb()
}
