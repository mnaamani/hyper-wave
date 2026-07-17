// Build the NSFW image-safety classifier bundle for the desktop renderer (runs at postinstall, and
// in the desktop package step). esbuild bundles tfjs + nsfwjs + ONLY the mobilenet_v2 model into a
// single self-contained IIFE (`window.HWNsfw`) with the model embedded — so it loads from memory
// (no fetch, which a sandboxed file:// Electron renderer blocks). The renderer lazy-injects it.
//
// Best-effort: if the classifier deps aren't installed (e.g. an engine-only checkout) it skips
// rather than failing the whole install. Pass a target dir to write the bundle under
// <dir>/apps/desktop/... (used by the electron-forge package hook, which assembles a fresh tree).
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ? path.resolve(process.argv[2]) : ROOT;

const entry = path.join(ROOT, 'apps/desktop/scripts/nsfw-entry.mjs');
const outfile = path.join(
  target,
  'apps/desktop/renderer/vendor/nsfw.bundle.js'
);

if (!fs.existsSync(entry)) {
  console.log('[build-nsfw] entry not found — skipping');
  process.exit(0);
}

try {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'HWNsfw',
    minify: true,
    outfile,
    logLevel: 'error'
  });
  const kb = Math.round(fs.statSync(outfile).size / 1024);
  console.log(
    `[build-nsfw] built ${path.relative(target, outfile)} (${kb} KB)`
  );
} catch (err) {
  // Don't fail the whole install for the classifier bundle — the app still runs (unfiltered).
  console.warn(
    '[build-nsfw] WARNING: could not build the NSFW bundle:',
    err.message
  );
}
