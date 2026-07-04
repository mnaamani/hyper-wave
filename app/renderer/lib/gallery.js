// The wave gallery: which selfie to feature in the ring centre (one at a time), and
// the collection-progress bar. Selfies arrive slower than the ball races (proof
// window + capture + replication), so we feature each new arrival, auto-cycle when
// idle, and show how many of the expected (roster) selfies have landed.
import * as ring from './ring.js'
import { tip } from './ipc.js'

const progressEl = document.getElementById('progress')
const progressFill = document.getElementById('progress-fill')
const progressLabel = document.getElementById('progress-label')
const tipBtn = document.getElementById('tip')
const ADVANCE_MS = 3500
const TIP_TRX = 1

let items = []
let centerIdx = 0
let advanceTimer = null
let expected = 0
let active = false
let myAddress = null // my own wallet — never tip myself
const shownKeys = new Set() // waveId|peerId already featured

// Tell the gallery our own wallet address so it hides the tip button on our own selfies.
export function setMyAddress(addr) {
  myAddress = addr
  refreshTip()
}

// Show the tip button when the featured selfie has a payable address that isn't mine.
function refreshTip() {
  const it = items[centerIdx]
  const payable = it && it.address && it.address !== myAddress
  tipBtn.classList.toggle('show', !!payable)
  tipBtn.disabled = false
  tipBtn.innerText = `💵 Tip ${TIP_TRX} TRX`
}

tipBtn.onclick = () => {
  const it = items[centerIdx]
  if (!it || !it.address || it.address === myAddress) return
  tipBtn.disabled = true
  tipBtn.innerText = '💸 sending…'
  tip(it.address, TIP_TRX, it.peerId)
}

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
  refreshTip()
}

const toastEl = document.getElementById('tip-toast')
// Worker reply to a tip: show the tx hash (success) or the error, then re-enable.
export function tipResult({ hash, error }) {
  toastEl.innerText = hash
    ? `✅ tipped — tx ${hash.slice(0, 10)}…`
    : `⚠️ tip failed: ${error || 'unknown'}`
  setTimeout(() => (toastEl.innerText = ''), 6000)
  refreshTip()
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
  refreshTip()
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
