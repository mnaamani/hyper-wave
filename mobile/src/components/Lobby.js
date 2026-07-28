// The lobby — the mobile counterpart of renderer/lib/lobby.js. Shown while the open wave is still
// forming: a countdown to the start, the roster count, the participation fee, and the join button.
//
// The join button is GATED on the initiator's start burn being verified (`paid === 'verified'`),
// which is the anti-spam rule the desktop enforces too: until the wave's own fee is proven paid,
// joining (and paying a fee of your own) would be throwing sats at an unproven wave.
import { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { unitLabelFor } from 'hyperwave-app-core';
import { PALETTE } from '../theme';

const TICK_MS = 250;

// Seconds left until `deadline` (a Date.now()-based ms timestamp), re-read on a self-rescheduling
// timer (never setInterval — CLAUDE.md Code Style).
function useCountdown(deadline) {
  const [left, setLeft] = useState(0);

  useEffect(() => {
    let timer = null;
    const tick = () => {
      setLeft(Math.max(0, (deadline || 0) - Date.now()));
      timer = setTimeout(tick, TICK_MS);
    };
    tick();
    return () => clearTimeout(timer);
  }, [deadline]);

  return left;
}

/**
 * @param {Object} props - Props.
 * @param {Object} props.wave - The active wave's directory entry.
 * @param {string} props.unit - The wallet's RAW unit code (e.g. 'sat'); inflected for the fee.
 * @param {() => void} props.onJoin - Join handler.
 * @returns {JSX.Element} The lobby panel.
 */
export function Lobby({ wave, unit, onJoin }) {
  const msLeft = useCountdown(wave.lobbyDeadline);
  const joinable = wave.paid === 'verified';
  const joined = !!wave.joined || !!wave.mine;
  const feeSuffix =
    typeof wave.fee === 'number'
      ? ` (${wave.fee} ${unitLabelFor(unit, wave.fee)})`
      : '';

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>
        {joined ? 'You’re in this wave' : 'A wave is forming'}
      </Text>
      <Text style={styles.meta}>
        {Math.ceil(msLeft / 1000)}s · {wave.count || 1} peer
        {(wave.count || 1) === 1 ? '' : 's'} on the roster
      </Text>
      {joined ? (
        <Text style={styles.hint}>
          Your moment posts when the sweep reaches your seat.
        </Text>
      ) : (
        <Pressable
          onPress={onJoin}
          disabled={!joinable}
          style={[styles.join, !joinable && styles.joinDisabled]}
        >
          <Text style={[styles.joinText, !joinable && styles.joinTextDisabled]}>
            {joinable ? `✋ Count me in${feeSuffix}` : '⏳ verifying payment…'}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    marginHorizontal: 16,
    marginTop: 8,
    padding: 14,
    borderRadius: 14,
    backgroundColor: PALETTE.panel,
    borderWidth: 1,
    borderColor: PALETTE.panelEdge,
    alignItems: 'center'
  },
  title: { color: PALETTE.text, fontWeight: '700', fontSize: 15 },
  meta: { color: PALETTE.muted, fontSize: 12, marginTop: 4 },
  hint: { color: PALETTE.orangeSoft, fontSize: 12, marginTop: 8 },
  join: {
    marginTop: 10,
    backgroundColor: PALETTE.orange,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10
  },
  joinDisabled: { backgroundColor: '#2a231c' },
  joinText: { color: '#1a1204', fontWeight: '700' },
  joinTextDisabled: { color: PALETTE.muted }
});
