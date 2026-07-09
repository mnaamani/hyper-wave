// HUD: the DOM chrome around the field — version label, status line, country picker,
// and the Kick-off button (which docks below the ring once there's a gallery). The wallet
// view lives in its own module (wallet.js).
import { COUNTRIES, flagOf } from './countries.js';
import { startWave, setCountry, appVersion } from './ipc.js';

const statusEl = document.getElementById('status');
const waveEl = document.getElementById('wave-status');
const updaterEl = document.getElementById('updater');
const startBtn = document.getElementById('start');

document.getElementById('v').innerText = 'v' + appVersion();

// --- status lines + start button --------------------------------------------
// The persistent network status line (peer count).
export function networkStatus(text) {
  statusEl.innerText = text;
}
// The live wave narration, on its own line (paying / lobby / racing / result). Pass '' to clear it
// (the element collapses via #wave-status:empty). Kept separate from networkStatus() so the two
// never fight over one line — networkStatus() shows peer count even while a wave narrates here.
export function waveStatus(text) {
  waveEl.innerText = text || '';
}
// Like waveStatus but for a mix of text + nodes (e.g. a clickable tx link from explorer.js).
export function waveStatusNodes(...parts) {
  waveEl.replaceChildren(...parts);
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
// The intro overlay (pick your team) shows only on first launch — if a team is
// already saved we skip straight to the ring. The top-right 🌐 button reopens it.
const introEl = document.getElementById('intro');
const introCountryEl = document.getElementById('intro-country');
const enterBtn = document.getElementById('enter');
const globeBtn = document.getElementById('globe');
const myFlagEl = document.getElementById('myflag');

let country = localStorage.getItem('hyperwave-country') || '';

// Show the user's team flag next to the globe (hidden until a team is picked).
function renderMyFlag() {
  myFlagEl.innerText = country ? flagOf(country) : '';
}

const placeholder = document.createElement('option');
placeholder.value = '';
placeholder.text = '🏳️ pick your team';
introCountryEl.appendChild(placeholder);
for (const [code, name] of COUNTRIES) {
  const option = document.createElement('option');
  option.value = code;
  option.text = `${flagOf(code)} ${name}`;
  introCountryEl.appendChild(option);
}
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
globeBtn.onclick = () => introEl.classList.add('show');
myFlagEl.onclick = () => introEl.classList.add('show'); // click your flag to change team too

// push our stored country to the worker (called once it's up)
export function sendCountry() {
  setCountry(country);
}
