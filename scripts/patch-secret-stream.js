// Vendored security patch for @hyperswarm/secret-stream (runs as postinstall, under Node).
//
// The transport reassembles each message from a 3-byte on-wire length prefix and
// `b4a.allocUnsafe(this._len)`s up to MAX_ATOMIC_WRITE (256^3-1 ≈ 16 MB) for a multi-chunk
// message BEFORE decryption hands the plaintext to Protomux / our receive edge — and it exposes no
// option to cap that. So a hostile peer can force a ~16 MB allocation per frame it pushes, on the
// gossip channel AND the shared Hypercore replication channel, before any app-level check runs
// (protocol.md §11.3). This teaches secret-stream an opt-in `maxMessageSize`: it rejects an
// oversized message AT the length-prefix read, before the allocation. wave.js sets it per
// connection (on an engine-owned swarm) so both channels refuse an oversized frame without
// allocating it.
//
// This is a string-injection patch on the installed file (the same approach as fix-bare-engines) —
// idempotent (a marker guards re-runs) and anchored on exact source lines, so a secret-stream
// upgrade that moves them fails LOUDLY (a warning) rather than silently dropping the protection.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MARKER = 'maxMessageSize'; // presence ⇒ already patched
const REL = path.join('@hyperswarm', 'secret-stream', 'index.js');

// The constructor anchor: an opts-adjacent line where we read the new option.
const CTOR_ANCHOR = '    this.enableSend = opts.enableSend !== false\n';
const CTOR_INJECT =
  CTOR_ANCHOR +
  '    this.maxMessageSize = opts.maxMessageSize || 0 // [hyperwave] 0 = off\n';

// The framing anchor: the moment in _onrawdata where the 3-byte length prefix is fully read
// (this._len is final) and it transitions to reading the body — BEFORE the allocUnsafe in state 1.
const FRAME_ANCHOR =
  '          if (this._tmp === 0x1000000) {\n' +
  '            this._tmp = 0\n' +
  '            this._state = 1\n';
const FRAME_INJECT =
  FRAME_ANCHOR +
  '            // [hyperwave] reject an oversized message at the length prefix, before allocUnsafe\n' +
  '            if (this.maxMessageSize !== 0 && this._len > this.maxMessageSize) {\n' +
  "              this.destroy(new Error('Message length (' + this._len + ') exceeds maxMessageSize (' + this.maxMessageSize + ')'))\n" +
  '              return\n' +
  '            }\n';

/**
 * Apply both injections to the secret-stream source. Pure (no I/O) so the transform is inspectable.
 * @param {string} src - The original index.js source.
 * @returns {{source: string, status: 'patched'|'already'|'anchor-missing'}} The result.
 */
function patchSource(src) {
  if (src.includes(MARKER)) {
    return { source: src, status: 'already' };
  }
  if (!src.includes(CTOR_ANCHOR) || !src.includes(FRAME_ANCHOR)) {
    return { source: src, status: 'anchor-missing' };
  }
  const next = src
    .replace(CTOR_ANCHOR, CTOR_INJECT)
    .replace(FRAME_ANCHOR, FRAME_INJECT);
  return { source: next, status: 'patched' };
}

/**
 * Patch the secret-stream at <nodeModules>/@hyperswarm/secret-stream/index.js, if present.
 * @param {string} nodeModules - A node_modules directory to look in.
 * @returns {void}
 */
function patchAt(nodeModules) {
  const file = path.join(nodeModules, REL);
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch {
    return; // not installed here — fine
  }
  const { source, status } = patchSource(src);
  const rel = path.relative(ROOT, file);
  if (status === 'already') {
    return;
  }
  if (status === 'anchor-missing') {
    console.warn(
      `[patch-secret-stream] WARNING: anchors not found in ${rel} — ` +
        'secret-stream may have changed; the maxMessageSize guard was NOT applied. ' +
        'Review scripts/patch-secret-stream.js against the installed version.'
    );
    return;
  }
  fs.writeFileSync(file, source);
  console.log(`[patch-secret-stream] applied maxMessageSize guard to ${rel}`);
}

// A directory arg scans just <dir>/node_modules (the electron-forge packaging path, which
// assembles a fresh install in the bundle); otherwise scan the root + each workspace, since npm
// may hoist secret-stream to the root or leave a copy in a workspace on a version conflict.
const target = process.argv[2];
const NODE_MODULES = target
  ? [path.join(path.resolve(target), 'node_modules')]
  : [
      path.join(ROOT, 'node_modules'),
      path.join(ROOT, 'apps', 'desktop', 'node_modules'),
      path.join(ROOT, 'packages', 'hyperwave-engine', 'node_modules')
    ];

if (require.main === module) {
  for (const nodeModules of NODE_MODULES) {
    patchAt(nodeModules);
  }
}

module.exports = { patchSource };
