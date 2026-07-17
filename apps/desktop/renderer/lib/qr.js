// Lazy loader for the renderer's QR bundle (vendor/qr.bundle.js → window.HWQr). Used by the wallet
// top-up flow to render a bolt11 invoice as a scannable QR (so a Lightning wallet on a phone — not
// just this machine — can pay it). Mirrors nsfw.js's inject-once pattern; fails soft (a missing
// bundle just means no QR, the invoice is still copied to the clipboard).
let bundlePromise = null; // resolves to window.HWQr once the bundle script has loaded

// Inject the QR bundle once; resolve when its global is ready. Rejects if it can't load.
function ensureBundle() {
  if (bundlePromise) {
    return bundlePromise;
  }
  bundlePromise = new Promise((resolve, reject) => {
    if (window.HWQr) {
      resolve(window.HWQr);
      return;
    }
    const script = document.createElement('script');
    script.src = 'vendor/qr.bundle.js';
    script.onload = () =>
      window.HWQr
        ? resolve(window.HWQr)
        : reject(new Error('qr bundle loaded but HWQr is missing'));
    script.onerror = () => reject(new Error('qr bundle failed to load'));
    document.head.appendChild(script);
  });
  return bundlePromise;
}

/**
 * Encode `text` as a QR and resolve a GIF data URL (an `<img src>`). Resolves null on any failure
 * (a missing/broken bundle), so the caller degrades to clipboard-only rather than throwing.
 * @param {string} text - The payload (a bolt11 invoice).
 * @returns {Promise<string|null>} The `data:image/gif;base64,…` URL, or null.
 */
export async function qrDataUrl(text) {
  try {
    const qr = await ensureBundle();
    return qr.toDataUrl(text);
  } catch {
    return null;
  }
}
