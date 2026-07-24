// Wallet view: the self-custodial Cashu (ecash) wallet modal, opened from the top-right ₿. Shows the
// balance, a mint picker, a "Top up" (mint funds), and the persisted proof-store ledger (survives
// restarts — shows PAST sessions too). Cashu is the desktop's only payment mechanism; there is no
// chain address, block explorer, or on-chain send here. Extracted from hud.js.
import {
  refreshWallet,
  fetchTransactions,
  setMint,
  fundWallet,
  cashOut
} from './ipc.js';
import { unitLabel, activeMint, activeNetwork } from './wallet-meta.js';
import { qrDataUrl } from './qr.js';

// The curated Cashu mints for the picker are RELAYED from the worker on the `wallet` message
// (`mints`, adopted in walletStatus below). That list is the SINGLE SOURCE OF TRUTH — the worker's
// wallet reports the same `{url,label,network}` list it classifies against for the cross-network
// filter (packages/hyperwave-wallet-cashu/lib/mint-networks.js) — so a mint's picker label and the
// filter's testnet/mainnet classification can never drift, and an app-added mint appears in both
// with no duplicated list here. Until the first `wallet` message arrives, this fallback (the default
// test mint) keeps the picker non-empty.
let cashuMints = [
  {
    url: 'https://testnut.cashu.space',
    label: 'testnut (test · auto-pay)',
    network: 'testnet'
  }
];
// How many sats a "Top up" mints at once (testnut auto-pays; a real mint returns an invoice).
const TOPUP_SATS = 100;

const viewEl = document.getElementById('wallet-view');
const openBtn = document.getElementById('wallet-btn');
const closeBtn = document.getElementById('wallet-close');
const balanceEl = document.getElementById('wallet-balance');
const balChipEl = document.getElementById('wallet-bal'); // top-bar balance pill
const kindEl = document.getElementById('wallet-kind');
const refreshBtn = document.getElementById('wallet-refresh');
const topupBtn = document.getElementById('wallet-topup-btn');
const txsEl = document.getElementById('wallet-txs');
const mintSelect = document.getElementById('wallet-mint');
const topupEl = document.getElementById('wallet-topup');
const topupQrEl = document.getElementById('topup-qr');
const topupTitleEl = document.getElementById('topup-title');
const topupHintEl = document.getElementById('topup-hint');
const topupCloseBtn = document.getElementById('topup-close');
const cashoutToggleBtn = document.getElementById('wallet-cashout-toggle');
const cashoutEl = document.getElementById('wallet-cashout');
const cashoutInput = document.getElementById('cashout-invoice');
const cashoutBtn = document.getElementById('cashout-btn');
const cashoutStatusEl = document.getElementById('cashout-status');
const cashoutHintEl = document.getElementById('cashout-hint');

// Icon + label + direction per Cashu ledger `kind` (the persisted proof-store
// history — survives restarts, so it shows PAST sessions, not just this one).
const CASHU_META = {
  mint: { icon: '⬆', label: 'Topped up', dir: 'in' },
  receive: { icon: '📥', label: 'Received a tip', dir: 'in' },
  send: { icon: '⚡', label: 'Tipped a moment', dir: 'out' },
  burn: { icon: '🔥', label: 'Burned participation fee', dir: 'out' },
  consolidate: { icon: '🔄', label: 'Consolidated', dir: 'neutral' },
  cashout: { icon: '🏧', label: 'Cashed out to Lightning', dir: 'out' }
};

let topupInvoice = ''; // the bolt11 currently shown as a QR (click the QR to re-copy it)
let currentBalance = 0; // latest spendable balance (sat), for the cash-out affordability hint

// Worker `wallet` message (balance + active mint): keep the modal live whether open or not.
export function walletStatus({ address, amount, unit, mint, mints }) {
  if (!address) {
    return;
  }
  // Adopt the worker-relayed mint list as the picker's source of truth.
  if (Array.isArray(mints) && mints.length) {
    cashuMints = mints;
  }
  currentBalance = Number(amount) || 0;
  balanceEl.innerText =
    `${amount} ${unit}` + (amount === 0 ? '  ⚠ unfunded' : '');
  refreshCashoutHint(); // balance moved — re-evaluate the pasted invoice's affordability
  balChipEl.textContent = `${amount} ${unitLabel(amount)}`; // top-bar pill
  const currentMint = mint || activeMint();
  kindEl.textContent = mintHost(currentMint);
  topupBtn.title = `Mint ${TOPUP_SATS} sat at the selected mint`;
  renderMintPicker(currentMint);
  // A balance push follows every money op — re-pull the persisted ledger so a
  // just-made top-up/tip/burn shows without a manual refresh (local, no network).
  if (viewEl.classList.contains('show')) {
    fetchTransactions();
  }
}

// Host of a mint URL (e.g. "testnut.cashu.space"), or '' if it isn't a URL.
function mintHost(mintUrl) {
  if (!mintUrl) {
    return '';
  }
  try {
    return new URL(mintUrl).host;
  } catch {
    return mintUrl;
  }
}

// Render the curated mints into the picker, marking the active one. Includes the active mint even if
// it's a custom one not in the list, so the selection always reflects reality.
function renderMintPicker(currentMint) {
  const known = cashuMints.slice();
  if (currentMint && !known.some((mint) => mint.url === currentMint)) {
    known.unshift({ url: currentMint, label: currentMint });
  }
  mintSelect.replaceChildren(
    ...known.map((mint) => {
      const option = document.createElement('option');
      option.value = mint.url;
      option.textContent = mint.label;
      option.selected = mint.url === currentMint;
      return option;
    })
  );
}

// Switch the active mint (live re-wire). The worker replies with a fresh `wallet` message.
mintSelect.onchange = () => {
  if (mintSelect.value) {
    setMint(mintSelect.value);
  }
};

// Worker `transactions` message: the persisted proof-store ledger (all sessions), already
// newest-first — render it directly (no hash to key/merge, no block explorer).
export function setTransactions(list) {
  const rows = (list || []).slice(0, 10);
  txsEl.replaceChildren(
    ...rows.map((entry) => {
      const meta = CASHU_META[entry.kind] || {
        icon: '•',
        label: entry.kind,
        dir: 'out'
      };
      const row = document.createElement('div');
      row.className = 'tx-row';
      const label = document.createElement('span');
      label.className = 'tx-label';
      label.textContent = `${meta.icon} ${meta.label}`;
      const time = document.createElement('span');
      time.className = 'tx-time';
      time.textContent = ago(entry.timestamp); // blank when the store has no ts
      const amt = document.createElement('span');
      amt.className = meta.dir === 'in' ? 'tx-amt in' : 'tx-amt';
      if (typeof entry.amount === 'number') {
        const sign = { in: '+', out: '−' }[meta.dir] || ''; // neutral → no sign
        amt.textContent = `${sign}${entry.amount} ${unitLabel()}`;
      }
      row.append(label, time, amt);
      return row;
    })
  );
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

// --- modal open/close -------------------------------------------------------
function open() {
  refreshWallet(); // grab a fresh balance each time it's opened
  fetchTransactions(); // the persisted proof-store ledger (past sessions too)
  viewEl.classList.add('show');
}
function close() {
  viewEl.classList.remove('show');
  hideTopup(); // don't leave a stale invoice QR / spinner on reopen
  cashoutEl.classList.remove('show'); // collapse the cash-out form too
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
// Re-fetch the balance now (the auto-poll is every 15s) — handy right after funding. The chip
// updates when the fresh `wallet` message lands; the spin is click feedback.
refreshBtn.onclick = () => {
  refreshWallet();
  fetchTransactions(); // re-pull the local ledger too
  refreshBtn.classList.remove('spin');
  void refreshBtn.offsetWidth; // restart the animation if clicked again mid-spin
  refreshBtn.classList.add('spin');
};

// An auto-paying test mint (testnut, on testnet) settles its own Lightning quote — there's no
// invoice for the user to pay. Only a real (mainnet) mint returns a payable invoice; an unknown /
// custom mint might too, so we only skip the invoice UI for a KNOWN testnet mint.
function topupAutoPays() {
  return activeNetwork() === 'testnet';
}

// "Top up" mints sats at the active mint (testnut auto-pays; a real mint returns an invoice,
// surfaced by fundResult).
topupBtn.onclick = () => {
  topupBtn.disabled = true;
  topupBtn.textContent = '⏳ minting…';
  // A real mint can take several seconds to return the invoice (the worker polls the quote), so
  // show the panel with a spinner immediately for feedback. A testnut auto-pays with no invoice
  // to display, so skip the panel entirely — the balance just rises a moment later.
  if (!topupAutoPays()) {
    topupInvoice = '';
    topupQrEl.removeAttribute('src');
    topupTitleEl.textContent = '⚡ Top-up invoice — scan or pay';
    topupHintEl.textContent = 'Requesting a Lightning invoice…';
    topupEl.classList.add('show', 'loading');
  }
  fundWallet(TOPUP_SATS);
};

// Worker replies to a top-up (fund-wallet), in two phases:
//   1. `pending` (immediate): the invoice is ready — show the QR NOW (don't wait for payment).
//   2. final: `minted > 0` once paid+minted (balance rises), or minted:0 if the poll gave up, or
//      an `error`. testnut auto-pays so phase 2 lands ~1-2s after phase 1; a real mint waits for
//      you to scan + pay.
export function fundResult({ minted, invoice, error, pending }) {
  if (pending) {
    // A testnut auto-pays its own quote — there's no invoice for the user to act on, so ignore this
    // phase entirely and keep the "⏳ minting…" state until the final (minted) phase raises the
    // balance a moment later.
    if (topupAutoPays()) {
      return;
    }
    // A real mint's invoice exists — surface it immediately (copy + OS handler + QR). The background
    // poll keeps running; the button is free again (the invoice is now displayed).
    topupBtn.disabled = false;
    topupBtn.textContent = '⬆ Top up';
    if (invoice) {
      window.bridge.copyText(invoice);
      window.bridge.openExternal('lightning:' + invoice);
      showTopupQr(invoice);
    }
    return;
  }
  // Final result.
  topupBtn.disabled = false;
  topupBtn.textContent = '⬆ Top up';
  if (error) {
    // Surface it IN the panel (not just a hidden tooltip) — a mint outage (e.g. a
    // 502 from the mint) otherwise just made the QR silently vanish, which reads
    // like an app bug rather than the mint being down.
    balanceEl.title = `top-up failed: ${error}`;
    showTopupError(`⚠ Top-up failed — ${error}`);
    return;
  }
  if (minted > 0) {
    hideTopup(); // paid + minted — the balance just rose
    refreshWallet();
    return;
  }
  // Poll gave up (unpaid within the window) — the invoice was copyable meanwhile.
  showTopupError('Top-up timed out — the invoice was not paid in time.');
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
  const amount = invoiceAmountSats(invoice);
  topupTitleEl.textContent =
    amount === null
      ? '⚡ Top-up invoice — scan or pay'
      : `⚡ Top-up invoice — ${amount} ${unitLabel(amount)}`;
  topupHintEl.textContent =
    'Scan with a Lightning wallet (also copied to your clipboard).';
  topupEl.classList.remove('loading'); // spinner → QR
  topupEl.classList.add('show');
}

// Turn the top-up panel into a terminal error state: drop the spinner + QR but
// keep the panel open (with its Done button) so the failure is visible and
// dismissable, instead of the panel silently disappearing.
function showTopupError(message) {
  topupEl.classList.remove('loading');
  topupEl.classList.add('show');
  topupQrEl.removeAttribute('src');
  topupTitleEl.textContent = '⚡ Top up';
  topupHintEl.textContent = message;
  topupInvoice = '';
}

// Hide + reset the top-up panel (its QR, invoice, and loading state).
function hideTopup() {
  topupEl.classList.remove('show', 'loading');
  topupQrEl.removeAttribute('src');
  topupTitleEl.textContent = '⚡ Top-up invoice — scan or pay';
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

// --- cash out ---------------------------------------------------------------
// Melt ecash to pay a bolt11 invoice from the user's OWN external Lightning/BTC wallet, redeeming
// the balance back to Lightning. The mint pays the invoice; only a real (mainnet) mint has the
// Lightning connectivity to settle one — a testnut auto-pay mint can't, so we refuse up front.
function setCashoutStatus(text, cls) {
  cashoutStatusEl.textContent = text || '';
  cashoutStatusEl.className = cls || '';
}

// Decode the sat amount a bolt11 invoice demands, WITHOUT a library. bolt11 puts
// the amount in its human-readable part as <digits><multiplier> right after the
// network prefix (bc/tb/bcrt); the multiplier m/u/n/p = 1e-3/1e-6/1e-9/1e-12 BTC
// and 1 BTC = 1e8 sat. Returns the sat amount, or null for an amountless invoice
// (no amount encoded) or a string we don't recognize as bolt11.
const MULTIPLIER_SATS = { m: 1e5, u: 1e2, n: 1e-1, p: 1e-4 };
function invoiceAmountSats(invoice) {
  const match = /^ln(?:bcrt|bc|tbs|tb|sb)(\d+)([munp])?/i.exec(invoice);
  if (!match || !match[1]) {
    return null; // amountless, or not a bolt11 we can read
  }
  const value = Number(match[1]);
  const multiplier = match[2] ? match[2].toLowerCase() : '';
  const sats = multiplier ? value * MULTIPLIER_SATS[multiplier] : value * 1e8;
  return Math.round(sats);
}

// Live affordability hint: show what the pasted invoice will cost vs. the balance
// and disable "Pay invoice" when it can't be covered — catching the mismatch
// before a round-trip to the mint. Re-run on paste/type and on any balance push.
function refreshCashoutHint() {
  const invoice = cashoutInput.value.trim();
  if (!invoice) {
    cashoutHintEl.textContent = '';
    cashoutHintEl.className = '';
    cashoutBtn.disabled = false;
    return;
  }
  const needed = invoiceAmountSats(invoice);
  if (needed === null) {
    cashoutHintEl.textContent =
      'Amountless invoice — paste one with an amount set.';
    cashoutHintEl.className = 'err';
    cashoutBtn.disabled = true;
    return;
  }
  const short = needed > currentBalance;
  cashoutHintEl.textContent =
    `Invoice: ${needed} ${unitLabel(needed)} · ` +
    `balance: ${currentBalance} ${unitLabel(currentBalance)}` +
    (short ? ' — not enough (plus a fee reserve)' : '');
  cashoutHintEl.className = short ? 'err' : '';
  cashoutBtn.disabled = short;
}

cashoutToggleBtn.onclick = () => {
  const showing = cashoutEl.classList.toggle('show');
  if (showing) {
    cashoutInput.focus();
  }
};

cashoutInput.oninput = () => {
  setCashoutStatus(''); // a new invoice invalidates the prior attempt's result
  refreshCashoutHint();
};

function submitCashout() {
  const invoice = cashoutInput.value.trim();
  if (!/^ln[a-z0-9]+$/i.test(invoice)) {
    setCashoutStatus('Enter a Lightning invoice (lnbc…)', 'err');
    return;
  }
  if (topupAutoPays()) {
    setCashoutStatus(
      'Cash out needs a real (mainnet) mint — a test mint has no Lightning.',
      'err'
    );
    return;
  }
  const needed = invoiceAmountSats(invoice);
  if (needed !== null && needed > currentBalance) {
    setCashoutStatus(
      `Invoice needs ${needed} ${unitLabel(needed)}, ` +
        `balance is ${currentBalance} ${unitLabel(currentBalance)}.`,
      'err'
    );
    return;
  }
  cashoutBtn.disabled = true;
  setCashoutStatus('⚡ cashing out…', '');
  cashOut(invoice);
}
cashoutBtn.onclick = submitCashout;
cashoutInput.onkeydown = (evt) => {
  if (evt.key === 'Enter') {
    submitCashout();
  }
};

// Worker reply to a cash-out: success → clear the form + refresh; error → surface it.
export function cashOutResult({ paid, fee, error }) {
  cashoutBtn.disabled = false;
  if (error) {
    setCashoutStatus(`⚠️ cash-out failed: ${error}`, 'err');
    return;
  }
  const feeNote = fee > 0 ? ` (fee ${fee} ${unitLabel(fee)})` : '';
  setCashoutStatus(`✅ cashed out ${paid} ${unitLabel(paid)}${feeNote}`, 'ok');
  cashoutInput.value = '';
  refreshCashoutHint(); // clear the affordability hint now the field is empty
  refreshWallet();
  fetchTransactions();
}
