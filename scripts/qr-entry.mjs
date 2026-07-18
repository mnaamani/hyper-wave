// esbuild entry for the renderer's QR bundle (vendor/qr.bundle.js → window.HWQr).
// Wraps the dependency-free `qrcode-generator` so the wallet's top-up flow can show
// a bolt11 invoice as a QR — scannable from a phone's Lightning wallet, not just
// copied to the clipboard on this machine. Self-contained (no node built-ins, no
// fetch) so it runs in the sandboxed file:// renderer.
import qrcode from 'qrcode-generator';

/**
 * Encode `text` as a QR and return a GIF data URL (an <img src>).
 * @param {string} text - The payload (a bolt11 invoice).
 * @param {number} [cellSize] - Pixels per QR module.
 * @param {number} [margin] - Quiet-zone modules around the code.
 * @returns {string} A `data:image/gif;base64,…` URL.
 */
export function toDataUrl(text, cellSize = 4, margin = 4) {
  const qr = qrcode(0, 'M'); // type 0 = auto-size to fit; 'M' = medium error correction
  qr.addData(String(text));
  qr.make();
  return qr.createDataURL(cellSize, margin);
}
