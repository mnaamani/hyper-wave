// The theme boundary, shared by both hosts. The ENGINE is theme-agnostic: it speaks of a peer's
// cosmetic `tag` and a feed entry's opaque `payload`. This app's theme fills those with a country
// code and a {image, caption} moment. Mapping them here (rather than in each host) is what keeps
// the two UIs showing the same thing — and keeps the app vocabulary out of the engine package.

/**
 * Map an engine peer to the app's shape (its `tag` is this app's country code).
 * @param {{tag?: string}} peer - A peer from a `state` message.
 * @returns {Object} The peer with `country` alongside its engine fields.
 */
export function withCountry(peer) {
  return { ...peer, country: peer?.tag };
}

/**
 * Map an engine feed entry to the app's moment shape. The entry's opaque `payload` carries
 * `{image, caption}`; its `tag` is the poster's country.
 * @param {{payload?: {image?: string, caption?: string}, tag?: string}} item - A feed entry.
 * @returns {Object} The entry with `image` / `caption` / `country` alongside its engine fields.
 */
export function asMoment(item) {
  return {
    ...item,
    image: item?.payload?.image || '',
    caption: item?.payload?.caption || '',
    country: item?.tag
  };
}

/**
 * Wrap a moment as an engine entry payload (the inverse of `asMoment`).
 * @param {{image?: string, caption?: string}} moment - The captured moment.
 * @returns {{payload: Object}} The engine entry.
 */
export function asEntry(moment) {
  return { payload: moment };
}

// The initiator's message is UNTRUSTED text written by another peer, so it is sanitized HERE —
// once, for both hosts — rather than in each UI where one of them would eventually forget.
// Stripped: control characters (they'd break the single line it's drawn on) and bidi overrides
// like U+202E, which can visually reverse or scramble the text around them. Then clamped, so a
// wave that spends its whole wire budget on one field still gets one line of screen.
const UNSAFE_TEXT =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const MAX_WAVE_MESSAGE = 80;

/**
 * Map a wave's opaque engine `meta` to the app's shape. The initiator may say what the wave is
 * about; the engine carries it as opaque metadata on the announce, and this app reads a `message`
 * out of it — sanitized and length-clamped, ready to render.
 * @param {{message?: string}|null|undefined} meta - The wave's engine meta.
 * @returns {string} The initiator's message, or ''.
 */
export function waveMessageOf(meta) {
  if (typeof meta?.message !== 'string') {
    return '';
  }
  return meta.message
    .replace(UNSAFE_TEXT, '')
    .trim()
    .slice(0, MAX_WAVE_MESSAGE);
}

/**
 * Wrap an initiator's message as engine wave meta (the inverse of `waveMessageOf`). Returns
 * undefined for an empty message, so a wave with nothing to say carries no field at all.
 * @param {string} message - What the initiator wants to say about the wave.
 * @returns {{message: string}|undefined} The engine meta, or undefined.
 */
export function asWaveMeta(message) {
  const text = String(message || '')
    .replace(UNSAFE_TEXT, '')
    .trim()
    .slice(0, MAX_WAVE_MESSAGE);
  return text ? { message: text } : undefined;
}
