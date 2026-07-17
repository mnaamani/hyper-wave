// Bare ships no `fetch`, WebCrypto, `TextEncoder`, or `TextDecoder`, but cashu-ts
// (+ its @noble/* deps) need all four. This installs them from Bare ecosystem
// shims and MUST run before cashu-ts (or @noble) is imported — @noble reads
// `TextEncoder` at import time. `installBareWebShims()` is idempotent and only
// fills a global that's actually missing (a no-op under Electron's renderer/Node,
// where these exist). De-risked in spike/cashu/. CJS so the (CJS) wallet can
// require it synchronously before its dynamic import() of cashu-ts.
const crypto = require('bare-crypto');
const bareFetch = require('bare-fetch');
const BareTextDecoder = require('text-decoder');
const b4a = require('b4a');

// Minimal spec-correct UTF-8 encoder (Bare ships none). cashu secrets are
// hex/ASCII, but handle full Unicode (incl. surrogate pairs) to be safe.
class TextEncoderShim {
  get encoding() {
    return 'utf-8';
  }
  encode(input = '') {
    return new Uint8Array(b4a.from(String(input), 'utf8'));
  }
}

// Bare's `text-decoder` is a streaming push/end API, not WHATWG. Wrap it to
// expose the one-shot `.decode(bytes)` cashu-ts (+ @noble) expect.
class TextDecoderShim {
  #encoding;
  constructor(encoding = 'utf-8') {
    this.#encoding = encoding;
  }
  get encoding() {
    return this.#encoding;
  }
  decode(input) {
    if (input === undefined) {
      return '';
    }
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const decoder = new BareTextDecoder(this.#encoding);
    const head = decoder.push(bytes);
    const tail = decoder.end();
    return (head || '') + (tail || '');
  }
}

/**
 * Install the web APIs cashu-ts needs onto globalThis (only those missing).
 * Idempotent; safe to call from every CashuWallet factory invocation.
 * @returns {string[]} The names actually installed (for logging).
 */
function installBareWebShims() {
  const installed = [];
  if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = crypto.webcrypto;
    installed.push('crypto');
  }
  if (typeof globalThis.fetch === 'undefined') {
    globalThis.fetch = bareFetch;
    installed.push('fetch');
  }
  if (typeof globalThis.TextEncoder === 'undefined') {
    globalThis.TextEncoder = TextEncoderShim;
    installed.push('TextEncoder');
  }
  if (typeof globalThis.TextDecoder === 'undefined') {
    globalThis.TextDecoder = TextDecoderShim;
    installed.push('TextDecoder');
  }
  return installed;
}

module.exports = { installBareWebShims };
