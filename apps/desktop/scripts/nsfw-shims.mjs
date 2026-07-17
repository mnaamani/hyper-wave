// Browser shims for the Node globals nsfwjs + tfjs reference — injected by esbuild (build-nsfw.mjs)
// so the classifier bundle runs in the sandboxed renderer, where `Buffer`/`process` are undefined
// (an unshimmed reference throws at load, and the IIFE never sets its global). `buffer` is a real
// package (nsfwjs's peer dependency, used to base64-decode the embedded model weights); `process`
// is a minimal stub so `process.env.NODE_ENV`-style checks resolve. `global` is mapped to
// `globalThis` via esbuild `define`, not here.
import { Buffer } from 'buffer';

const process = { env: { NODE_ENV: 'production' }, browser: true };

export { Buffer, process };
