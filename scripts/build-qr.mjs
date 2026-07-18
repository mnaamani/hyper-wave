// Build the QR-code bundle for the desktop renderer (runs at postinstall, and in the desktop
// package step). esbuild bundles the dependency-free `qrcode-generator` into a single
// self-contained IIFE (`window.HWQr`) so the wallet's top-up flow can render a bolt11 invoice as a
// scannable QR — no fetch (a sandboxed file:// Electron renderer blocks it). The renderer
// lazy-injects it (renderer/lib/qr.js). Mirrors build-nsfw.mjs.
//
// Best-effort: if the dep isn't installed (an engine-only checkout) it skips rather than failing
// the whole install. Pass a target dir to write the bundle under <dir>/renderer/... (the forge
// hook, which assembles a fresh tree).
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ? path.resolve(process.argv[2]) : ROOT;

const entry = path.join(ROOT, 'scripts/qr-entry.mjs');
const outfile = path.join(target, 'renderer/vendor/qr.bundle.js');

if (!fs.existsSync(entry)) {
  console.log('[build-qr] entry not found — skipping');
  process.exit(0);
}

try {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'HWQr',
    minify: true,
    outfile,
    logLevel: 'error'
  });
  const kb = Math.round(fs.statSync(outfile).size / 1024);
  console.log(`[build-qr] built ${path.relative(target, outfile)} (${kb} KB)`);
} catch (err) {
  // Don't fail the whole install for the QR bundle — top-up still works via clipboard.
  console.warn(
    '[build-qr] WARNING: could not build the QR bundle:',
    err.message
  );
}
