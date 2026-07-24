// HUD: the DOM chrome around the field — version label, status line, country picker,
// and the Start button (which docks below the ring once there is a gallery). The wallet
// view lives in its own module (wallet.js).
import { COUNTRIES, flagOf } from './countries.js';
import { startWave, setCountry, appVersion } from './ipc.js';

const statusEl = document.getElementById('status');
const statusPillEl = document.getElementById('status-pill');
const waveEl = document.getElementById('wave-status');
const updaterEl = document.getElementById('updater');
const startBtn = document.getElementById('start');
const introEl = document.getElementById('intro');
const introCountryEl = document.getElementById('intro-country');
const enterBtn = document.getElementById('enter');
const myFlagEl = document.getElementById('myflag');

let country = localStorage.getItem('hyperwave-country') || '';

document.getElementById('v').innerText = 'v' + appVersion();

// --- status lines + start button --------------------------------------------
// The persistent connection pill: a live/searching dot + peer count. Steady once
// peers are connected, pinging while we're still reaching out across the network.
export function networkStatus({ peers }) {
  const live = peers > 0;
  statusPillEl.classList.toggle('live', live);
  statusPillEl.classList.toggle('searching', !live);
  statusEl.innerText = live
    ? `${peers} around the world · connected`
    : 'reaching the network…';
}
// The live wave narration, on its own line (paying / lobby / racing / result). Pass '' to clear it
// (the element collapses via #wave-status:empty). Kept separate from networkStatus() so the two
// never fight over one line — networkStatus() shows peer count even while a wave narrates here.
export function waveStatus(text) {
  waveEl.innerText = text || '';
}
// OTA update notice (its own line), set by updater.js when the app is updating. Separate again so
// it never collides with the network status line.
export function updatingStatus(text) {
  updaterEl.innerText = text || '';
}
export function showStart(show) {
  startBtn.style.display = show ? '' : 'none';
}
export function dockStart(docked) {
  startBtn.classList.toggle('docked', docked);
}
startBtn.onclick = () => startWave();

// --- country picker + intro screen ------------------------------------------
// The intro overlay (pick your country) shows only on first launch — if a country is
// already saved we skip straight to the ring. The country button reopens it.

// The country button: the picked country's flag, or a 🌐 globe prompting a first pick.
function renderMyFlag() {
  myFlagEl.innerText = country ? flagOf(country) : '🌐';
}

// Fill the picker: a placeholder plus one option per country.
function buildCountryPicker() {
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.text = '🏳️ pick your country';
  introCountryEl.appendChild(placeholder);
  for (const [code, name] of COUNTRIES) {
    const option = document.createElement('option');
    option.value = code;
    option.text = `${flagOf(code)} ${name}`;
    introCountryEl.appendChild(option);
  }
}

buildCountryPicker();
introCountryEl.value = country;
renderMyFlag();

if (!country) {
  introEl.classList.add('show'); // first time only
}

function applyCountry(code) {
  country = code;
  localStorage.setItem('hyperwave-country', country);
  introCountryEl.value = country;
  renderMyFlag();
  setCountry(country);
}

introCountryEl.onchange = () => applyCountry(introCountryEl.value);
enterBtn.onclick = () => introEl.classList.remove('show');
myFlagEl.onclick = () => introEl.classList.add('show'); // globe/flag → open the picker

// push our stored country to the worker (called once it's up)
export function sendCountry() {
  setCountry(country);
}
