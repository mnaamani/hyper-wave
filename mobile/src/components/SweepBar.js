// The sweep bar — what the ring's rolling spark becomes on a phone. The desktop draws the wave as
// a spark orbiting a circle of seats (renderer/lib/ring.js); a phone has no room for that circle,
// so the same choreography becomes a story-style segmented bar: one segment per roster seat, in
// the SAME angle order the sweep fires in, filling left to right as the wave rolls.
//
// It carries the identical information the ring did — how many peers are in, whose slot is live,
// how far the wave has travelled — in a few points of height, leaving the screen to the moments.
//
// Like the ring, the fill is a local REPLAY on a fixed duration (SWEEP_MS): the protocol races at
// network speed, so visual pacing is a renderer concern (protocol.md — the sweep is deterministic
// and self-triggered; nothing here feeds back into it).
import { useEffect, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { PALETTE, SWEEP_MS, FLOURISH_MS } from '../theme';

const BAR_HEIGHT = 3;
const MAX_SEGMENTS = 40; // beyond this the segments are thinner than a hairline — cap and merge

// A rAF-driven progress value in [0,1] that runs for `durationMs` when `runId` changes, then
// freezes at 1. Returns null when no sweep has been requested. (Moved here from the ring, which
// this component replaces.)
function useSweep(runId, durationMs) {
  const [progress, setProgress] = useState(null);
  const frameRef = useRef(null);

  useEffect(() => {
    if (!runId) {
      setProgress(null);
      return undefined;
    }
    const startedAt = Date.now();
    const tick = () => {
      const elapsed = Date.now() - startedAt;
      const next = Math.min(1, elapsed / durationMs);
      setProgress(next);
      if (next < 1) {
        frameRef.current = requestAnimationFrame(tick);
      }
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, [runId, durationMs]);

  return progress;
}

// The completion flourish: the whole bar glows for FLOURISH_MS after a wave completes — the
// mobile stand-in for the ring's expanding pulse.
function useFlourish(flourishId) {
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!flourishId) {
      return undefined;
    }
    setOn(true);
    const timer = setTimeout(() => setOn(false), FLOURISH_MS);
    return () => clearTimeout(timer);
  }, [flourishId]);

  return on;
}

// How full segment `index` is, in [0,1], at overall sweep `progress`. The lit head is whichever
// segment holds the boundary; everything behind it is full, everything ahead empty.
function fillOf({ index, progress, count }) {
  if (progress === null) {
    return 0;
  }
  const head = progress * count;
  return Math.max(0, Math.min(1, head - index));
}

/**
 * @param {Object} props - Props.
 * @param {number} props.seats - Roster size = how many segments to draw.
 * @param {number} props.arrived - How many moments have landed (hop-ordered feed length).
 * @param {string|null} props.sweepId - Changes to (re)start the sweep; null leaves the bar idle.
 * @param {string|null} props.flourishId - Changes to fire the completion glow.
 * @returns {JSX.Element|null} The bar, or null when there's no roster to draw.
 */
export function SweepBar({ seats, arrived, sweepId, flourishId }) {
  const progress = useSweep(sweepId, SWEEP_MS);
  const flourishing = useFlourish(flourishId);
  const count = Math.max(1, Math.min(MAX_SEGMENTS, seats || 0));

  if (!seats) {
    return null;
  }

  return (
    <View style={styles.bar}>
      {Array.from({ length: count }, (_unused, index) => {
        const fill = fillOf({ index, progress, count });
        // A seat whose moment is already in reads brighter even before the spark gets there, so
        // the bar doubles as "who has posted" while the gallery syncs in.
        const landed = index < arrived;
        return (
          <View key={index} style={styles.track}>
            <View
              style={[
                styles.fill,
                { width: `${fill * 100}%` },
                flourishing && styles.fillFlourish
              ]}
            />
            {landed && fill === 0 ? <View style={styles.landed} /> : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    gap: 3,
    height: BAR_HEIGHT,
    paddingHorizontal: 12
  },
  track: {
    flex: 1,
    height: BAR_HEIGHT,
    borderRadius: BAR_HEIGHT,
    backgroundColor: 'rgba(255,255,255,0.16)',
    overflow: 'hidden'
  },
  fill: {
    height: BAR_HEIGHT,
    borderRadius: BAR_HEIGHT,
    backgroundColor: PALETTE.orange
  },
  fillFlourish: { backgroundColor: PALETTE.orangeSoft },
  landed: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(247,147,26,0.45)'
  }
});
