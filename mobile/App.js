// HyperWave mobile UI — still a SCAFFOLD (the rich RN UI, camera capture, and wallet screen are
// implement-mobile-app.md Phases 3–5), but now driving the SAME host surface the desktop uses:
// concurrent waves (browse-then-pick), a Cashu wallet in sats, and a moment gallery per wave.
// Bitcoin-orange palette, matching renderer/index.html.
import {
  SafeAreaView,
  ScrollView,
  View,
  Text,
  Pressable,
  Image,
  StatusBar,
  StyleSheet
} from 'react-native';
import { useEngine } from './src/useEngine';

// Isolate this build's directory topic so test devices don't collide with the demo ring on the
// public DHT. The host derives the mainnet directory from it (`<base>:mainnet`).
const TOPIC = 'hyperwave-mobile-demo';
// A tip is a fixed 5 sats, as on desktop.
const TIP_SATS = 5;
// Interim fixed top-up amount until the wallet screen (Phase 5) takes a user-specified one.
const TOPUP_SATS = 64;

const PALETTE = {
  bg: '#0a0a0a',
  panel: '#171310',
  panelAlt: '#241606',
  orange: '#f7931a',
  orangeSoft: '#ffb04d',
  text: '#f5f5f5',
  muted: '#a99e92'
};

export default function App() {
  const engine = useEngine({ topicId: TOPIC });
  const { me, peers, waves, activeWaveId, activeWave, gallery, wallet, toast } =
    engine;

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle='light-content' />
      <View style={styles.header}>
        <Text style={styles.title}>⚡ HyperWave</Text>
        <Text style={styles.chip}>
          {wallet
            ? `${wallet.amount} ${wallet.unit} · ${wallet.network || '…'}`
            : '…'}
        </Text>
      </View>

      <View style={styles.status}>
        <Text style={styles.mono}>
          me{' '}
          {me
            ? `${me.id.slice(0, 8)} @ ${me.angle?.toFixed(1)}° ${me.country || ''}`
            : '…'}
        </Text>
        <Text style={styles.mono}>
          peers {peers.length} · waves {waves.length}
        </Text>
      </View>

      <View style={styles.actions}>
        <Button label='Start a wave' onPress={engine.startWave} />
        <Button
          label={activeWave?.joined ? 'Joined' : 'Join'}
          disabled={!activeWave || activeWave.joined}
          onPress={() => engine.joinWave()}
        />
        {/* Placeholder for the wallet screen (Phase 5): a fixed-amount top up, enough to pay a
            participation fee. The real screen takes a user-specified amount, shows the invoice QR,
            and offers cash out. On the default test mint the invoice auto-pays. */}
        <Button
          label={`Top up ${TOPUP_SATS}`}
          onPress={() => engine.fundWallet(TOPUP_SATS)}
        />
      </View>

      {toast ? <Text style={styles.toast}>{toast}</Text> : null}

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.section}>Waves ({waves.length})</Text>
        {waves.length === 0 ? (
          <Text style={styles.muted}>
            No waves announced yet — start one, or wait for a peer.
          </Text>
        ) : null}
        {waves.map((wave) => (
          <Pressable
            key={wave.waveId}
            onPress={() => engine.selectWave(wave.waveId)}
            style={[
              styles.waveRow,
              wave.waveId === activeWaveId && styles.waveRowActive
            ]}
          >
            <Text style={styles.waveTitle}>
              {wave.mine ? 'my wave' : `by ${(wave.by || '?').slice(0, 8)}`}
            </Text>
            <Text style={styles.mono}>
              {wave.phase} · {wave.count || 1} peers
              {wave.fee ? ` · ${wave.fee} sat` : ' · free'}
              {wave.paid ? ` · ${wave.paid}` : ''}
            </Text>
          </Pressable>
        ))}

        <Text style={styles.section}>Moments ({gallery.length})</Text>
        {gallery.map((moment) => (
          <View key={moment.peerId || moment.hop} style={styles.card}>
            {moment.image ? (
              <Image source={{ uri: moment.image }} style={styles.thumb} />
            ) : null}
            <Text style={styles.caption}>
              {moment.country ? `${moment.country} ` : ''}
              {moment.caption || moment.peerId?.slice(0, 8) || 'moment'}
            </Text>
            {moment.address ? (
              <Pressable onPress={() => engine.tip(moment.address, TIP_SATS)}>
                <Text style={styles.tip}>⚡ Tip {TIP_SATS} sat</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function Button({ label, onPress, disabled }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.btn, disabled && styles.btnDisabled]}
    >
      <Text style={[styles.btnText, disabled && styles.btnTextDisabled]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: PALETTE.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: PALETTE.panelAlt
  },
  title: { color: PALETTE.text, fontSize: 22, fontWeight: '700' },
  chip: { color: PALETTE.orange, fontSize: 13 },
  status: { paddingHorizontal: 16, paddingTop: 12, gap: 4 },
  mono: { color: PALETTE.muted, fontFamily: 'Courier', fontSize: 12 },
  muted: { color: PALETTE.muted, paddingHorizontal: 16, fontSize: 13 },
  actions: { flexDirection: 'row', gap: 12, padding: 16 },
  btn: {
    backgroundColor: PALETTE.orange,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10
  },
  btnDisabled: { backgroundColor: PALETTE.panel },
  btnText: { color: '#1a1204', fontWeight: '700' },
  btnTextDisabled: { color: PALETTE.muted },
  toast: { color: PALETTE.orangeSoft, paddingHorizontal: 16, paddingBottom: 8 },
  body: { paddingBottom: 32 },
  section: {
    color: PALETTE.text,
    fontSize: 16,
    fontWeight: '600',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6
  },
  waveRow: {
    marginHorizontal: 16,
    marginVertical: 4,
    padding: 12,
    borderRadius: 10,
    backgroundColor: PALETTE.panel,
    borderWidth: 1,
    borderColor: 'transparent'
  },
  waveRowActive: { borderColor: PALETTE.orange },
  waveTitle: { color: PALETTE.text, fontWeight: '600', marginBottom: 2 },
  card: {
    marginHorizontal: 16,
    marginVertical: 6,
    backgroundColor: PALETTE.panel,
    borderRadius: 12,
    padding: 12,
    alignItems: 'center'
  },
  thumb: { width: 180, height: 180, borderRadius: 8, marginBottom: 8 },
  caption: { color: PALETTE.text },
  tip: { color: PALETTE.orange, marginTop: 6, fontWeight: '600' }
});
