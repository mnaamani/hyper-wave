// The wave directory — the mobile counterpart of the desktop's concentric wave rings
// (renderer/lib/ring.js: one ring per wave, drifting inward through its lifecycle). A phone has
// neither the radial room for that nor a ring at all, so the same information becomes a horizontal
// strip of chips: one per wave this peer is AWARE of, phase-coloured, with the initiator's flag and
// roster count. Merely being aware holds no cores — tapping a chip is what subscribes
// (browse-then-pick) and makes the wave active.
//
// Cross-network waves are hidden (a wave whose settlement network is a known mismatch with my
// wallet's), exactly as on desktop: a cross-network tip would be meaningless. My own waves always
// pass.
import {
  ScrollView,
  Pressable,
  Text,
  View,
  Alert,
  StyleSheet
} from 'react-native';
import { flagOf, unitLabelFor } from 'hyperwave-app-core';
import { PALETTE, PHASE_COLOR } from '../theme';

// Dismissing is destructive-ish (the wave leaves your list and its cores are freed), and a chip is
// small enough to catch a stray thumb, so confirm first. The desktop reveals its ✕ on hover; a
// phone has no hover, so the equivalent "show me you meant it" is a long press.
function confirmDismiss(wave, onDismiss) {
  const who = wave.mine
    ? 'your wave'
    : `${(wave.by || 'peer').slice(0, 6)}'s wave`;
  Alert.alert(
    'Dismiss this wave?',
    `${who} disappears from your list and stops using your connection. It won't come back.`,
    [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Dismiss',
        style: 'destructive',
        onPress: () => onDismiss(wave.waveId)
      }
    ]
  );
}

/**
 * @param {Object} props - Props.
 * @param {Array<Object>} props.waves - The directory entries.
 * @param {string|null} props.activeWaveId - The open wave.
 * @param {(id: string) => string} props.countryOf - Ring id -> country code.
 * @param {(wave: Object) => boolean} props.matchesNetwork - The same-network filter.
 * @param {(waveId: string) => void} props.onSelect - Tap handler.
 * @param {(waveId: string) => void} props.onDismiss - Long-press handler (after confirmation).
 * @returns {JSX.Element} The directory strip.
 */
export function WaveList({
  waves,
  activeWaveId,
  countryOf,
  matchesNetwork,
  onSelect,
  onDismiss
}) {
  const visible = waves.filter(
    (wave) => wave.mine || matchesNetwork(wave) !== false
  );

  if (visible.length === 0) {
    return (
      <Text style={styles.empty}>
        No waves yet — start one, or wait for a peer.
      </Text>
    );
  }

  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
      >
        {visible.map((wave) => {
          const active = wave.waveId === activeWaveId;
          const color = PHASE_COLOR[wave.phase] || PALETTE.orangeSoft;
          return (
            <Pressable
              key={wave.waveId}
              onPress={() => onSelect(wave.waveId)}
              onLongPress={() => confirmDismiss(wave, onDismiss)}
              delayLongPress={400}
              style={[
                styles.chip,
                { borderColor: active ? color : 'transparent' },
                wave.fading && styles.fading
              ]}
            >
              <Text style={styles.chipTop}>
                {flagOf(countryOf(wave.by)) || '🌐'}{' '}
                {wave.mine ? 'You' : (wave.by || 'peer').slice(0, 6)}
              </Text>
              <Text style={[styles.chipPhase, { color }]}>
                {wave.phase} · {wave.count || 1}👥
                {typeof wave.fee === 'number'
                  ? ` · ${wave.fee} ${unitLabelFor('sat', wave.fee)}`
                  : ''}
              </Text>
              {wave.message ? (
                <Text style={styles.chipMsg} numberOfLines={1}>
                  {wave.message}
                </Text>
              ) : null}
              {wave.paid && wave.paid !== 'verified' ? (
                <View style={styles.pending}>
                  <Text style={styles.pendingText}>{wave.paid}</Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
      {/* A long press is invisible, and the desktop's ✕ is revealed by a hover a phone can't do —
          so say it once, quietly, under the strip. */}
      <Text style={styles.hint}>Hold a wave to dismiss it</Text>
    </>
  );
}

const styles = StyleSheet.create({
  strip: { paddingHorizontal: 16, gap: 8, paddingVertical: 4 },
  empty: {
    color: PALETTE.muted,
    paddingHorizontal: 16,
    paddingVertical: 8,
    fontSize: 13
  },
  chip: {
    backgroundColor: PALETTE.panel,
    borderRadius: 12,
    borderWidth: 1.5,
    paddingVertical: 8,
    paddingHorizontal: 12,
    minWidth: 118
  },
  hint: {
    color: PALETTE.dim,
    fontSize: 10,
    paddingHorizontal: 16,
    paddingTop: 2
  },
  fading: { opacity: 0.45 },
  chipTop: { color: PALETTE.text, fontWeight: '600', fontSize: 13 },
  chipPhase: { fontSize: 11, marginTop: 2 },
  // the initiator's own words — one line on the chip, in full in the lobby
  chipMsg: {
    color: PALETTE.orangeSoft,
    fontSize: 11,
    fontStyle: 'italic',
    marginTop: 3,
    maxWidth: 150
  },
  pending: { marginTop: 4 },
  pendingText: { color: PALETTE.warn, fontSize: 10 }
});
