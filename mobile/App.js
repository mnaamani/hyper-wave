// HyperWave mobile — the wave screen. Composition only: every rule behind it lives in the shared
// app core (hyperwave-app-core), which src/useEngine.js drives over the worklet.
//
// The screen is a full-bleed vertical feed of moments (MomentFeed) with everything else floating
// over it, the shape a phone user already knows. The desktop's ring has NO counterpart here — a
// 320pt circle on a 6" screen crowded out the moments it was framing — so the sweep it drew is a
// story-style segmented bar at the top instead (SweepBar): one segment per roster seat, in sweep
// order, filling as the wave rolls. Same information, a fraction of the height. The ring remains
// the desktop's map of the world (renderer/lib/ring.js); only the mobile presentation differs.
//
// Overlays, top to bottom: the sweep bar, the wallet/brand header + narration, the wave directory
// strip (tap a wave to subscribe + open it), then at the foot the lobby and the action buttons.
//
// Joining a wave opens the capture sheet for the lobby: frame a moment, which is staged and posts
// when this peer's sweep slot fires. The Wallet button opens the self-custodial Cashu wallet (top
// up, cash out, mint picker, history).
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  Pressable,
  StatusBar,
  Platform,
  StyleSheet
} from 'react-native';
import { flagOf, unitLabelFor } from 'hyperwave-app-core';
import { useEngine } from './src/useEngine';
import { readCountry, writeCountry } from './src/custody';
import { MomentFeed } from './src/components/MomentFeed';
import { SweepBar } from './src/components/SweepBar';
import { WaveList } from './src/components/WaveList';
import { Lobby } from './src/components/Lobby';
import { StatusLine } from './src/components/StatusLine';
import { CountryPicker } from './src/components/CountryPicker';
import { Capture } from './src/components/Capture';
import { Wallet } from './src/components/Wallet';
import { PALETTE, SWEEP_MS } from './src/theme';

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
// Android draws under the status bar (iOS's SafeAreaView handles itself), so the top overlay pays
// for it explicitly.
const TOP_INSET = Platform.OS === 'android' ? StatusBar.currentHeight || 24 : 0;

// A moment's stable identity: one entry per peer per wave (the CRDT posts block 0 only), so the
// peer id names it; `hopCount` is the fallback for an entry that arrived without one.
function momentKey(moment) {
  return moment.peerId || String(moment.hopCount);
}

// What an EMPTY feed says, by the active wave's phase. An ended wave with nothing in it is final,
// not still syncing, so it must not keep promising moments that will never come — the phone's
// counterpart of the desktop ring centre's terminal message. Without it, "nobody posted", "the
// roster's cores never replicated to me" and "my own entry was held" all read as the same screen.
const EMPTY_FEED_TEXT = {
  lobby: 'Moments appear here as the wave sweeps the ring.',
  racing: 'Moments appear here as the wave sweeps the ring.',
  ended: 'No moments arrived — the wave didn’t reach you.'
};
const NO_WAVE_TEXT = 'Start a wave, or tap one above to watch it.';

/**
 * The empty-feed message for the wave on screen.
 * @param {Object|null} activeWave - The active wave, or null when none is selected.
 * @returns {string} What to show in place of the feed.
 */
function emptyFeedTextFor(activeWave) {
  if (!activeWave) {
    return NO_WAVE_TEXT;
  }
  return EMPTY_FEED_TEXT[activeWave.phase] || EMPTY_FEED_TEXT.lobby;
}

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
  // What this peer will say about the wave it starts. It rides the wave's announce, so every peer
  // browsing the directory reads it while deciding whether to join.
  const [waveMessage, setWaveMessage] = useState('');
  // Reopening the country picker after onboarding (the header flag is its button).
  const [pickerOpen, setPickerOpen] = useState(false);
  // Which page of the feed is on screen, and whether the sweep is still driving it. `following`
  // is the auto-advance: while a wave rolls, each moment takes the screen as it lands, so the
  // wave is something you watch roll past rather than a progress read-out. The first manual drag
  // hands control back to the user for the rest of that wave.
  const [feedIndex, setFeedIndex] = useState(0);
  const [following, setFollowing] = useState(true);
  const captureRef = useRef(null);

  // The country is the engine's cosmetic peer `tag`; push it once the engine is up (and whenever
  // the user picks a new one), so this peer's seat and moments carry its flag.
  useEffect(() => {
    if (country && engine.ready) {
      engine.setCountry(country);
    }
  }, [country, engine.ready]);

  // Sweep triggers, straight off the protocol: the bar fills while the open wave races, and glows
  // when it completes. Both are STICKY ids (they must survive the events that follow, e.g.
  // `position`), reset when the open wave changes or a new wave forms.
  const [sweepId, setSweepId] = useState(null);
  const [flourishId, setFlourishId] = useState(null);

  useEffect(() => {
    setSweepId(null);
    setFlourishId(null);
    setFeedIndex(0);
    setFollowing(true); // a new wave gets the feed back
  }, [activeWaveId]);

  useEffect(() => {
    if (!lastEvent || lastEvent.waveId !== activeWaveId) {
      return;
    }
    if (lastEvent.event === 'wave-active') {
      setSweepId(String(lastEvent.at));
      setFollowing(true);
    } else if (lastEvent.event === 'completed') {
      setFlourishId(String(lastEvent.at));
    } else if (lastEvent.event === 'wave-announce') {
      setSweepId(null);
      setFlourishId(null);
    }
  }, [lastEvent, activeWaveId]);

  // Auto-advance: the gallery is hop-ordered, so the newest arrival IS the seat the sweep just
  // passed — following it is the wave rolling through the feed.
  useEffect(() => {
    if (following && gallery.length > 0) {
      setFeedIndex(gallery.length - 1);
    }
  }, [following, gallery.length]);

  // ...and the sweep hands the feed BACK when its lap ends. This is the desktop's rule too: the
  // spark freezes at the end of its lap and the ring becomes the user's scrubber. Without it the
  // wave would keep owning the scroll after there was anything left to show, so a moment landing
  // late (cores still syncing) would yank a browsing user back to the end. The bar's lap is
  // SWEEP_MS, so that is when the feed becomes theirs to scroll freely.
  useEffect(() => {
    if (!sweepId) {
      return undefined;
    }
    const timer = setTimeout(() => setFollowing(false), SWEEP_MS);
    return () => clearTimeout(timer);
  }, [sweepId]);

  // The raw unit code ('sat'); each display site inflects it for the amount beside it, so a
  // balance of exactly 1 reads "1 sat" while a standing label reads "sats".
  const rawUnit = wallet?.unit || 'sat';
  const inLobby = activeWave && activeWave.phase === 'lobby';
  const emptyFeedText = emptyFeedTextFor(activeWave);
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

  const canTip = useCallback(
    (moment) => !!moment.address && moment.address !== wallet?.address,
    [wallet?.address]
  );

  const tipMoment = useCallback(
    (moment) =>
      engine.tip({
        waveId: moment.waveId,
        peerId: moment.peerId,
        address: moment.address,
        amount: TIP_SATS
      }),
    [engine.tip]
  );

  return (
    <View style={styles.screen}>
      <StatusBar barStyle='light-content' translucent />
      {/* Onboarding while there's no country, and the switcher afterwards (tap the header flag).
          `onClose` is passed ONLY once a country exists — during onboarding the picker must have
          no way out but choosing, and afterwards a mistaken tap must be cancellable, leaving the
          current country untouched. */}
      <CountryPicker
        visible={!country || pickerOpen}
        onPick={(code) => {
          writeCountry(code);
          setCountry(code);
          setPickerOpen(false);
        }}
        onClose={country ? () => setPickerOpen(false) : null}
      />

      <MomentFeed
        moments={gallery}
        keyOf={momentKey}
        index={feedIndex}
        onIndexChange={setFeedIndex}
        onManualScroll={() => setFollowing(false)}
        onTip={tipMoment}
        canTip={canTip}
        tipLabel={`${TIP_SATS} ${unitLabelFor(rawUnit, TIP_SATS)}`}
        emptyText={emptyFeedText}
      />

      {/* everything below floats OVER the feed — box-none so only the controls take touches */}
      <SafeAreaView style={styles.topOverlay} pointerEvents='box-none'>
        {/* box-none, not auto: the scrim is a backdrop, so a swipe that starts on the title or
            the status line falls through to the feed instead of being swallowed. Its interactive
            children (the wallet chip, the wave strip) still take their own touches. */}
        <View style={styles.topScrim} pointerEvents='box-none'>
          <SweepBar
            seats={activeWave?.count || 0}
            arrived={gallery.length}
            sweepId={sweepId}
            flourishId={flourishId}
          />
          <View style={styles.header}>
            {/* the flag is the country switcher, as `#myflag` is on desktop */}
            <Pressable
              onPress={() => setPickerOpen(true)}
              accessibilityLabel='Change your country'
            >
              <Text style={styles.title}>
                ⚡ HyperWave {country ? flagOf(country) : '🌐'}
              </Text>
            </Pressable>
            <Pressable onPress={() => setWalletOpen(true)}>
              <Text style={styles.chip}>
                {wallet
                  ? `${wallet.amount ?? 0} ${unitLabelFor(rawUnit, wallet.amount ?? 0)} · ${wallet.network || '…'}`
                  : '…'}
              </Text>
            </Pressable>
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
            // long-press a chip → confirm → push that wave away for good (app-core invariant 6),
            // the phone's answer to the ✕ the desktop reveals on hover
            onDismiss={engine.dismissWave}
          />
        </View>
      </SafeAreaView>

      <SafeAreaView style={styles.bottomOverlay} pointerEvents='box-none'>
        {activeWave && !inLobby ? (
          <Text style={styles.progress}>
            {gallery.length > 0
              ? `${Math.min(feedIndex + 1, gallery.length)} of ${
                  gallery.length
                } · ${activeWave.count || 1} on the roster`
              : `${activeWave.count || 1} on the roster`}
          </Text>
        ) : null}

        {inLobby ? (
          <Lobby
            wave={activeWave}
            unit={rawUnit}
            onJoin={() => engine.joinWave()}
          />
        ) : null}

        {/* Only offer the message field when starting is what the buttons below actually do —
            i.e. when there's no wave of mine already forming or rolling. */}
        {!activeWave ? (
          <TextInput
            value={waveMessage}
            onChangeText={setWaveMessage}
            placeholder='Say what your wave is about (optional)'
            placeholderTextColor={PALETTE.dim}
            maxLength={80}
            returnKeyType='done'
            style={styles.waveMsgInput}
          />
        ) : null}

        <View style={styles.actions}>
          <Button
            label='Start a wave'
            onPress={() => {
              engine.startWave(waveMessage);
              setWaveMessage(''); // a message belongs to the wave it started
            }}
          />
          <Button label='Wallet' onPress={() => setWalletOpen(true)} />
        </View>
      </SafeAreaView>

      <Capture
        visible={!!capturing}
        deadline={activeWave?.lobbyDeadline || 0}
        captureRef={captureRef}
        onStage={stageMoment}
        onSkip={() => setSkippedWaveId(activeWaveId)}
      />

      <Wallet
        visible={walletOpen}
        onClose={() => setWalletOpen(false)}
        wallet={wallet}
        fundResult={engine.fundResult}
        cashOutResult={engine.cashOutResult}
        transactions={engine.transactions}
        actions={engine}
      />
    </View>
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
  topOverlay: { position: 'absolute', top: 0, left: 0, right: 0 },
  // a scrim so white captions in a moment can't swallow the header text
  topScrim: {
    paddingTop: TOP_INSET + 6,
    paddingBottom: 10,
    backgroundColor: 'rgba(10,10,10,0.72)'
  },
  bottomOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: 8,
    backgroundColor: 'rgba(10,10,10,0.72)'
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8
  },
  title: { color: PALETTE.text, fontSize: 17, fontWeight: '700' },
  chip: {
    color: PALETTE.orange,
    fontSize: 12,
    fontWeight: '600',
    backgroundColor: PALETTE.panel,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 10,
    overflow: 'hidden'
  },
  waveMsgInput: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(0,0,0,0.42)',
    color: PALETTE.text,
    fontSize: 13
  },
  progress: {
    color: PALETTE.muted,
    fontSize: 12,
    textAlign: 'center',
    paddingBottom: 6
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 6
  },
  btn: {
    flex: 1,
    backgroundColor: PALETTE.orange,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center'
  },
  btnDisabled: { backgroundColor: PALETTE.panel },
  btnText: { color: '#1a1005', fontWeight: '700', fontSize: 15 },
  btnTextDisabled: { color: PALETTE.dim }
});
