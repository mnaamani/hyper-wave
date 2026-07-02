// HUD: the DOM chrome around the field — version label, status line, country picker,
// and the Kick-off button (which docks below the ring once there's a gallery).
import { COUNTRIES, flagOf } from './countries.js'
import { startWave, setCountry, appVersion } from './ipc.js'

const statusEl = document.getElementById('status')
const startBtn = document.getElementById('start')
const countryEl = document.getElementById('country')

document.getElementById('v').innerText = 'v' + appVersion()

// --- status + start button --------------------------------------------------
export function status(text) {
  statusEl.innerText = text
}
export function showStart(show) {
  startBtn.style.display = show ? '' : 'none'
}
export function dockStart(docked) {
  startBtn.classList.toggle('docked', docked)
}
startBtn.onclick = () => startWave()

// --- country picker ---------------------------------------------------------
let country = localStorage.getItem('hyperwave-country') || ''

const placeholder = document.createElement('option')
placeholder.value = ''
placeholder.text = '🏳️ your team'
countryEl.appendChild(placeholder)
for (const [code, name] of COUNTRIES) {
  const o = document.createElement('option')
  o.value = code
  o.text = `${flagOf(code)} ${name}`
  countryEl.appendChild(o)
}
countryEl.value = country

countryEl.onchange = () => {
  country = countryEl.value
  localStorage.setItem('hyperwave-country', country)
  setCountry(country)
}

// push our stored country to the worker (called once it's up)
export function sendCountry() {
  setCountry(country)
}
