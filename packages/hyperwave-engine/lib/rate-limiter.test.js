// The per-connection gossip rate limiter (rate-limiter.js): a lazy token bucket. Time is injected,
// so the refill/burst behaviour is exercised deterministically (no sleeps). Runs under Bare:
//   bare lib/rate-limiter.test.js   (or `npm test`)
const test = require('brittle');
const { RateLimiter, KeyedRateLimiter } = require('./rate-limiter');

test('starts full: allows a burst up to capacity, then drops', (t) => {
  const limiter = new RateLimiter({ capacity: 5, refillPerSec: 1, now: 0 });
  for (let i = 0; i < 5; i++) {
    t.ok(limiter.allow(0), 'burst token ' + (i + 1) + ' within capacity');
  }
  t.absent(limiter.allow(0), 'the 6th at the same instant is over budget');
});

test('refills at refillPerSec over elapsed time', (t) => {
  const limiter = new RateLimiter({ capacity: 10, refillPerSec: 100, now: 0 });
  for (let i = 0; i < 10; i++) {
    limiter.allow(0); // drain the bucket
  }
  t.absent(limiter.allow(0), 'drained');
  // 100/sec = 1 token / 10ms. After 50ms, ~5 tokens are back.
  t.ok(limiter.allow(50), 'a token refilled after 50ms');
  for (let i = 0; i < 4; i++) {
    t.ok(limiter.allow(50), 'the rest of the ~5 refilled tokens');
  }
  t.absent(limiter.allow(50), 'but not a 6th — refill is rate-bounded');
});

test('refill clamps at capacity (a long idle never over-credits)', (t) => {
  const limiter = new RateLimiter({ capacity: 3, refillPerSec: 1000, now: 0 });
  limiter.allow(0);
  // idle 10 minutes: refill would be enormous, but the bucket caps at capacity
  t.ok(limiter.allow(600000));
  t.ok(limiter.allow(600000));
  t.ok(limiter.allow(600000));
  t.absent(limiter.allow(600000), 'never more than `capacity` in reserve');
});

test('a sustained blast is throttled to ~refillPerSec', (t) => {
  const limiter = new RateLimiter({ capacity: 50, refillPerSec: 50, now: 0 });
  let allowed = 0;
  // hammer 10000 times/sec for 1 second (10 calls per ms) — a DoS blast
  for (let ms = 0; ms <= 1000; ms++) {
    for (let i = 0; i < 10; i++) {
      if (limiter.allow(ms)) {
        allowed++;
      }
    }
  }
  // ~capacity (initial burst) + ~refillPerSec*1s sustained ≈ 100, not the 10010 attempted
  t.ok(
    allowed <= 110,
    'blast capped near capacity + 1s of refill (got ' + allowed + ')'
  );
  t.ok(allowed >= 90, 'but the honest steady rate still gets through');
});

test('a backwards clock jump neither crashes nor over-credits', (t) => {
  const limiter = new RateLimiter({ capacity: 2, refillPerSec: 1, now: 1000 });
  t.ok(limiter.allow(1000));
  t.ok(limiter.allow(1000));
  t.absent(limiter.allow(1000), 'drained at t=1000');
  t.absent(limiter.allow(500), 'a jump back in time gives no free tokens');
});

test('rejects a non-positive config', (t) => {
  t.exception(
    () => new RateLimiter({ capacity: 0, refillPerSec: 1 }),
    /positive/
  );
  t.exception(
    () => new RateLimiter({ capacity: 5, refillPerSec: 0 }),
    /positive/
  );
});

test('KeyedRateLimiter: each key gets an independent budget', (t) => {
  const limiter = new KeyedRateLimiter({
    capacity: 2,
    refillPerSec: 1,
    maxKeys: 10
  });
  t.ok(limiter.allow('a', 0), 'a: 1');
  t.ok(limiter.allow('a', 0), 'a: 2');
  t.absent(limiter.allow('a', 0), 'a is over budget');
  // a spammy key does not eat another key's allowance
  t.ok(limiter.allow('b', 0), 'b still has its own full budget');
  t.ok(limiter.allow('b', 0), 'b: 2');
  t.absent(limiter.allow('b', 0), 'b now over budget too');
});

test('KeyedRateLimiter: LRU-evicts the least-recently-used key past maxKeys', (t) => {
  const limiter = new KeyedRateLimiter({
    capacity: 1,
    refillPerSec: 1,
    maxKeys: 2
  });
  limiter.allow('a', 0); // drains a
  limiter.allow('b', 0); // drains b
  t.is(limiter.size, 2, 'two keys tracked');
  // touch 'a' so 'b' becomes the least-recently-used, then add 'c' → 'b' is evicted
  t.absent(limiter.allow('a', 0), 'a still drained (touch refreshes recency)');
  limiter.allow('c', 0); // over maxKeys → evicts the LRU key (b); tracked = {a, c}
  t.is(limiter.size, 2, 'still bounded at maxKeys');
  // 'a' was kept, so it stays throttled — assert BEFORE re-adding 'b' (which would evict 'a')
  t.absent(limiter.allow('a', 0), 'the retained key keeps its throttle state');
  // 'b' was evicted, so it comes back with a FRESH full bucket
  t.ok(limiter.allow('b', 0), 'evicted key returns with a fresh budget');
});

test('KeyedRateLimiter: rejects a non-positive maxKeys', (t) => {
  t.exception(
    () => new KeyedRateLimiter({ capacity: 1, refillPerSec: 1, maxKeys: 0 }),
    /maxKeys/
  );
});
