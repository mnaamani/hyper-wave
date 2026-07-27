// HyperWave mobile — the wave screen. Composition only: every rule behind it lives in the shared
// app core (hyperwave-app-core), which src/useEngine.js drives over the worklet.
//
// Layout, top to bottom: the wallet/brand header, the status + narration line, the wave directory
// strip (tap a wave to subscribe + open it), the ring with the sweep spark and the featured moment
// in its centre, the lobby (while the open wave is forming), and the moment list.
//
// Still to come (implement-mobile-app.md): camera capture (Phase 4) and the wallet screen
// (Phase 5) — the top-up button here is an interim stand-in for the latter.
import { useEffect, useState } from 'react';
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
import { flagOf, unitLabelFor } from 'hyperwave-app-core';
import { useEngine } from './src/useEngine';
import { readCountry, writeCountry } from './src/custody';
import { Ring } from './src/components/Ring';
import { WaveList } from './src/components/WaveList';
import { Lobby } from './src/components/Lobby';
import { StatusLine } from './src/components/StatusLine';
import { CountryPicker } from './src/components/CountryPicker';
import { PALETTE } from './src/theme';

// Isolate this build's directory topic so test devices don't collide with the demo ring on the
// public DHT. The host derives the mainnet directory from it (`<base>:mainnet`).
const TOPIC = 'hyperwave-mobile-demo';
// A tip is a fixed 5 sats, as on desktop (enough to survive the mint's ~1-sat swap fee).
const TIP_SATS = 5;
// Interim fixed top-up amount until the wallet screen (Phase 5) takes a user-specified one.
const TOPUP_SATS = 64;

export default function App() {
  const engine = useEngine({ topicId: TOPIC });
  const {
    me,
    peers,
    waves,
    activeWaveId,
    activeWave,
    gallery,
    wallet,
    toast,
    lastEvent
  } = engine;
  const [country, setCountry] = useState(() => readCountry());

  // The country is the engine's cosmetic peer `tag`; push it once the engine is up (and whenever
  // the user picks a new one), so this peer's seat and moments carry its flag.
  useEffect(() => {
    if (country && engine.ready) {
      engine.setCountry(country);
    }
  }, [country, engine.ready]);

  // Ring triggers, straight off the protocol: the spark sweeps while the open wave races, and the
  // ring pulses when it completes. Both are STICKY ids (they must survive the events that follow,
  // e.g. `position`), reset when the open wave changes or a new wave forms.
  const [sweepId, setSweepId] = useState(null);
  const [flourishId, setFlourishId] = useState(null);

  useEffect(() => {
    setSweepId(null);
    setFlourishId(null);
  }, [activeWaveId]);

  useEffect(() => {
    if (!lastEvent || lastEvent.waveId !== activeWaveId) {
      return;
    }
    if (lastEvent.event === 'wave-active') {
      setSweepId(String(lastEvent.at));
    } else if (lastEvent.event === 'completed') {
      setFlourishId(String(lastEvent.at));
    } else if (lastEvent.event === 'wave-announce') {
      setSweepId(null);
      setFlourishId(null);
    }
  }, [lastEvent, activeWaveId]);

  // The moment the ring features: the newest one that has arrived (hop-ordered feed), so the
  // centre fills as the wave syncs in.
  const featured = gallery.length > 0 ? gallery[gallery.length - 1] : null;
  const unit = unitLabelFor(wallet?.unit || 'sat');
  const inLobby = activeWave && activeWave.phase === 'lobby';

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle='light-content' />
      <CountryPicker
        visible={!country}
        onPick={(code) => {
          writeCountry(code);
          setCountry(code);
        }}
      />

      <View style={styles.header}>
        <Text style={styles.title}>
          ⚡ HyperWave {country ? flagOf(country) : ''}
        </Text>
        <Text style={styles.chip}>
          {wallet
            ? `${wallet.amount ?? 0} ${unit} · ${wallet.network || '…'}`
            : '…'}
        </Text>
      </View>

      <StatusLine
        peers={peers.length}
        waves={waves.length}
        me={me}
        toast={toast}
      />

      <WaveList
        waves={waves}
        activeWaveId={activeWaveId}
        countryOf={(id) =>
          (me && me.id === id
            ? me.country
            : peers.find((peer) => peer.id === id)?.country) || ''
        }
        matchesNetwork={engine.waveMatchesNetwork}
        onSelect={engine.selectWave}
      />

      <Ring
        me={me}
        peers={peers}
        sweepId={sweepId}
        flourishId={flourishId}
        featured={featured}
        centerText={
          activeWave
            ? `${activeWave.phase} · ${activeWave.count || 1} peer${
                (activeWave.count || 1) === 1 ? '' : 's'
              }`
            : 'Start a wave, or tap one above'
        }
      />

      {inLobby ? (
        <Lobby wave={activeWave} unit={unit} onJoin={() => engine.joinWave()} />
      ) : null}

      <View style={styles.actions}>
        <Button label='Start a wave' onPress={engine.startWave} />
        <Button
          label={`Top up ${TOPUP_SATS}`}
          onPress={() => engine.fundWallet(TOPUP_SATS)}
        />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.section}>Moments ({gallery.length})</Text>
        {gallery.map((moment) => (
          <View key={moment.peerId || moment.hopCount} style={styles.card}>
            {moment.image ? (
              <Image source={{ uri: moment.image }} style={styles.thumb} />
            ) : null}
            <Text style={styles.caption}>
              {flagOf(moment.country)}{' '}
              {moment.caption || moment.peerId?.slice(0, 8) || 'moment'}
            </Text>
            {moment.address && moment.address !== wallet?.address ? (
              <Pressable
                onPress={() =>
                  engine.tip({
                    waveId: moment.waveId,
                    peerId: moment.peerId,
                    address: moment.address,
                    amount: TIP_SATS
                  })
                }
              >
                <Text style={styles.tip}>
                  ⚡ Tip {TIP_SATS}{' '}
                  {unitLabelFor(wallet?.unit || 'sat', TIP_SATS)}
                </Text>
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
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: PALETTE.bgGlow
  },
  title: { color: PALETTE.text, fontSize: 20, fontWeight: '700' },
  chip: { color: PALETTE.orange, fontSize: 13 },
  actions: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 10
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
  body: { paddingBottom: 32 },
  section: {
    color: PALETTE.text,
    fontSize: 16,
    fontWeight: '600',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6
  },
  card: {
    marginHorizontal: 16,
    marginVertical: 6,
    backgroundColor: PALETTE.panel,
    borderRadius: 12,
    padding: 12,
    alignItems: 'center'
  },
  thumb: { width: 160, height: 160, borderRadius: 8, marginBottom: 8 },
  caption: { color: PALETTE.text },
  tip: { color: PALETTE.orange, marginTop: 6, fontWeight: '600' }
});
