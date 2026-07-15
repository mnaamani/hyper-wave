// Worker IPC: one channel to the hyperwave Bare worker. Decodes/routes incoming
// messages by type (state / event / feed / …) to registered listeners, and exposes
// typed command senders. The rest of the renderer talks to the worker only via this.
//
// This is the theme boundary: the engine is theme-agnostic (it speaks entries / feed /
// tag / opaque payload), while this football app UI speaks selfies / gallery / country.
// The senders below translate the app's vocabulary into the engine's generic commands
// (a selfie is just an opaque {image, caption} payload; a country is just a tag).
const bridge = window.bridge;
const decoder = new TextDecoder('utf-8');
const HYPERWAVE = '/workers/hyperwave.js';

// Handlers for engine message events
const listenersByMessageType = {};

// engine -> UI events arrive over the bare-rpc seam: Electron main runs the RPC client on the
// worker pipe and pushes each engine notification here as `hw:event`. Request/response replies
// (tip-result, send-result, transactions) come through the SAME stream, so the ipc.on(...)
// handlers below stay the single consumption point — nothing in app.js changed. Attach before
// starting the worker so no early event is missed.
bridge.onHwEvent((msg) => {
  const listeners = listenersByMessageType[msg.type];
  if (listeners) {
    for (const fn of listeners) {
      fn(msg);
    }
  }
});
bridge.startWorker(HYPERWAVE);
bridge.onWorkerStdout(HYPERWAVE, (data) =>
  console.log('[hyperwave]', decoder.decode(data))
);
bridge.onWorkerStderr(HYPERWAVE, (data) =>
  console.error('[hyperwave]', decoder.decode(data))
);

// Register message handler
export function on(type, fn) {
  const handlers = listenersByMessageType[type] || [];
  handlers.push(fn);
  listenersByMessageType[type] = handlers;
}

// Send a command to the engine over the seam. Request/response commands (tip / send-trx /
// fetch-transactions) resolve with their result; the rest are fire-and-forget. Results ALSO arrive
// via onHwEvent, so callers keep consuming them through ipc.on(...).
function send(type, extra = {}) {
  return bridge.hwCall(type, extra);
}

export const startWave = () => send('start-wave');
export const joinWave = () => send('join-wave');
// the app's "country" is the engine's cosmetic peer `tag`
export const setCountry = (country) => send('set-tag', { tag: country });
// the app's selfie {image, caption} is just the engine entry's opaque `payload`
export const stageSelfie = (selfie) =>
  send('stage-entry', { entry: { payload: selfie } });
export const tip = (to, amount, peerId) => send('tip', { to, amount, peerId });
export const sendTrx = (to, amount) => send('send-trx', { to, amount });
export const refreshWallet = () => send('refresh-wallet');
export const fetchTransactions = () => send('fetch-transactions');

export const appVersion = () => bridge.pkg().version;
