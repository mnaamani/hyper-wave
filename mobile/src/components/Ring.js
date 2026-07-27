// The ring — the mobile counterpart of the desktop's canvas field (renderer/lib/ring.js), drawn
// with react-native-svg. Every peer sits at its OWN seat angle (derived from its id by the engine,
// never taken from gossip), the sweep spark rolls once around the ring while a wave races, and a
// completed wave pulses.
//
// The sweep here is a local REPLAY on a fixed duration (SWEEP_MS), exactly like desktop: the
// protocol races at network speed, so visual pacing is a renderer concern. The spark freezes at
// the end of its lap and stays parked, leaving the last moment featured.
import { useEffect, useRef, useState } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import Svg, { Circle, G, Text as SvgText } from 'react-native-svg';
import { flagOf } from 'hyperwave-app-core';
import { PALETTE, SWEEP_MS, FLOURISH_MS } from '../theme';

const SIZE = 320; // svg viewport (square)
const CENTER = SIZE / 2;
const RING_RADIUS = 132;
const PEER_DOT = 5;
const ME_DOT = 7;

// [x, y] of the point at `angleDeg` on a circle of `radius` about the ring centre.
// 0° is at the top and angles run clockwise — the same convention as the desktop ring and the
// engine's seat ordering, so a peer appears where its sweep slot says it should.
function pointOn(angleDeg, radius) {
  const radians = ((angleDeg - 90) * Math.PI) / 180;
  return [
    CENTER + radius * Math.cos(radians),
    CENTER + radius * Math.sin(radians)
  ];
}

// A rAF-driven progress value in [0,1] that runs for `durationMs` when `runId` changes, then
// freezes at 1. Returns null when no sweep has been requested. Kept in its own hook so only the
// spark re-renders per frame.
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

// The completion flourish: the ring pulses for FLOURISH_MS after a wave completes.
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

/**
 * @param {Object} props - Props.
 * @param {Object|null} props.me - My ring seat ({id, angle, country}).
 * @param {Array<Object>} props.peers - The other live seats.
 * @param {string|null} props.sweepId - Changes to (re)start the sweep; null hides the spark.
 * @param {string|null} props.flourishId - Changes to fire the completion pulse.
 * @param {Object|null} props.featured - The moment to show in the centre.
 * @param {string} [props.centerText] - Fallback centre text when there's no moment.
 * @returns {JSX.Element} The ring.
 */
export function Ring({ me, peers, sweepId, flourishId, featured, centerText }) {
  const progress = useSweep(sweepId, SWEEP_MS);
  const flourishing = useFlourish(flourishId);
  const seats = me ? [...peers, me] : peers;
  const sparkPoint =
    progress === null ? null : pointOn(progress * 360, RING_RADIUS);

  return (
    <View style={styles.wrap}>
      <Svg width={SIZE} height={SIZE}>
        {/* the ring itself — brighter while a wave is racing or flourishing */}
        <Circle
          cx={CENTER}
          cy={CENTER}
          r={RING_RADIUS}
          stroke={flourishing ? PALETTE.orange : 'rgba(247,147,26,0.35)'}
          strokeWidth={flourishing ? 4 : 2}
          fill='none'
        />
        {flourishing ? (
          <Circle
            cx={CENTER}
            cy={CENTER}
            r={RING_RADIUS + 10}
            stroke='rgba(247,147,26,0.25)'
            strokeWidth={10}
            fill='none'
          />
        ) : null}

        {seats.map((seat) => {
          const isMe = me && seat.id === me.id;
          const [x, y] = pointOn(seat.angle || 0, RING_RADIUS);
          const flag = flagOf(seat.country);
          return (
            <G key={seat.id}>
              <Circle
                cx={x}
                cy={y}
                r={isMe ? ME_DOT : PEER_DOT}
                fill={isMe ? PALETTE.orange : PALETTE.orangeSoft}
                opacity={isMe ? 1 : 0.75}
              />
              {flag ? (
                <SvgText
                  x={x}
                  y={y - 12}
                  fontSize='13'
                  textAnchor='middle'
                  fill={PALETTE.text}
                >
                  {flag}
                </SvgText>
              ) : null}
            </G>
          );
        })}

        {/* the sweep spark */}
        {sparkPoint ? (
          <G>
            <Circle
              cx={sparkPoint[0]}
              cy={sparkPoint[1]}
              r={13}
              fill='rgba(247,147,26,0.25)'
            />
            <Circle
              cx={sparkPoint[0]}
              cy={sparkPoint[1]}
              r={7}
              fill={PALETTE.orange}
            />
          </G>
        ) : null}
      </Svg>

      {/* the ring centre: the featured moment, or a status line */}
      <View style={styles.center} pointerEvents='none'>
        {featured?.image ? (
          <>
            <Image source={{ uri: featured.image }} style={styles.moment} />
            <Text style={styles.caption} numberOfLines={1}>
              {flagOf(featured.country)} {featured.caption || ''}
            </Text>
          </>
        ) : (
          <Text style={styles.centerText}>{centerText || ''}</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: SIZE,
    height: SIZE,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center'
  },
  center: {
    position: 'absolute',
    width: RING_RADIUS * 1.35,
    height: RING_RADIUS * 1.35,
    alignItems: 'center',
    justifyContent: 'center'
  },
  moment: {
    width: 140,
    height: 140,
    borderRadius: 70,
    borderWidth: 2,
    borderColor: PALETTE.orange
  },
  caption: {
    color: PALETTE.text,
    fontSize: 12,
    marginTop: 6,
    paddingHorizontal: 8
  },
  centerText: {
    color: PALETTE.muted,
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: 24
  }
});
