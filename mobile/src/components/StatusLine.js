// The narration surface — the mobile counterpart of the desktop HUD (renderer/lib/hud.js): a
// persistent network status line plus the live wave narration, which fades after a while so a
// stale beat doesn't sit on screen forever.
import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { PALETTE } from '../theme';

const TOAST_MS = 6000;

/**
 * @param {Object} props - Props.
 * @param {number} props.peers - Live peer count.
 * @param {number} props.waves - How many waves this peer is aware of.
 * @param {Object|null} props.me - My ring seat.
 * @param {{text: string, at: number}|null} props.toast - The latest narration beat.
 * @returns {JSX.Element} The status area.
 */
export function StatusLine({ peers, waves, me, toast }) {
  const [shown, setShown] = useState(null);

  useEffect(() => {
    if (!toast) {
      return undefined;
    }
    setShown(toast.text);
    const timer = setTimeout(() => setShown(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <View style={styles.wrap}>
      <Text style={styles.status}>
        {peers > 0
          ? `⚡ ${peers} peer${peers === 1 ? '' : 's'}`
          : '🔍 searching…'}
        {' · '}
        {waves} wave{waves === 1 ? '' : 's'}
        {me ? ` · you @ ${Math.round(me.angle || 0)}°` : ''}
      </Text>
      <Text style={styles.narration} numberOfLines={2}>
        {shown || ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 16, paddingTop: 6, minHeight: 54 },
  status: { color: PALETTE.muted, fontSize: 12 },
  narration: {
    color: PALETTE.orangeSoft,
    fontSize: 14,
    marginTop: 4,
    minHeight: 34
  }
});
