// Lobby panel (opt in before the wave starts) — the countdown + join button shown
// in the centre of the ring while a wave is forming.
import { joinWave } from './ipc.js'

const lobbyEl = document.getElementById('lobby')
const msgEl = document.getElementById('lobby-msg')
const countEl = document.getElementById('lobby-count')
const joinBtn = document.getElementById('join')

let count = 0
let joined = false
let deadline = 0
let timer = null

export function open(e) {
  count = e.count || 1
  joined = !!e.mine || !!e.joined
  deadline = performance.now() + (e.lobbyMs || 15000)
  joinBtn.style.display = joined ? 'none' : 'inline-block'
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

export function close() {
  clearInterval(timer)
  lobbyEl.classList.remove('show')
}

function paint() {
  if (!lobbyEl.classList.contains('show')) return
  const secs = Math.max(0, Math.ceil((deadline - performance.now()) / 1000))
  countEl.innerText = secs
  msgEl.innerText = `🌊 wave forming · ${joined ? 'you are in' : 'join in?'} · ${count} in`
}

joinBtn.onclick = () => {
  joined = true
  joinBtn.style.display = 'none'
  joinWave()
}
