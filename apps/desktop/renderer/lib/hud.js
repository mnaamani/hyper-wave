// HUD: the DOM chrome around the field — version label, status line, country picker,
// and the Kick-off button (which docks below the ring once there's a gallery).
import { COUNTRIES, flagOf } from './countries.js'
import { startWave, setCountry, refreshWallet, appVersion } from './ipc.js'
import { openAddress } from './explorer.js'

const statusEl = document.getElementById('status')
const waveEl = document.getElementById('wave-status')
const updaterEl = document.getElementById('updater')
const startBtn = document.getElementById('start')
const walletEl = document.getElementById('wallet')
const walletBalanceEl = document.getElementById('wallet-balance')
const walletAddressEl = document.getElementById('wallet-address')
const walletRefreshBtn = document.getElementById('wallet-refresh')
const walletCopyBtn = document.getElementById('wallet-copy')
const walletFaucetBtn = document.getElementById('wallet-faucet')

document.getElementById('v').innerText = 'v' + appVersion()

// --- wallet chip (self-custodial TRX wallet) -------------------------------
const NILE_FAUCET_URL = 'https://nileex.io/join/getJoinPage'
let walletAddress = '' // full address, for the copy + faucet + explorer links

export function walletStatus({ address, trx }) {
  if (!address) return
  walletAddress = address
  walletBalanceEl.innerText = `💰 ${trx.toFixed(2)} TRX` + (trx === 0 ? ' · ⚠ unfunded' : '')
  walletAddressEl.innerText = address.slice(0, 6) + '…' + address.slice(-4)
  walletEl.classList.add('ready') // reveal the chip + copy/faucet buttons now the wallet is up
}

// Open the address on the Nile block explorer (via main — the renderer is sandboxed).
walletAddressEl.onclick = () => openAddress(walletAddress)

// Copy the full wallet address to the clipboard (via main — the renderer is sandboxed), with
// brief button feedback. New users copy this, then paste it into the faucet.
walletCopyBtn.onclick = async () => {
  if (!walletAddress) return
  await window.bridge.copyText(walletAddress)
  walletCopyBtn.innerText = '✓ Copied'
  setTimeout(() => (walletCopyBtn.innerText = '📋 Copy'), 1500)
}

// Ask the worker to re-fetch the balance now (the auto-poll is every 15s) — handy right after
// funding. The chip updates when the fresh `wallet` message lands; the spin is click feedback.
walletRefreshBtn.onclick = () => {
  refreshWallet()
  walletRefreshBtn.classList.remove('spin')
  void walletRefreshBtn.offsetWidth // restart the animation if clicked again mid-spin
  walletRefreshBtn.classList.add('spin')
}

// Open the Nile faucet in the default browser, where they paste the address to receive test TRX.
walletFaucetBtn.onclick = () => window.bridge.openExternal(NILE_FAUCET_URL)

// --- status lines + start button --------------------------------------------
// The persistent network status line (peer count).
export function networkStatus(text) {
  statusEl.innerText = text
}
// The live wave narration, on its own line (paying / lobby / racing / result). Pass '' to clear it
// (the element collapses via #wave-status:empty). Kept separate from networkStatus() so the two
// never fight over one line — networkStatus() shows peer count even while a wave narrates here.
export function waveStatus(text) {
  waveEl.innerText = text || ''
}
// Like waveStatus but for a mix of text + nodes (e.g. a clickable tx link from explorer.js).
export function waveStatusNodes(...parts) {
  waveEl.replaceChildren(...parts)
}
// OTA update notice (its own line), set by updater.js when the app is updating. Separate again so
// it never collides with the network status line.
export function updatingStatus(text) {
  updaterEl.innerText = text || ''
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
const myFlagEl = document.getElementById('myflag')

let country = localStorage.getItem('hyperwave-country') || ''

// Show the user's team flag next to the globe (hidden until a team is picked).
function renderMyFlag() {
  myFlagEl.innerText = country ? flagOf(country) : ''
}

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
renderMyFlag()

if (!country) introEl.classList.add('show') // first time only

function applyCountry(code) {
  country = code
  localStorage.setItem('hyperwave-country', country)
  introCountryEl.value = country
  renderMyFlag()
  setCountry(country)
}

introCountryEl.onchange = () => applyCountry(introCountryEl.value)
enterBtn.onclick = () => introEl.classList.remove('show')
globeBtn.onclick = () => introEl.classList.add('show')
myFlagEl.onclick = () => introEl.classList.add('show') // click your flag to change team too

// push our stored country to the worker (called once it's up)
export function sendCountry() {
  setCountry(country)
}
