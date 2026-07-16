// A per-connection token-bucket rate limiter (protocol.md §11). The gossip receive edge is cheap
// to reject on — but not free: every shaped frame costs a JSON.parse + an Ed25519 signature verify
// before it can be dropped, so a peer blasting validly-framed junk can burn a node's CPU. This caps
// the RATE at which a single connection can make us do that work: over-budget frames are dropped
// BEFORE the parse + verify, bounding the cost to `refillPerSec` steady (+ a `capacity` burst).
//
// It's a lazy (timer-free) bucket — the standard token-bucket refilled from elapsed wall-clock on
// each call, so there's no per-connection timer (the codebase bans setInterval, and a timer per
// peer wouldn't scale). Pure + time-injected (`allow(now)`) so it unit-tests deterministically,
// mirroring Flood; wave.js gives each connection its own bucket and clocks it with Date.now().
//
// Per-connection on purpose: the flood is epidemic, so throttling ONE noisy link never blackholes a
// message — a dropped relay simply arrives from another neighbour. A limiter shared across
// connections would let one attacker starve every honest peer's budget.

/**
 * A lazy token-bucket rate limiter: `capacity` tokens, refilled at `refillPerSec`, one spent per
 * allowed event. Time is injected (no internal clock) so it's deterministic to test.
 */
class RateLimiter {
  #capacity;
  #refillPerMs;
  #tokens;
  #last;

  /**
   * @param {Object} options - Bucket options.
   * @param {number} options.capacity - Max tokens (the burst allowance); also the starting fill.
   * @param {number} options.refillPerSec - Sustained rate tokens refill at.
   * @param {number} [options.now=0] - The current time (ms) the bucket starts from.
   */
  constructor({ capacity, refillPerSec, now = 0 }) {
    if (!(capacity > 0) || !(refillPerSec > 0)) {
      throw new Error('RateLimiter needs positive capacity + refillPerSec');
    }
    this.#capacity = capacity;
    this.#refillPerMs = refillPerSec / 1000;
    this.#tokens = capacity; // start full: a new connection's greeting burst isn't throttled
    this.#last = now;
  }

  /**
   * Charge one token for an event at time `now`. Refills lazily from the elapsed time first, then
   * consumes a token if one is available.
   * @param {number} now - The current time in ms (monotonic-ish; a backwards jump just skips refill).
   * @returns {boolean} True if the event is within budget (proceed); false if over budget (drop).
   */
  allow(now) {
    // Lazy refill from elapsed time. Guard the backwards case (a clock adjustment) so we neither
    // over-credit nor rewind `#last`.
    if (now > this.#last) {
      const refilled = this.#tokens + (now - this.#last) * this.#refillPerMs;
      this.#tokens = Math.min(this.#capacity, refilled);
      this.#last = now;
    }
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * The tokens currently available (fractional) — for diagnostics/tests.
   * @returns {number} The current token count.
   */
  get tokens() {
    return this.#tokens;
  }
}

module.exports = { RateLimiter };
