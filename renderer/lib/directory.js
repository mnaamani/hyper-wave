// Wave directory, rendered as orbiting BUBBLES: one small circle per live wave this peer is
// aware of (from every wave-announce / wave-sync flooded across the shared directory topic).
// Each bubble sits at its initiator's seat angle just outside the ring, coloured by phase; the
// active one is enlarged + glowing. Merely being aware holds NO cores — clicking a bubble is what
// subscribes (holds its feed) and makes it the active wave. This is the UI surface for scaling.md's
// directory -> subtopics model. Theme-agnostic engine fields (waveId, by) map to app concepts here
// (the initiator's country flag, derived from the global ring).
import { flagOf } from './countries.js';
import { unitLabel } from './wallet-meta.js';
import { angleOfId } from './ring.js';

const orbitEl = document.getElementById('wave-orbit');

// Ring geometry (mirrors ring.js): the 440px field, centre at 220,220. Bubbles orbit just
// outside the 170px ring so they read as satellites of it without covering the centre content.
const CENTER = 220;
const ORBIT_RADIUS = 196;

let onSelectCb = () => {};
let countryOf = () => ''; // ring-id -> country code, supplied by app.js from the global ring

/**
 * Register the click handler — app.js's selectWave(waveId) subscribes + activates.
 * @param {(waveId: string) => void} cb The selection callback.
 * @returns {void}
 */
export function onSelect(cb) {
  onSelectCb = cb;
}

/**
 * Supply the ring-id -> country lookup (from the global heartbeat ring) so a bubble can show the
 * initiator's flag.
 * @param {(id: string) => string} fn The lookup.
 * @returns {void}
 */
export function setCountryLookup(fn) {
  countryOf = fn;
}

// A short, human label for the initiator: "You" for my own wave, else a 6-char id prefix.
function initiatorLabel(wave) {
  if (wave.mine) {
    return 'You';
  }
  return wave.by ? wave.by.slice(0, 6) : 'peer';
}

// [left, top] px of the bubble for `wave`, at its initiator's seat angle just outside the ring.
function bubblePoint(wave) {
  const angle = wave.by ? angleOfId(wave.by) : 0;
  const radians = ((angle - 90) * Math.PI) / 180; // 0° at top, clockwise (matches ring.js)
  return [
    CENTER + ORBIT_RADIUS * Math.cos(radians),
    CENTER + ORBIT_RADIUS * Math.sin(radians)
  ];
}

function buildBubble(wave, activeId) {
  const [x, y] = bubblePoint(wave);
  const bubble = document.createElement('button');
  bubble.className = `wave-bubble ${wave.phase || 'lobby'}`;
  if (wave.waveId === activeId) {
    bubble.classList.add('active');
  }
  if (wave.fading) {
    bubble.classList.add('fading'); // grace period elapsed — fade out then drop
  }
  bubble.style.left = `${x}px`;
  bubble.style.top = `${y}px`;
  bubble.dataset.wave = wave.waveId;
  const peers = `${wave.count || 1} peer${(wave.count || 1) === 1 ? '' : 's'}`;
  const fee =
    typeof wave.fee === 'number' ? ` · ${wave.fee} ${unitLabel(wave.fee)}` : '';
  bubble.title = `${initiatorLabel(wave)} · ${peers} · ${wave.phase}${fee}`;

  const flag = document.createElement('span');
  flag.className = 'bub-flag';
  flag.textContent = flagOf(countryOf(wave.by)) || '🌐';
  const count = document.createElement('span');
  count.className = 'bub-count';
  count.textContent = String(wave.count || 1);
  bubble.append(flag, count);
  bubble.onclick = () => onSelectCb(wave.waveId);
  return bubble;
}

/**
 * Render one orbiting bubble per known wave, marking `active`.
 * @param {Map<string, Object>} waves The waveId -> meta map app.js maintains.
 * @param {string|null} active The active waveId.
 * @returns {void}
 */
export function render(waves, active) {
  orbitEl.replaceChildren(
    ...[...waves.values()].map((wave) => buildBubble(wave, active))
  );
}
