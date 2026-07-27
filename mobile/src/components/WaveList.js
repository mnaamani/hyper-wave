// The wave directory — the mobile counterpart of the desktop's orbiting bubbles
// (renderer/lib/directory.js). A phone has no room to orbit the ring, so the same information
// becomes a horizontal strip of chips: one per wave this peer is AWARE of, phase-coloured, with
// the initiator's flag and roster count. Merely being aware holds no cores — tapping a chip is
// what subscribes (browse-then-pick) and makes the wave active.
//
// Cross-network waves are hidden (a wave whose settlement network is a known mismatch with my
// wallet's), exactly as on desktop: a cross-network tip would be meaningless. My own waves always
// pass.
import { ScrollView, Pressable, Text, View, StyleSheet } from 'react-native';
import { flagOf } from 'hyperwave-app-core';
import { PALETTE, PHASE_COLOR } from '../theme';

/**
 * @param {Object} props - Props.
 * @param {Array<Object>} props.waves - The directory entries.
 * @param {string|null} props.activeWaveId - The open wave.
 * @param {(id: string) => string} props.countryOf - Ring id -> country code.
 * @param {(wave: Object) => boolean} props.matchesNetwork - The same-network filter.
 * @param {(waveId: string) => void} props.onSelect - Tap handler.
 * @returns {JSX.Element} The directory strip.
 */
export function WaveList({
  waves,
  activeWaveId,
  countryOf,
  matchesNetwork,
  onSelect
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
              {typeof wave.fee === 'number' ? ` · ${wave.fee} sat` : ''}
            </Text>
            {wave.paid && wave.paid !== 'verified' ? (
              <View style={styles.pending}>
                <Text style={styles.pendingText}>{wave.paid}</Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
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
  fading: { opacity: 0.45 },
  chipTop: { color: PALETTE.text, fontWeight: '600', fontSize: 13 },
  chipPhase: { fontSize: 11, marginTop: 2 },
  pending: { marginTop: 4 },
  pendingText: { color: PALETTE.warn, fontSize: 10 }
});
