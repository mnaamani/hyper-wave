// The wallet screen — the mobile counterpart of renderer/lib/wallet.js. Self-custodial Cashu:
// balance, the mint picker, top up (a user-specified amount), cash out to a bolt11 invoice, and the
// persisted ledger. The engine owns every operation; this is presentation over `useEngine`.
//
// Two mobile-specific affordances the desktop can't have:
//   - a top-up invoice is shown as a QR to scan with another device's Lightning wallet;
//   - cash out can SCAN a bolt11 invoice with the camera instead of pasting it (a phone should).
//
// The ledger comes from the wallet's own persisted proof store, so it shows PAST sessions, not
// just this run.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  ScrollView,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { unitLabelFor } from 'hyperwave-app-core';
import { PALETTE } from '../theme';

// Same gate as desktop: a whole number of sats, 1..1,000,000. An invalid amount never reaches the
// mint (the button stays disabled).
const DEFAULT_TOPUP_SATS = 100;
const MAX_TOPUP_SATS = 1000000;

// Icon + label + direction per Cashu ledger `kind` — mirrors the desktop's CASHU_META so both
// hosts describe the same history the same way.
const LEDGER_META = {
  mint: { icon: '⬆', label: 'Topped up', dir: 'in' },
  receive: { icon: '📥', label: 'Received a tip', dir: 'in' },
  send: { icon: '⚡', label: 'Tipped a moment', dir: 'out' },
  burn: { icon: '🔥', label: 'Burned participation fee', dir: 'out' },
  consolidate: { icon: '🔄', label: 'Consolidated', dir: 'neutral' },
  cashout: { icon: '🏧', label: 'Cashed out to Lightning', dir: 'out' }
};

// "5m", "3h", "2d" — compact age; blank when the store has no timestamp.
function ago(timestamp) {
  if (!timestamp) {
    return '';
  }
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m`;
  }
  if (seconds < 86400) {
    return `${Math.round(seconds / 3600)}h`;
  }
  return `${Math.round(seconds / 86400)}d`;
}

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

// A whole, in-range sat amount, or null (which disables the button).
function parseAmount(text) {
  const amount = Number(String(text).trim());
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_TOPUP_SATS) {
    return null;
  }
  return amount;
}

/**
 * @param {Object} props - Props.
 * @param {boolean} props.visible - Whether the screen is open.
 * @param {() => void} props.onClose - Close handler.
 * @param {Object|null} props.wallet - The core's wallet metadata snapshot.
 * @param {{invoice?: string, minted?: number, error?: string, pending?: boolean}|null}
 *   props.fundResult - The latest fund-wallet result.
 * @param {{paid?: number, fee?: number, error?: string}|null} props.cashOutResult - Latest cash-out.
 * @param {Array<Object>} props.transactions - The persisted ledger, newest first.
 * @param {Object} props.actions - { fundWallet, cashOut, setMint, refreshWallet,
 *   fetchTransactions }.
 * @returns {JSX.Element} The wallet screen.
 */
export function Wallet({
  visible,
  onClose,
  wallet,
  fundResult,
  cashOutResult,
  transactions,
  actions
}) {
  const [amountText, setAmountText] = useState(String(DEFAULT_TOPUP_SATS));
  const [invoiceText, setInvoiceText] = useState('');
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  // The top-up QR is engine state (`fundResult`), which stays pending until the quote is paid or
  // the poll times out — so the user needs a way to put it away when they change their mind.
  // Suppression is sticky until they ask for a NEW top-up, which also covers a stale invoice
  // arriving from an in-flight quote after they've switched mints.
  const [invoiceHidden, setInvoiceHidden] = useState(false);
  const lastMintRef = useRef(wallet?.mint);

  const rawUnit = wallet?.unit || 'sat';
  // The generic label ('sats') for standing UI — the amount input's suffix. Every place that
  // prints an actual number inflects against THAT number instead, so 1 never reads "1 sats".
  const unit = unitLabelFor(rawUnit);
  const amount = useMemo(() => parseAmount(amountText), [amountText]);
  // A test mint auto-pays its own quote, so there is no invoice for the user to act on — the
  // balance simply rises. Same rule as the desktop's topupAutoPays().
  const autoPays = wallet?.network === 'testnet';
  const pendingInvoice =
    !autoPays && !invoiceHidden && fundResult?.pending && fundResult.invoice
      ? fundResult.invoice
      : '';

  // What "Top up" will do, in words: an invalid amount explains the gate, a test mint auto-pays its
  // own quote, and a real mint hands back an invoice to settle.
  const topupHint = useMemo(() => {
    if (amount === null) {
      return `Enter a whole amount between 1 and ${MAX_TOPUP_SATS} ${unit}`;
    }
    const amountLabel = `${amount} ${unitLabelFor(rawUnit, amount)}`;
    if (autoPays) {
      return `Mints ${amountLabel} at the test mint`;
    }
    return `Creates a Lightning invoice for ${amountLabel}`;
  }, [amount, autoPays, rawUnit]);

  // Switching mints closes the top-up QR. An invoice belongs to the mint that issued it: paying it
  // after a switch would credit the mint you just left, and the balance on screen is the new one's.
  // Guarded on a PREVIOUS mint existing, so first learning the wallet's mint doesn't count as a
  // switch (that would hide an invoice still pending from before the screen was reopened).
  useEffect(() => {
    const mint = wallet?.mint;
    if (lastMintRef.current && mint && mint !== lastMintRef.current) {
      setInvoiceHidden(true);
    }
    lastMintRef.current = mint;
  }, [wallet?.mint]);

  // Refresh the balance + ledger whenever the screen opens, so it never shows a stale session.
  useEffect(() => {
    if (visible) {
      actions.refreshWallet();
      actions.fetchTransactions();
    }
  }, [visible]);

  if (!visible) {
    return null;
  }

  return (
    <Modal visible animationType='slide'>
      <View style={styles.screen}>
        <View style={styles.header}>
          <Text style={styles.title}>Wallet</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.close}>Done</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.balance}>
            {wallet?.amount ?? 0} {unitLabelFor(rawUnit, wallet?.amount ?? 0)}
          </Text>
          <Text style={styles.sub}>
            {mintHost(wallet?.mint) || 'no mint'} · {wallet?.network || '…'}
            {(wallet?.amount ?? 0) === 0 ? ' · unfunded' : ''}
          </Text>

          {/* mint picker — switching re-wires the wallet live (set-wallet-options) */}
          <Text style={styles.section}>Mint</Text>
          {(wallet?.mints || []).map((mint) => (
            <Pressable
              key={mint.url}
              onPress={() => actions.setMint(mint.url)}
              style={[
                styles.row,
                mint.url === wallet?.mint && styles.rowActive
              ]}
            >
              <Text style={styles.rowText}>
                {mint.url === wallet?.mint ? '● ' : '○ '}
                {mint.label || mintHost(mint.url)}
              </Text>
              <Text style={styles.rowMeta}>{mint.network || ''}</Text>
            </Pressable>
          ))}

          {/* top up */}
          <Text style={styles.section}>Top up</Text>
          <View style={styles.inline}>
            <TextInput
              value={amountText}
              onChangeText={setAmountText}
              keyboardType='number-pad'
              placeholder={String(DEFAULT_TOPUP_SATS)}
              placeholderTextColor={PALETTE.dim}
              style={styles.amountInput}
            />
            <Text style={styles.unit}>{unit}</Text>
            <Pressable
              disabled={amount === null}
              onPress={() => {
                setInvoiceHidden(false); // asking for a new one un-hides the QR
                actions.fundWallet(amount);
              }}
              style={[styles.btn, amount === null && styles.btnDisabled]}
            >
              <Text
                style={[
                  styles.btnText,
                  amount === null && styles.btnTextDisabled
                ]}
              >
                Top up
              </Text>
            </Pressable>
          </View>
          <Text style={styles.hint}>{topupHint}</Text>
          {fundResult?.error ? (
            <Text style={styles.err}>⚠ top-up failed — {fundResult.error}</Text>
          ) : null}
          {pendingInvoice ? (
            <View style={styles.qrWrap}>
              <QRCode value={pendingInvoice} size={200} />
              <Text style={styles.qrHint} selectable>
                Scan with a Lightning wallet to pay. The balance rises once it
                settles.
              </Text>
              {/* Changed your mind? Put it away. This only hides it — the engine is still
                  watching the quote, so paying it later still credits you, until it expires. */}
              <Pressable
                onPress={() => setInvoiceHidden(true)}
                style={styles.qrDismiss}
                hitSlop={10}
              >
                <Text style={styles.qrDismissText}>✕ Hide this invoice</Text>
              </Pressable>
            </View>
          ) : null}

          {/* cash out */}
          <Text style={styles.section}>Cash out</Text>
          <TextInput
            value={invoiceText}
            onChangeText={setInvoiceText}
            placeholder='Paste a bolt11 invoice (lnbc…)'
            placeholderTextColor={PALETTE.dim}
            autoCapitalize='none'
            autoCorrect={false}
            multiline
            style={styles.invoiceInput}
          />
          <View style={styles.inline}>
            <Pressable
              style={styles.btn}
              disabled={!invoiceText.trim()}
              onPress={() => actions.cashOut(invoiceText.trim())}
            >
              <Text style={styles.btnText}>Pay invoice</Text>
            </Pressable>
            <Pressable
              style={styles.btnGhost}
              onPress={async () => {
                if (!permission?.granted) {
                  const next = await requestPermission();
                  if (!next?.granted) {
                    return;
                  }
                }
                setScanning(true);
              }}
            >
              <Text style={styles.btnGhostText}>Scan QR</Text>
            </Pressable>
          </View>
          <Text style={styles.hint}>
            Melts your ecash to pay the invoice — this is how sats leave the
            app.
          </Text>
          {cashOutResult?.error ? (
            <Text style={styles.err}>
              ⚠ cash-out failed — {cashOutResult.error}
            </Text>
          ) : null}
          {cashOutResult && !cashOutResult.error && cashOutResult.paid ? (
            <Text style={styles.ok}>
              ✅ cashed out {cashOutResult.paid}{' '}
              {unitLabelFor(rawUnit, cashOutResult.paid)}
              {cashOutResult.fee > 0 ? ` (fee ${cashOutResult.fee})` : ''}
            </Text>
          ) : null}

          {/* the persisted ledger — past sessions included */}
          <Text style={styles.section}>
            History ({(transactions || []).length})
          </Text>
          {(transactions || []).length === 0 ? (
            <Text style={styles.hint}>Nothing yet.</Text>
          ) : null}
          {(transactions || []).slice(0, 20).map((entry, index) => {
            const meta = LEDGER_META[entry.kind] || {
              icon: '•',
              label: entry.kind,
              dir: 'out'
            };
            const sign = { in: '+', out: '−' }[meta.dir] || '';
            return (
              <View
                key={`${entry.kind}-${entry.timestamp}-${index}`}
                style={styles.row}
              >
                <Text style={styles.rowText}>
                  {meta.icon} {meta.label}
                </Text>
                <Text style={styles.rowMeta}>
                  {ago(entry.timestamp)}
                  {typeof entry.amount === 'number'
                    ? `  ${sign}${entry.amount} ${unitLabelFor(rawUnit, entry.amount)}`
                    : ''}
                </Text>
              </View>
            );
          })}
        </ScrollView>

        {/* camera scanner for a bolt11 invoice */}
        <Modal visible={scanning} animationType='slide'>
          <View style={styles.scanScreen}>
            <CameraView
              style={StyleSheet.absoluteFill}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => {
                if (!data) {
                  return;
                }
                // Lightning QRs are often `lightning:lnbc…` (or uppercased bech32) — normalise.
                const raw = String(data).trim();
                const stripped = raw.replace(/^lightning:/i, '');
                setInvoiceText(stripped.toLowerCase());
                setScanning(false);
              }}
            />
            <Pressable
              style={styles.scanCancel}
              onPress={() => setScanning(false)}
            >
              <Text style={styles.btnText}>Cancel</Text>
            </Pressable>
          </View>
        </Modal>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: PALETTE.bg, paddingTop: 56 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8
  },
  title: { color: PALETTE.text, fontSize: 22, fontWeight: '700' },
  close: { color: PALETTE.orange, fontSize: 16, fontWeight: '600' },
  body: { padding: 16, paddingBottom: 48 },
  balance: { color: PALETTE.text, fontSize: 34, fontWeight: '700' },
  sub: { color: PALETTE.muted, fontSize: 13, marginTop: 2 },
  section: {
    color: PALETTE.text,
    fontSize: 15,
    fontWeight: '700',
    marginTop: 22,
    marginBottom: 6
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: PALETTE.panel,
    marginBottom: 6
  },
  rowActive: { borderWidth: 1, borderColor: PALETTE.orange },
  rowText: { color: PALETTE.text, fontSize: 14, flexShrink: 1 },
  rowMeta: { color: PALETTE.muted, fontSize: 12 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  amountInput: {
    flexGrow: 1,
    padding: 12,
    borderRadius: 10,
    backgroundColor: PALETTE.panel,
    color: PALETTE.text
  },
  unit: { color: PALETTE.muted },
  invoiceInput: {
    minHeight: 70,
    padding: 12,
    borderRadius: 10,
    backgroundColor: PALETTE.panel,
    color: PALETTE.text,
    marginBottom: 10
  },
  btn: {
    backgroundColor: PALETTE.orange,
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderRadius: 10
  },
  btnDisabled: { backgroundColor: PALETTE.panel },
  btnText: { color: '#1a1204', fontWeight: '700' },
  btnTextDisabled: { color: PALETTE.muted },
  btnGhost: {
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: PALETTE.panel
  },
  btnGhostText: { color: PALETTE.text, fontWeight: '600' },
  hint: { color: PALETTE.muted, fontSize: 12, marginTop: 8 },
  err: { color: PALETTE.warn, fontSize: 13, marginTop: 8 },
  ok: { color: PALETTE.good, fontSize: 13, marginTop: 8 },
  qrWrap: {
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 14,
    marginTop: 12
  },
  // on the white QR card, so it needs its own dark-on-light treatment
  qrDismiss: { marginTop: 10, paddingVertical: 4 },
  qrDismissText: { color: '#6b625a', fontSize: 13, fontWeight: '600' },
  qrHint: {
    color: '#333',
    fontSize: 12,
    marginTop: 10,
    textAlign: 'center'
  },
  scanScreen: { flex: 1, backgroundColor: '#000', justifyContent: 'flex-end' },
  scanCancel: {
    alignSelf: 'center',
    marginBottom: 48,
    backgroundColor: PALETTE.orange,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 10
  }
});
