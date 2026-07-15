// The host <-> UI IPC seam, built on bare-rpc (github.com/holepunchto/librpc-compatible RPC over
// a duplex stream). This is NOT the on-wire gossip protocol (that stays JSON-over-Protomux between
// peers — see docs/protocol.md); it is the *internal app IPC* between a UI (the desktop Electron
// main / the mobile RN JS) and the engine host that runs createEngine (the Bare worker / worklet).
//
// It exists to fix two sharp edges of the raw pipe: (1) request/response commands (tip / send /
// fetch-transactions) were faked by matching a later result message by its `to`/`hash` field —
// fragile with two calls in flight; bare-rpc correlates request<->reply natively, so the UI gets
// `await client.call('tip', …)`. (2) A single typed seam both hosts import, so the command/event
// shapes can't drift between the desktop and mobile paths.
//
// Encoding stays JSON (CLAUDE.md: one encoding). bare-rpc only frames it and adds the numeric
// command tag + reply correlation. The engine's own exec()/emit() vocabulary is untouched — this
// module just marshals it across the stream.
const RPC = require('bare-rpc');
const b4a = require('b4a');

// bare-rpc dispatches on a numeric command. We use exactly two channels; the real message `type`
// rides inside the JSON body, so the engine's string-typed vocabulary is unchanged and these
// numbers only tag direction.
const CALL = 1; // UI -> engine command:      JSON { type, ...args }
const EVENT = 2; // engine -> UI notification: JSON emit() message

// Commands whose result the caller awaits (request/response). Everything else is fire-and-forget.
// The single source of truth both ends import, so the host and the client never disagree on which
// calls carry a reply. These are exactly the engine commands whose handler emits ONE terminal
// result message (tip-result / send-result / transactions); the rest report progress only as
// out-of-band events (e.g. start-wave's burn-result stages) or nothing.
const REQUEST_REPLY = new Set(['tip', 'send-trx', 'fetch-transactions']);

function decodeJson(buffer) {
  if (!buffer) {
    return null;
  }
  try {
    return JSON.parse(b4a.toString(buffer));
  } catch {
    return null;
  }
}

/**
 * Host side of the seam (runs where createEngine runs: the Bare worker / worklet). Adapts a
 * bare-rpc instance to drive an engine and stream its notifications back. Two-step wiring breaks
 * the emit<->engine cycle: build the seam, create the engine with `seam.emit`, then
 * `seam.attach(engine)`.
 *
 * `onBootstrap` supports hosts that can't build the engine until a first message arrives (the
 * mobile worklet learns its storageDir from an `init` command over this same pipe). When set, any
 * command that arrives before an engine is attached is handed to it instead of being dropped — the
 * host constructs the engine and calls `attach`. A host that builds its engine eagerly (the desktop
 * worker, from argv) omits it.
 * @param {Object} options
 * @param {Object} options.stream - The duplex IPC stream (e.g. FramedStream(Bare.IPC)).
 * @param {(command: Object) => void} [options.onBootstrap] - Handles a command that arrives before
 *   an engine is attached (lazy construction). Omit for eager hosts.
 * @returns {{ emit: (msg: Object) => void, attach: (engine: Object) => void, rpc: Object,
 *   close: () => void }}
 */
function serveEngine({ stream, onBootstrap }) {
  // correlation id -> the IncomingRequest awaiting its result. Only request/response calls land
  // here, and each produces exactly one terminal result, so entries never accumulate.
  const pending = new Map();
  let seq = 0;
  let engine = null;

  const rpc = new RPC(stream, (req) => {
    if (req.command !== CALL) {
      return;
    }
    const command = decodeJson(req.data);
    // An IncomingRequest has a positive `id` and awaits a reply; an IncomingEvent (fire-and-
    // forget) does not. Never leave a request hanging — reply even on the error paths.
    const wantsReply = typeof req.id === 'number' && req.id > 0;
    if (!command) {
      if (wantsReply) {
        req.reply(
          JSON.stringify({ type: 'error', error: 'malformed command' })
        );
      }
      return;
    }
    if (!engine) {
      // No engine yet: hand the command to the bootstrap hook (which builds + attaches one), or
      // reject if there's none. The bootstrap command itself is consumed, not exec'd.
      if (onBootstrap) {
        onBootstrap(command);
        return;
      }
      if (wantsReply) {
        req.reply(JSON.stringify({ type: 'error', error: 'engine not ready' }));
      }
      return;
    }
    if (!wantsReply) {
      engine.exec(command);
      return;
    }
    // Tag this call with an internal correlation id; the engine echoes it on the terminal result
    // (see engine.js handleTip), which `emit` below matches back to this exact request — so two
    // tips in flight can't cross their replies.
    const id = 'rpc:' + ++seq;
    pending.set(id, req);
    engine.exec({ ...command, id });
  });

  // engine -> UI. A correlated result replies to its pending request (and is NOT also pushed as an
  // event); everything else streams to the UI as a one-way EVENT (no reply lifecycle — bare-rpc's
  // `event` primitive, so a high-frequency stream like `position` can't leak request state).
  function emit(msg) {
    if (msg && msg.id !== null && pending.has(msg.id)) {
      const req = pending.get(msg.id);
      pending.delete(msg.id);
      // strip the internal correlation id — the UI relies on bare-rpc's own request<->reply
      // matching and never sees it.
      const result = { ...msg };
      delete result.id;
      req.reply(JSON.stringify(result));
      return;
    }
    rpc.event(EVENT).send(JSON.stringify(msg));
  }

  function close() {
    for (const req of pending.values()) {
      try {
        req.reply(JSON.stringify({ type: 'error', error: 'seam closed' }));
      } catch {
        // stream already gone — nothing to unblock
      }
    }
    pending.clear();
  }

  return {
    emit,
    attach(createdEngine) {
      engine = createdEngine;
    },
    rpc,
    close
  };
}

/**
 * Client side of the seam (runs in the UI: desktop Electron main / mobile RN JS). Exposes a single
 * `call(type, args)` — awaitable for request/response commands, fire-and-forget otherwise — plus an
 * `onEvent` stream of the engine's notifications.
 *
 * A request/response reply is ALSO surfaced through `onEvent` (not just returned), so an
 * event-oriented UI — the desktop `ipc.on('tip-result', …)`, the RN message switch — consumes tip /
 * send / transactions results with no change, while bare-rpc still correlates each reply to its
 * exact call under the hood. Callers that prefer the awaitable form just use the return value.
 * @param {Object} options
 * @param {Object} options.stream - The duplex IPC stream to the host.
 * @param {(msg: Object) => void} [options.onEvent] - Called with each engine notification (and each
 *   request/response reply).
 * @returns {{ call: (type: string, args?: Object) => Promise<Object|undefined>, rpc: Object }}
 */
function createRpcClient({ stream, onEvent = () => {} }) {
  const rpc = new RPC(stream, (req) => {
    if (req.command !== EVENT) {
      return;
    }
    const msg = decodeJson(req.data);
    if (msg) {
      onEvent(msg);
    }
  });

  async function call(type, args = {}) {
    const body = JSON.stringify({ type, ...args });
    if (!REQUEST_REPLY.has(type)) {
      rpc.event(CALL).send(body); // fire-and-forget: no reply lifecycle
      return undefined;
    }
    const req = rpc.request(CALL);
    req.send(body);
    const replyBuf = await req.reply();
    const text = replyBuf ? b4a.toString(replyBuf) : '';
    const result = text ? JSON.parse(text) : undefined;
    if (result) {
      onEvent(result); // deliver to event-oriented consumers too (see the doc note above)
    }
    return result;
  }

  return { call, rpc };
}

module.exports = {
  CALL,
  EVENT,
  REQUEST_REPLY,
  serveEngine,
  createRpcClient
};
