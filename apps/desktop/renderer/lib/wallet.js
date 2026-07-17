// Wallet view: the self-custodial TRX wallet modal, opened from the top-right 💰. Shows the
// balance + address (with refresh / copy / faucet / send) and a transaction history that merges
// two sources by tx hash: the app's own events (burns / tips / sends — instant,
// optimistic) and the wallet's on-chain history fetched from the worker (which also surfaces
// funds/tips RECEIVED — things the app never sees as events). Each row links to Tronscan; a
// "full history" link deep-links to the address page. Extracted from hud.js.
import {
  refreshWallet,
  sendTrx,
  fetchTransactions,
  listAccounts,
  setAccount,
  setMint,
  fundWallet
} from './ipc.js';
import { isCashu, unitLabel, activeMint } from './wallet-meta.js';
import { qrDataUrl } from './qr.js';
import { openAddress, txLink } from './explorer.js';

const NILE_FAUCET_URL = 'https://nileex.io/join/getJoinPage';
// Curated Cashu mints for the picker (each peer chooses its own). The DEFAULT is testnut — a free
// TEST mint (auto-pays mint quotes, no real Lightning), so the demo funds/burns/tips with no real
// money, honouring the project's testnet-only rule. The two ⚠ MAINNET mints below are real,
// reputable, Lightning-connected mints (verified live via /v1/info: bolt11 mint+melt, NUT-07/11/12)
// — selecting one means REAL sats: Top up pays a real invoice, burns/tips move real funds. They're
// the only way to actually settle cross-mint tips (consolidate), which fake mints can't do. Keep
// testnut first so it stays the default.
const CASHU_MINTS = [
  { url: 'https://testnut.cashu.space', label: 'testnut (test · auto-pay)' },
  { url: 'https://nofee.testnut.cashu.space', label: 'testnut · no fees' },
  {
    url: 'https://mint.minibits.cash/Bitcoin',
    label: '⚠ Minibits — mainnet · REAL sats'
  },
  { url: 'https://mint.coinos.io', label: '⚠ Coinos — mainnet · REAL sats' }
];
// How many sats a "Top up" mints at once (testnut auto-pays; a real mint returns an invoice).
const TOPUP_SATS = 100;

const viewEl = document.getElementById('wallet-view');
const openBtn = document.getElementById('wallet-btn');
const closeBtn = document.getElementById('wallet-close');
const balanceEl = document.getElementById('wallet-balance');
const addressEl = document.getElementById('wallet-address');
const refreshBtn = document.getElementById('wallet-refresh');
const copyBtn = document.getElementById('wallet-copy');
const faucetBtn = document.getElementById('wallet-faucet');
const txsEl = document.getElementById('wallet-txs');
const explorerEl = document.getElementById('wallet-explorer');
const sendToggleBtn = document.getElementById('wallet-send-toggle');
const sendEl = document.getElementById('wallet-send');
const sendToInput = document.getElementById('send-to');
const sendAmountInput = document.getElementById('send-amount');
const sendBtn = document.getElementById('send-btn');
const sendStatusEl = document.getElementById('send-status');
const accountSelect = document.getElementById('wallet-account');
const topupEl = document.getElementById('wallet-topup');
const topupQrEl = document.getElementById('topup-qr');
const topupHintEl = document.getElementById('topup-hint');
const topupCloseBtn = document.getElementById('topup-close');

// Icon + label per kind of outgoing tx the app itself makes (worker events).
const SENT_META = {
  burn: { icon: '🔥', label: 'Burned participation fee' },
  tip: { icon: '💵', label: 'Tipped a selfie' },
  send: { icon: '📤', label: 'Sent' }
};

let walletAddress = ''; // full address, for copy + faucet + explorer links
let activeAccount = 0; // the active BIP-44 account index (multi-account wallet)
let topupInvoice = ''; // the bolt11 currently shown as a QR (click the QR to re-copy it)
const txById = new Map(); // hash -> { hash, dir, icon, label, amount, ts } — merged history

// Worker `wallet` message (address + balance + which account): keep the modal live whether open or
// not. A live account switch arrives here too (a new accountIndex + address) — clear the old
// account's history and re-fetch for the new one.
export function walletStatus({ address, amount, unit, accountIndex, mint }) {
  if (!address) {
    return;
  }
  if (Number.isInteger(accountIndex) && accountIndex !== activeAccount) {
    activeAccount = accountIndex;
    txById.clear(); // the history belonged to the previous account's address
    if (!isCashu()) {
      fetchTransactions();
    }
    syncAccountSelect();
  }
  walletAddress = address;
  // Cashu balances are whole sats; a chain balance shows 2 decimals.
  const shown = isCashu() ? String(amount) : amount.toFixed(2);
  balanceEl.innerText =
    `${shown} ${unit}` + (amount === 0 ? '  ⚠ unfunded' : '');
  addressEl.innerText = address.slice(0, 6) + '…' + address.slice(-4);
  // Cashu reuses the account <select> as a MINT picker (no BIP-44 accounts), the faucet button as
  // a "Top up" (mint-funded), and hides the chain-only Send form + explorer links.
  if (isCashu()) {
    applyCashuChrome(mint || activeMint());
  }
}

// Repurpose the modal's chain-wallet chrome for Cashu: mint picker, top-up, no explorer/send.
function applyCashuChrome(currentMint) {
  faucetBtn.textContent = '⬆ Top up';
  faucetBtn.title = `Mint ${TOPUP_SATS} sat at the selected mint`;
  sendToggleBtn.style.display = 'none'; // the modal can't deliver a bearer token
  explorerEl.style.display = 'none'; // ecash has no block explorer (no Tronscan link)
  renderMintPicker(currentMint);
}

// Render the curated mints into the account <select>, marking the active one. Includes the active
// mint even if it's a custom one not in the list, so the selection always reflects reality.
function renderMintPicker(currentMint) {
  const known = CASHU_MINTS.slice();
  if (currentMint && !known.some((mint) => mint.url === currentMint)) {
    known.unshift({ url: currentMint, label: currentMint });
  }
  accountSelect.replaceChildren(
    ...known.map((mint) => {
      const option = document.createElement('option');
      option.value = mint.url;
      option.textContent = mint.label;
      option.selected = mint.url === currentMint;
      return option;
    })
  );
}

// Worker `accounts` message: render the picker (all derived from the same seed, distinct addresses).
export function setAccounts({ list, active }) {
  if (!list) {
    return;
  }
  if (Number.isInteger(active)) {
    activeAccount = active;
  }
  accountSelect.replaceChildren(
    ...list.map((account) => {
      const option = document.createElement('option');
      option.value = String(account.index);
      const short =
        account.address.slice(0, 6) + '…' + account.address.slice(-4);
      option.textContent = `Account ${account.index + 1} — ${short}`;
      option.selected = account.index === activeAccount;
      return option;
    })
  );
}

// Keep the dropdown's selection in sync with the active account (e.g. after a switch confirms).
function syncAccountSelect() {
  if (accountSelect.options.length) {
    accountSelect.value = String(activeAccount);
  }
}

// Switch the active account (live re-wire, same seed). The worker replies with a new `wallet`
// message carrying the new accountIndex + address, which walletStatus applies above.
accountSelect.onchange = () => {
  // Cashu: the <select> holds mint URLs — switch the active mint (live re-wire). Chain wallet:
  // it holds BIP-44 account indices.
  if (isCashu()) {
    if (accountSelect.value) {
      setMint(accountSelect.value);
    }
    return;
  }
  const index = Number(accountSelect.value);
  if (Number.isInteger(index) && index !== activeAccount) {
    setAccount(index);
  }
};

// Record an outgoing tx the app just made (burn / tip / send), from a worker event — instant,
// with a specific label. Wins over the generic on-chain view for the same hash.
export function record({ kind, hash, amount }) {
  if (!hash) {
    return;
  }
  const meta = SENT_META[kind] || { icon: '•', label: kind };
  txById.set(hash, {
    hash,
    dir: 'out',
    amount,
    ts: Date.now(),
    fromEvent: true,
    ...meta
  });
  renderHistory();
}

// Icon + label for an on-chain tx the app didn't log from its own events (those use SENT_META).
function chainTxMeta(tx) {
  if (tx.direction === 'in') {
    return { icon: '📥', label: 'Received TRX' };
  }
  if (tx.memo?.startsWith('hyperwave:')) {
    return { icon: '🔥', label: 'Burned participation fee' };
  }
  return { icon: '📤', label: 'Sent TRX' };
}

// Merge the wallet's on-chain history (both directions) fetched by the worker. A hash the app
// already logged from its own event keeps that richer label; everything else — crucially funds
// and tips RECEIVED — is added here.
export function setTransactions(list) {
  for (const tx of list || []) {
    if (txById.get(tx.hash)?.fromEvent) {
      continue; // keep the app's own labelled entry
    }
    const meta = chainTxMeta(tx);
    txById.set(tx.hash, {
      hash: tx.hash,
      dir: tx.direction,
      amount: tx.amount,
      ts: tx.timestamp || 0,
      ...meta
    });
  }
  renderHistory();
}

// "5m", "3h", "2d" — compact age; blank if we have no timestamp (optimistic just-sent entry).
function ago(ts) {
  if (!ts) {
    return '';
  }
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h`;
  }
  return `${Math.floor(seconds / 86400)}d`;
}

function renderHistory() {
  const rows = [...txById.values()].sort((a, b) => b.ts - a.ts).slice(0, 10);
  txsEl.replaceChildren(
    ...rows.map((tx) => {
      const row = document.createElement('div');
      row.className = 'tx-row';
      const label = document.createElement('span');
      label.className = 'tx-label';
      label.textContent = `${tx.icon} ${tx.label}`;
      const time = document.createElement('span');
      time.className = 'tx-time';
      time.textContent = ago(tx.ts);
      const amt = document.createElement('span');
      amt.className = tx.dir === 'in' ? 'tx-amt in' : 'tx-amt';
      if (typeof tx.amount === 'number') {
        const sign = tx.dir === 'in' ? '+' : '−';
        amt.textContent = `${sign}${tx.amount} ${unitLabel()}`;
      }
      // A Cashu `hash` is a bearer token (no block explorer) — omit the tx link.
      row.append(label, time, amt);
      if (!isCashu()) {
        row.append(txLink(tx.hash));
      }
      return row;
    })
  );
}

// --- modal open/close -------------------------------------------------------
function open() {
  refreshWallet(); // grab a fresh balance each time it's opened
  // Chain wallet: pull on-chain history + the BIP-44 account picker. Cashu has neither (the mint
  // picker is rendered from the wallet msg; history is the app's own recorded events).
  if (!isCashu()) {
    fetchTransactions();
    listAccounts();
  }
  viewEl.classList.add('show');
}
function close() {
  viewEl.classList.remove('show');
  hideTopup(); // don't leave a stale invoice QR / spinner on reopen
}
openBtn.onclick = open;
closeBtn.onclick = close;
viewEl.onclick = (evt) => {
  if (evt.target === viewEl) {
    close(); // click the backdrop to dismiss
  }
};
document.addEventListener('keydown', (evt) => {
  if (evt.key === 'Escape' && viewEl.classList.contains('show')) {
    close();
  }
});

// --- wallet actions ---------------------------------------------------------
// Both the short address and the "full history" link open the address's on-chain history.
// Chain wallets open the address on a block explorer; a Cashu identity pubkey has no explorer.
addressEl.onclick = () => {
  if (!isCashu()) {
    openAddress(walletAddress);
  }
};
explorerEl.onclick = () => {
  if (!isCashu()) {
    openAddress(walletAddress);
  }
};

copyBtn.onclick = async () => {
  if (!walletAddress) {
    return;
  }
  await window.bridge.copyText(walletAddress);
  copyBtn.innerText = '✓ Copied';
  setTimeout(() => (copyBtn.innerText = '📋 Copy'), 1500);
};

// Re-fetch the balance now (the auto-poll is every 15s) — handy right after funding. The chip
// updates when the fresh `wallet` message lands; the spin is click feedback.
refreshBtn.onclick = () => {
  refreshWallet();
  if (!isCashu()) {
    fetchTransactions(); // also re-pull the on-chain history (chain wallets only)
  }
  refreshBtn.classList.remove('spin');
  void refreshBtn.offsetWidth; // restart the animation if clicked again mid-spin
  refreshBtn.classList.add('spin');
};

// Cashu: "Top up" mints sats at the active mint (testnut auto-pays; a real mint returns an invoice,
// surfaced by fundResult). Chain wallet: open the Nile faucet to receive test TRX.
faucetBtn.onclick = () => {
  if (isCashu()) {
    faucetBtn.disabled = true;
    faucetBtn.textContent = '⏳ minting…';
    // Show the panel with a spinner immediately — a real mint can take several seconds to return
    // the invoice (the worker polls the quote), so give feedback rather than a frozen button.
    topupInvoice = '';
    topupQrEl.removeAttribute('src');
    topupHintEl.textContent = 'Requesting a Lightning invoice…';
    topupEl.classList.add('show', 'loading');
    fundWallet(TOPUP_SATS);
    return;
  }
  window.bridge.openExternal(NILE_FAUCET_URL);
};

// Worker reply to a top-up (fund-wallet). testnut auto-pays → minted>0 and the balance rises; a
// real LN mint returns an `invoice` to pay externally.
export function fundResult({ minted, invoice, amount, error }) {
  faucetBtn.disabled = false;
  faucetBtn.textContent = '⬆ Top up';
  if (error) {
    hideTopup();
    balanceEl.title = `top-up failed: ${error}`;
    return;
  }
  if (minted > 0) {
    hideTopup(); // auto-paid (test mint) — no invoice to show; the balance just rose
    refreshWallet(); // balance rises — pull it now
    return;
  }
  if (invoice) {
    // Not auto-paid (a real LN mint): copy the bolt11, hand it to the OS's Lightning handler, AND
    // show a QR so a wallet on ANOTHER device (a phone) can scan it. (prompt()/alert() are blocked
    // in the sandboxed renderer — never use them.)
    window.bridge.copyText(invoice);
    window.bridge.openExternal('lightning:' + invoice);
    faucetBtn.textContent = `📋 invoice copied — add ${amount} sat`;
    setTimeout(() => (faucetBtn.textContent = '⬆ Top up'), 6000);
    showTopupQr(invoice);
  }
}

// Render the invoice as a scannable QR in the modal. Fails soft — if the QR bundle isn't available
// the invoice was still copied + handed to the OS handler above.
async function showTopupQr(invoice) {
  const dataUrl = await qrDataUrl(invoice);
  if (!dataUrl) {
    hideTopup(); // no QR renderer — the invoice was still copied + handed to the OS handler
    return;
  }
  topupInvoice = invoice;
  topupQrEl.src = dataUrl;
  topupHintEl.textContent =
    'Scan with a Lightning wallet (also copied to your clipboard).';
  topupEl.classList.remove('loading'); // spinner → QR
  topupEl.classList.add('show');
}

// Hide + reset the top-up panel (its QR, invoice, and loading state).
function hideTopup() {
  topupEl.classList.remove('show', 'loading');
  topupQrEl.removeAttribute('src');
  topupInvoice = '';
}

// Click the QR to copy the invoice to the clipboard again (handy if the initial copy was lost).
topupQrEl.onclick = () => {
  if (!topupInvoice) {
    return;
  }
  window.bridge.copyText(topupInvoice);
  const previous = topupHintEl.textContent;
  topupHintEl.textContent = '📋 invoice copied to clipboard';
  setTimeout(() => (topupHintEl.textContent = previous), 2000);
};

topupCloseBtn.onclick = hideTopup;

// --- send TRX ---------------------------------------------------------------
// A plain transfer to any address — mainly to fund another peer's wallet (replacing the
// wave.run.js CLI dance). The worker does the real send + a balance check; here we only do
// cheap input validation and drive the button/status.
function setSendStatus(text, cls) {
  sendStatusEl.textContent = text || '';
  sendStatusEl.className = cls || '';
}

sendToggleBtn.onclick = () => {
  const showing = sendEl.classList.toggle('show');
  sendToggleBtn.textContent = showing ? 'Send ▾' : 'Send ▸';
  if (showing) {
    sendToInput.focus();
  }
};

function submitSend() {
  const to = sendToInput.value.trim();
  const amount = Number(sendAmountInput.value);
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(to)) {
    setSendStatus('Enter a valid Tron address (T…)', 'err');
    return;
  }
  if (!(amount > 0)) {
    setSendStatus('Enter an amount greater than 0', 'err');
    return;
  }
  sendBtn.disabled = true;
  setSendStatus(`Sending ${amount} TRX…`, '');
  sendTrx(to, amount);
}
sendBtn.onclick = submitSend;
sendAmountInput.onkeydown = (evt) => {
  if (evt.key === 'Enter') {
    submitSend();
  }
};

// Worker reply to a send: success → record it + reset the form; error → surface it.
export function sendResult({ hash, to, amount, error }) {
  sendBtn.disabled = false;
  if (error) {
    setSendStatus(`⚠️ send failed: ${error}`, 'err');
    return;
  }
  record({ kind: 'send', hash, amount });
  setSendStatus(
    `✅ sent ${amount} TRX to ${to.slice(0, 6)}…${to.slice(-4)}`,
    'ok'
  );
  sendToInput.value = '';
  sendAmountInput.value = '';
}
