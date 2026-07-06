// HUD: the DOM chrome around the field — version label, status line, country picker,
// and the Kick-off button (which docks below the ring once there's a gallery).
import { COUNTRIES, flagOf } from './countries.js'
import { startWave, setCountry, appVersion } from './ipc.js'

const statusEl = document.getElementById('status')
const waveEl = document.getElementById('wave-status')
const startBtn = document.getElementById('start')
const walletEl = document.getElementById('wallet')

document.getElementById('v').innerText = 'v' + appVersion()

// --- wallet chip (self-custodial TRX wallet) -------------------------------
export function wallet({ address, trx }) {
  if (!address) return
  const short = address.slice(0, 6) + '…' + address.slice(-4)
  walletEl.innerText = `💰 ${trx.toFixed(2)} TRX · ${short}` + (trx === 0 ? ' · ⚠ unfunded' : '')
}

// --- status + start button --------------------------------------------------
// The persistent status line (idle chrome: peer count).
export function status(text) {
  statusEl.innerText = text
}
// The live wave narration, on its own line (paying / lobby / racing / result). Pass '' to clear
// it (the element collapses via #wave-status:empty). Kept separate from status() so the two never
// fight over one line — status() shows peer count even while a wave narrates here.
export function wave(text) {
  waveEl.innerText = text || ''
}
export function showStart(show) {
  startBtn.style.display = show ? '' : 'none'
}
export function dockStart(docked) {
  startBtn.classList.toggle('docked', docked)
}
startBtn.onclick = () => startWave()

// --- country picker + intro screen ------------------------------------------
// The intro overlay (pick your team) shows only on first launch — if a team is
// already saved we skip straight to the ring. The top-right 🌐 button reopens it.
const introEl = document.getElementById('intro')
const introCountryEl = document.getElementById('intro-country')
const enterBtn = document.getElementById('enter')
const globeBtn = document.getElementById('globe')

let country = localStorage.getItem('hyperwave-country') || ''

const placeholder = document.createElement('option')
placeholder.value = ''
placeholder.text = '🏳️ pick your team'
introCountryEl.appendChild(placeholder)
for (const [code, name] of COUNTRIES) {
  const o = document.createElement('option')
  o.value = code
  o.text = `${flagOf(code)} ${name}`
  introCountryEl.appendChild(o)
}
introCountryEl.value = country

if (!country) introEl.classList.add('show') // first time only

function applyCountry(code) {
  country = code
  localStorage.setItem('hyperwave-country', country)
  introCountryEl.value = country
  setCountry(country)
}

introCountryEl.onchange = () => applyCountry(introCountryEl.value)
enterBtn.onclick = () => introEl.classList.remove('show')
globeBtn.onclick = () => introEl.classList.add('show')

// push our stored country to the worker (called once it's up)
export function sendCountry() {
  setCountry(country)
}
