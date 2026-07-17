// Local NSFW image-safety classifier (nsfwjs / MobileNetV2, runs entirely on-device). Wraps the
// esbuild bundle (vendor/nsfw.bundle.js — tfjs + nsfwjs + the model embedded, loaded from memory so
// no fetch, which a sandboxed file:// renderer blocks). Used by the gallery as a LOCAL viewing
// filter: each peer classifies the selfies it holds and blurs the ones flagged unsafe — the only
// coherent moderation model for a CRDT gallery (you can't delete an entry, only choose what to show
// yourself). It's a MobileNet classifier (~ms/image), so every peer can afford it on every selfie.
//
// The bundle is lazy-injected on first use (it's a few MB), and the model warms up on first
// classify — so nothing slows startup, and a wave with no gallery never loads it.

const UNSAFE_CLASSES = new Set(['Porn', 'Hentai', 'Sexy']);
const UNSAFE_THRESHOLD = 0.5; // flag if the summed unsafe-class probability crosses this

let bundlePromise = null; // resolves to window.HWNsfw once the bundle script has loaded

// Inject the classifier bundle once; resolve when its global is ready. Rejects if it can't load
// (e.g. the bundle wasn't built) — the caller treats that as "can't classify" (fail-open).
function ensureBundle() {
  if (bundlePromise) {
    return bundlePromise;
  }
  bundlePromise = new Promise((resolve, reject) => {
    if (window.HWNsfw) {
      resolve(window.HWNsfw);
      return;
    }
    const script = document.createElement('script');
    script.src = 'vendor/nsfw.bundle.js';
    script.onload = () =>
      window.HWNsfw
        ? resolve(window.HWNsfw)
        : reject(new Error('nsfw bundle loaded but HWNsfw is missing'));
    script.onerror = () => reject(new Error('nsfw bundle failed to load'));
    document.head.appendChild(script);
  });
  return bundlePromise;
}

// Decode a dataURL into an <img> the classifier can read (nsfwjs uses tf.browser.fromPixels).
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = document.createElement('img');
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = dataUrl;
  });
}

/**
 * Classify a selfie dataURL locally. Returns `{ unsafe, scores }`; `unsafe` is true when the summed
 * probability of the adult classes (Porn / Hentai / Sexy) crosses the threshold. Never throws — on
 * any failure it returns `{ unsafe: false }` (fail-open: an unclassifiable image is shown, not
 * hidden), so a missing/broken bundle degrades to today's behaviour rather than blanking the gallery.
 * @param {string} dataUrl - The selfie image (data:image/jpeg;base64,…).
 * @returns {Promise<{unsafe: boolean, scores?: Array<{className: string, probability: number}>}>}
 */
export async function classify(dataUrl) {
  if (!dataUrl) {
    return { unsafe: false };
  }
  try {
    const nsfw = await ensureBundle();
    const img = await loadImage(dataUrl);
    const scores = await nsfw.classify(img);
    const unsafeSum = scores
      .filter((score) => UNSAFE_CLASSES.has(score.className))
      .reduce((total, score) => total + score.probability, 0);
    return { unsafe: unsafeSum >= UNSAFE_THRESHOLD, scores };
  } catch (err) {
    console.warn('[nsfw] classification unavailable:', err.message);
    return { unsafe: false };
  }
}
