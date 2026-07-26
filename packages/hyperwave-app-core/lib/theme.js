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
