// HyperWave mobile — the wave screen. Composition only: every rule behind it lives in the shared
// app core (hyperwave-app-core), which src/useEngine.js drives over the worklet.
//
// Layout, top to bottom: the wallet/brand header, the status + narration line, the wave directory
// strip (tap a wave to subscribe + open it), the ring with the sweep spark and the featured moment
// in its centre, the lobby (while the open wave is forming), and the moment list.
//
// Joining a wave opens the capture sheet for the lobby: frame a moment, which is staged and posts
// when this peer's sweep slot fires. The Wallet button opens the self-custodial Cashu wallet (top
// up, cash out, mint picker, history).
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { Capture } from './src/components/Capture';
import { Wallet } from './src/components/Wallet';
import { PALETTE } from './src/theme';

// Directory topic override. Empty = the engine's DEFAULT_TOPIC ('hyperwave:demo:v1'), the same
// base the desktop host uses — a phone and a laptop only discover each other when these match, so
// the shared default is what a demo wants. Set a string here to isolate a build's ring from the
// demo one on the public DHT. The host derives the mainnet directory from it (`<base>:mainnet`).
const TOPIC = '';
// A tip is a fixed 5 sats, as on desktop (enough to survive the mint's ~1-sat swap fee).
const TIP_SATS = 5;
// Optional DHT bootstrap pin — 'host:port' (comma-separate several); createEngine parses it.
// Cold discovery on the public DHT takes ~20-35s, which is a long silence in a demo; pointing at a
// known node (e.g. a local @hyperswarm/testnet from the engine's `bare bin/dht-local.js`) makes it
// near-instant. Empty = the public DHT, which is the right default for a real user.
const BOOTSTRAP = '';

export default function App() {
  const engine = useEngine({
    ...(TOPIC ? { topicId: TOPIC } : {}),
    ...(BOOTSTRAP ? { bootstrap: BOOTSTRAP } : {})
  });
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
  // The wave whose capture the user dismissed ("Skip") — they still take part, just without a
  // moment, exactly like the desktop's skip button.
  const [skippedWaveId, setSkippedWaveId] = useState(null);
  const [walletOpen, setWalletOpen] = useState(false);
  const captureRef = useRef(null);

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
  // Frame a moment while I'm in a forming wave's lobby — unless I've opted out of this one.
  const capturing =
    inLobby &&
    (activeWave.joined || activeWave.mine) &&
    skippedWaveId !== activeWaveId;

  // Wave start: make sure the frame is taken (auto, if the user didn't press Capture), mirroring
  // the desktop's proof.captureAndStage() on wave-active.
  useEffect(() => {
    if (
      lastEvent?.event === 'wave-active' &&
      lastEvent.waveId === activeWaveId
    ) {
      captureRef.current?.captureAndStage();
    }
  }, [lastEvent, activeWaveId]);

  // app-core invariant 3: staging must happen BEFORE the core switches waves, so register the
  // capture hook with the store rather than relying on call order here.
  useEffect(() => {
    engine.setBeforeWaveSwitch(() => captureRef.current?.captureAndStage());
    return () => engine.setBeforeWaveSwitch(null);
  }, [engine.setBeforeWaveSwitch]);

  const stageMoment = useCallback(
    (moment) => engine.stageMoment(moment, activeWaveId),
    [engine.stageMoment, activeWaveId]
  );

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

      {activeWave && !inLobby ? (
        <Text style={styles.progress}>
          {gallery.length}/{activeWave.count || 1} moments in
        </Text>
      ) : null}

      {inLobby ? (
        <Lobby wave={activeWave} unit={unit} onJoin={() => engine.joinWave()} />
      ) : null}

      <Capture
        visible={!!capturing}
        deadline={activeWave?.lobbyDeadline || 0}
        captureRef={captureRef}
        onStage={stageMoment}
        onSkip={() => setSkippedWaveId(activeWaveId)}
      />

      <View style={styles.actions}>
        <Button label='Start a wave' onPress={engine.startWave} />
        <Button label='Wallet' onPress={() => setWalletOpen(true)} />
      </View>

      <Wallet
        visible={walletOpen}
        onClose={() => setWalletOpen(false)}
        wallet={wallet}
        fundResult={engine.fundResult}
        cashOutResult={engine.cashOutResult}
        transactions={engine.transactions}
        actions={engine}
      />

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
  progress: {
    color: PALETTE.muted,
    fontSize: 12,
    textAlign: 'center',
    paddingTop: 4
  },
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
