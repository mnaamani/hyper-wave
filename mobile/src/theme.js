// The mobile app's visual language — the bitcoin-orange palette the desktop renderer uses
// (renderer/index.html), in one place so every screen agrees.
export const PALETTE = {
  bg: '#0a0a0a',
  bgGlow: '#241606', // the radial glow behind the ring on desktop
  panel: '#171310',
  panelEdge: 'rgba(255,255,255,0.07)',
  orange: '#f7931a',
  orangeSoft: '#ffb04d',
  text: '#f5f5f5',
  muted: '#a99e92',
  dim: '#6b625a',
  good: '#7dffa1',
  warn: '#ffd479'
};

// Wave phase → the colour a directory chip and the ring use for it.
export const PHASE_COLOR = {
  lobby: PALETTE.orangeSoft,
  racing: PALETTE.orange,
  ended: PALETTE.dim
};

// The local sweep is a REPLAY, decoupled from the (near-instant) protocol race — the same idea as
// the desktop ring: the spark rolls once around the ring over a fixed duration regardless of N.
export const SWEEP_MS = 8000;
export const FLOURISH_MS = 1500;
