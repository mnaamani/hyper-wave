// Wallet view: the self-custodial TRX wallet modal, opened from the top-right 💰. Shows the
// balance + address (with refresh / copy / faucet) and this session's transaction history —
// each burn/tip/raffle payout the app made, as a clickable Tronscan link. A "full history"
// link deep-links to the address's on-chain history for anything not captured here (e.g.
// incoming tips). Extracted from hud.js so the wallet chrome lives in one place.
import { refreshWallet } from './ipc.js'
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

let walletAddress = '' // full address, for copy + faucet + explorer links
const history = [] // { icon, label, amount, hash } — this session's outgoing txns, newest first

// Worker `wallet` message (address + balance): keep the modal live whether open or not.
export function walletStatus({ address, trx }) {
  if (!address) return
  walletAddress = address
  balanceEl.innerText = `${trx.toFixed(2)} TRX` + (trx === 0 ? '  ⚠ unfunded' : '')
  addressEl.innerText = address.slice(0, 6) + '…' + address.slice(-4)
}

// Record an outgoing transaction the app just made (burn / tip / raffle payout) so it shows in
// the history list. Called from app.js as the tx-bearing worker events land.
export function record({ kind, hash, amount }) {
  if (!hash) return
  const meta = {
    burn: { icon: '🔥', label: 'Burned participation fee' },
    tip: { icon: '💵', label: 'Tipped a selfie' },
    raffle: { icon: '🎁', label: 'Paid raffle prize' }
  }[kind] || { icon: '•', label: kind }
  history.unshift({ ...meta, amount, hash })
  renderHistory()
}

function renderHistory() {
  txsEl.replaceChildren(
    ...history.map((tx) => {
      const row = document.createElement('div')
      row.className = 'tx-row'
      const label = document.createElement('span')
      label.className = 'tx-label'
      label.textContent = `${tx.icon} ${tx.label}`
      const amt = document.createElement('span')
      amt.className = 'tx-amt'
      if (typeof tx.amount === 'number') amt.textContent = `−${tx.amount} TRX`
      row.append(label, amt, txLink(tx.hash))
      return row
    })
  )
}

// --- modal open/close -------------------------------------------------------
function open() {
  refreshWallet() // grab a fresh balance each time it's opened
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
  refreshBtn.classList.remove('spin')
  void refreshBtn.offsetWidth // restart the animation if clicked again mid-spin
  refreshBtn.classList.add('spin')
}

// Open the Nile faucet in the default browser, where they paste the address to receive test TRX.
faucetBtn.onclick = () => window.bridge.openExternal(NILE_FAUCET_URL)
