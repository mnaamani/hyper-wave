// The wave gallery: which selfie to feature in the ring centre (one at a time), and
// the collection-progress bar. Selfies arrive slower than the ball races (proof
// window + capture + replication), so we feature each new arrival, auto-cycle when
// idle, and show how many of the expected (roster) selfies have landed.
import * as ring from './ring.js'

const progressEl = document.getElementById('progress')
const progressFill = document.getElementById('progress-fill')
const progressLabel = document.getElementById('progress-label')
const ADVANCE_MS = 3500

let items = []
let centerIdx = 0
let advanceTimer = null
let expected = 0
let active = false
const shownKeys = new Set() // waveId|peerId already featured

export function count() {
  return items.length
}

export function setActive(on) {
  active = on
  updateProgress()
}

export function setExpected(n) {
  expected = n
  updateProgress()
}

function feature(i) {
  centerIdx = i
  ring.setCenter(items[centerIdx] || null)
}

function scheduleAdvance() {
  clearTimeout(advanceTimer)
  advanceTimer = setTimeout(() => {
    if (items.length > 1) {
      feature((centerIdx + 1) % items.length)
      scheduleAdvance()
    }
  }, ADVANCE_MS)
}

export function handle(newItems) {
  // feature the newest arrival (highest hop among not-yet-shown)
  let jumpTo = -1
  let jumpHop = -Infinity
  for (let i = 0; i < newItems.length; i++) {
    const it = newItems[i]
    const k = it.waveId + '|' + it.peerId
    if (!shownKeys.has(k)) {
      shownKeys.add(k)
      if (it.hopCount >= jumpHop) {
        jumpHop = it.hopCount
        jumpTo = i
      }
    }
  }
  items = newItems
  if (jumpTo >= 0) {
    feature(jumpTo)
    scheduleAdvance()
  } else if (centerIdx >= items.length) {
    feature(0)
  } else {
    ring.setCenter(items[centerIdx] || null)
  }
  updateProgress()
}

export function hideProgress() {
  progressEl.classList.remove('show')
}

function updateProgress() {
  const got = items.length
  if (!active && got === 0) return hideProgress()
  const total = Math.max(expected, got, 1)
  progressEl.classList.add('show')
  progressFill.style.width = Math.round((got / total) * 100) + '%'
  progressLabel.innerText =
    got >= total
      ? `📸 all ${got} selfie${got === 1 ? '' : 's'} in!`
      : `📸 collecting selfies… ${got} / ${total}`
}
