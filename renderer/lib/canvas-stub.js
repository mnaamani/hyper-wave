// A minimal DOM + canvas stub, so the renderer's canvas modules can be exercised under `node
// --test` instead of only inside Electron. It is TEST-ONLY (nothing ships imports it).
//
// It records the drawing calls that carry meaning for assertions — `arc` (every ring, dot and
// badge is an arc), `fillText` (labels and the ✕) and `clearRect` — and no-ops everything else via
// a Proxy, so the module under test can call any 2D-context method without this file having to
// track the whole API.
//
// Install it BEFORE importing the module under test: renderer modules grab their canvas at module
// scope, so the globals have to exist first (use a dynamic `await import()` after `installCanvas`).

/**
 * Install the stub globals (document/window/performance/requestAnimationFrame).
 * @param {Object} [options] - Options.
 * @param {number} [options.size] - The canvas's CSS box, square, in px.
 * @param {number} [options.dpr] - devicePixelRatio to report.
 * @returns {Object} The harness handle (see below).
 */
export function installCanvas({ size = 700, dpr = 2 } = {}) {
  const handlers = {};
  const gradient = { addColorStop: () => {} };
  let calls = [];
  let clock = 1000;
  let frameCb = null;

  const recorder = {
    createRadialGradient: () => gradient,
    clearRect: (...args) => calls.push(['clearRect', ...args]),
    arc: (x, y, radius) => calls.push(['arc', x, y, radius]),
    fillText: (text, x, y) => calls.push(['fillText', text, x, y])
  };
  const ctx = new Proxy(recorder, {
    get: (target, prop) => (prop in target ? target[prop] : () => {}),
    set: () => true // the module assigns fillStyle/font/… freely; we don't care what they are
  });

  const canvas = {
    width: size,
    height: size,
    style: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: size,
      height: size
    }),
    addEventListener: (type, fn) => {
      handlers[type] = fn;
    }
  };

  globalThis.document = {
    getElementById: () => canvas,
    createElement: () => ({ set src(_value) {}, complete: false })
  };
  globalThis.window = {
    devicePixelRatio: dpr,
    ResizeObserver: class {
      observe() {}
    }
  };
  globalThis.performance = { now: () => clock };
  // Capture the callback instead of scheduling it: the test drives the clock and the frames, so a
  // render loop can be stepped deterministically rather than raced against real time.
  globalThis.requestAnimationFrame = (fn) => {
    frameCb = fn;
  };

  return {
    canvas,
    /** @returns {Array<Array>} The calls recorded during the most recent frame. */
    calls: () => calls,
    /**
     * Dispatch a DOM event the module registered for.
     * @param {string} type - Event name.
     * @param {Object} event - The event object.
     * @returns {void}
     */
    fire: (type, event) => handlers[type]?.(event),
    /**
     * Render `count` frames, advancing the stubbed clock by `dtMs` each — what a real rAF loop
     * does, minus the waiting. Only the LAST frame's calls are kept.
     * @param {number} count - How many frames.
     * @param {number} [dtMs] - Milliseconds per frame.
     * @returns {void}
     */
    frames: (count, dtMs = 16) => {
      for (let i = 0; i < count; i++) {
        clock += dtMs;
        calls = [];
        frameCb();
      }
    }
  };
}
