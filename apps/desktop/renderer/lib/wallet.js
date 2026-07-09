// Wallet view: the self-custodial TRX wallet modal, opened from the top-right 💰. Shows the
// balance + address (with refresh / copy / faucet / send) and a transaction history that merges
// two sources by tx hash: the app's own events (burns / tips / sends — instant,
// optimistic) and the wallet's on-chain history fetched from the worker (which also surfaces
// funds/tips RECEIVED — things the app never sees as events). Each row links to Tronscan; a
// "full history" link deep-links to the address page. Extracted from hud.js.
import { refreshWallet, sendTrx, fetchTransactions } from './ipc.js'
import { openAddress, txLink } from './explorer.js'

const NILE_FAUCET_URL = 'https://nileex.io/join/getJoinPage'

const viewEl = document.getElementById('wallet-view')
const openBtn = document.getElementById('wallet-btn')
const closeBtn = document.getElementById('wallet-close')
const balanceEl = document.getElementById('wallet-balance')
const addressEl = document.getElementById('wallet-address')
const refreshBtn = document.getElementById('wallet-refresh')
const copyBtn = document.getElementById('wallet-copy')
const faucetBtn = document.getElementById('wallet-faucet')
const txsEl = document.getElementById('wallet-txs')
const explorerEl = document.getElementById('wallet-explorer')
const sendToggleBtn = document.getElementById('wallet-send-toggle')
const sendEl = document.getElementById('wallet-send')
const sendToInput = document.getElementById('send-to')
const sendAmountInput = document.getElementById('send-amount')
const sendBtn = document.getElementById('send-btn')
const sendStatusEl = document.getElementById('send-status')

let walletAddress = '' // full address, for copy + faucet + explorer links
const txById = new Map() // hash -> { hash, dir, icon, label, amount, ts } — merged history

// Worker `wallet` message (address + balance): keep the modal live whether open or not.
export function walletStatus({ address, trx }) {
  if (!address) return
  walletAddress = address
  balanceEl.innerText = `${trx.toFixed(2)} TRX` + (trx === 0 ? '  ⚠ unfunded' : '')
  addressEl.innerText = address.slice(0, 6) + '…' + address.slice(-4)
}

const SENT_META = {
  burn: { icon: '🔥', label: 'Burned participation fee' },
  tip: { icon: '💵', label: 'Tipped a selfie' },
  send: { icon: '📤', label: 'Sent TRX' }
}

// Record an outgoing tx the app just made (burn / tip / send), from a worker event — instant,
// with a specific label. Wins over the generic on-chain view for the same hash.
export function record({ kind, hash, amount }) {
  if (!hash) return
  const meta = SENT_META[kind] || { icon: '•', label: kind }
  txById.set(hash, { hash, dir: 'out', amount, ts: Date.now(), fromEvent: true, ...meta })
  renderHistory()
}

// Merge the wallet's on-chain history (both directions) fetched by the worker. A hash the app
// already logged from its own event keeps that richer label; everything else — crucially funds
// and tips RECEIVED — is added here.
export function setTransactions(list) {
  for (const tx of list || []) {
    if (txById.get(tx.hash)?.fromEvent) continue // keep the app's own labelled entry
    const meta =
      tx.direction === 'in'
        ? { icon: '📥', label: 'Received TRX' }
        : tx.memo?.startsWith('hyperwave:')
          ? { icon: '🔥', label: 'Burned participation fee' }
          : { icon: '📤', label: 'Sent TRX' }
    txById.set(tx.hash, {
      hash: tx.hash,
      dir: tx.direction,
      amount: tx.amount,
      ts: tx.timestamp || 0,
      ...meta
    })
  }
  renderHistory()
}

// "5m", "3h", "2d" — compact age; blank if we have no timestamp (optimistic just-sent entry).
function ago(ts) {
  if (!ts) return ''
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function renderHistory() {
  const rows = [...txById.values()].sort((a, b) => b.ts - a.ts).slice(0, 10)
  txsEl.replaceChildren(
    ...rows.map((tx) => {
      const row = document.createElement('div')
      row.className = 'tx-row'
      const label = document.createElement('span')
      label.className = 'tx-label'
      label.textContent = `${tx.icon} ${tx.label}`
      const time = document.createElement('span')
      time.className = 'tx-time'
      time.textContent = ago(tx.ts)
      const amt = document.createElement('span')
      amt.className = tx.dir === 'in' ? 'tx-amt in' : 'tx-amt'
      if (typeof tx.amount === 'number') {
        amt.textContent = `${tx.dir === 'in' ? '+' : '−'}${tx.amount} TRX`
      }
      row.append(label, time, amt, txLink(tx.hash))
      return row
    })
  )
}

// --- modal open/close -------------------------------------------------------
function open() {
  refreshWallet() // grab a fresh balance each time it's opened
  fetchTransactions() // pull the on-chain history (incoming funds/tips + everything else)
  viewEl.classList.add('show')
}
function close() {
  viewEl.classList.remove('show')
}
openBtn.onclick = open
closeBtn.onclick = close
viewEl.onclick = (e) => {
  if (e.target === viewEl) close() // click the backdrop to dismiss
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && viewEl.classList.contains('show')) close()
})

// --- wallet actions ---------------------------------------------------------
// Both the short address and the "full history" link open the address's on-chain history.
addressEl.onclick = () => openAddress(walletAddress)
explorerEl.onclick = () => openAddress(walletAddress)

copyBtn.onclick = async () => {
  if (!walletAddress) return
  await window.bridge.copyText(walletAddress)
  copyBtn.innerText = '✓ Copied'
  setTimeout(() => (copyBtn.innerText = '📋 Copy'), 1500)
}

// Re-fetch the balance now (the auto-poll is every 15s) — handy right after funding. The chip
// updates when the fresh `wallet` message lands; the spin is click feedback.
refreshBtn.onclick = () => {
  refreshWallet()
  fetchTransactions() // also re-pull the on-chain history
  refreshBtn.classList.remove('spin')
  void refreshBtn.offsetWidth // restart the animation if clicked again mid-spin
  refreshBtn.classList.add('spin')
}

// Open the Nile faucet in the default browser, where they paste the address to receive test TRX.
faucetBtn.onclick = () => window.bridge.openExternal(NILE_FAUCET_URL)

// --- send TRX ---------------------------------------------------------------
// A plain transfer to any address — mainly to fund another peer's wallet (replacing the
// wave.run.js CLI dance). The worker does the real send + a balance check; here we only do
// cheap input validation and drive the button/status.
function setSendStatus(text, cls) {
  sendStatusEl.textContent = text || ''
  sendStatusEl.className = cls || ''
}

sendToggleBtn.onclick = () => {
  const showing = sendEl.classList.toggle('show')
  sendToggleBtn.textContent = showing ? 'Send ▾' : 'Send ▸'
  if (showing) sendToInput.focus()
}

function submitSend() {
  const to = sendToInput.value.trim()
  const amount = Number(sendAmountInput.value)
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(to)) {
    return setSendStatus('Enter a valid Tron address (T…)', 'err')
  }
  if (!(amount > 0)) return setSendStatus('Enter an amount greater than 0', 'err')
  sendBtn.disabled = true
  setSendStatus(`Sending ${amount} TRX…`, '')
  sendTrx(to, amount)
}
sendBtn.onclick = submitSend
sendAmountInput.onkeydown = (e) => {
  if (e.key === 'Enter') submitSend()
}

// Worker reply to a send: success → record it + reset the form; error → surface it.
export function sendResult({ hash, to, amount, error }) {
  sendBtn.disabled = false
  if (error) return setSendStatus(`⚠️ send failed: ${error}`, 'err')
  record({ kind: 'send', hash, amount })
  setSendStatus(`✅ sent ${amount} TRX to ${to.slice(0, 6)}…${to.slice(-4)}`, 'ok')
  sendToInput.value = ''
  sendAmountInput.value = ''
}
