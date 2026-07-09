// End-to-end test harness. Runs the REAL app: it spawns a local DHT bootstrap and N actual
// `bare bin/wave.run.js` peer processes, then lets a test await their log lines /
// structured events (instead of sleeping) and asserts on the outcome. The harness itself runs
// under Node (for ergonomic child-process orchestration); the processes under test are Bare —
// the same binary the app ships. Used by e2e/*.e2e.js, run with `npm run test:e2e:local`.
//
// Design notes:
//  - No fixed sleeps. `waitForEvent` / `waitForLine` / `waitForGallery` resolve the instant the
//    condition is met, or resolve `false` (logging the output tail as a diagnostic) on timeout —
//    fast AND non-flaky. Resolving falsy (not rejecting) means a timed-out `t.ok(await …)` fails
//    just its own assertion instead of crashing the whole run with an unhandled rejection.
//  - `wave.run.js` already prints structured events as `[name] TOKEN {json}`; we parse those,
//    so assertions read against the protocol's own event stream, not brittle prose.
//  - Teardown kills tracked PIDs (never `pkill`), so it can't touch unrelated processes.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const CORE_DIR = path.join(__dirname, '..'); // e2e/ lives in the core package; spawn with cwd here
const BARE = process.env.BARE_BIN || 'bare'; // same runtime `npm test` uses

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One launched process (a peer or the bootstrap). Buffers stdout and exposes
// promise-based waiters over its lines and parsed `TOKEN {json}` events.
class Proc {
  #waiters = new Set(); // { ready:()=>bool, value:()=>any, resolve, timer }

  constructor(name, args, env) {
    this.name = name;
    this.out = '';
    this.events = []; // parsed onEvent events, in order
    // `detached` puts the child in its OWN process group. `bare` here is a Node wrapper that
    // spawns the native runtime as a child, so killing the wrapper PID alone would orphan the
    // real process (and a "killed" peer would keep running — breaking the healing test). We
    // kill the whole group instead (kill() below).
    this.proc = spawn(BARE, args, {
      cwd: CORE_DIR,
      env: { ...process.env, ...env },
      detached: true
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.#ingest(chunk));
    this.proc.stderr.on('data', () => {}); // swallow (bare prints diagnostics here)
    this.proc.on('error', () => {});
  }

  #ingest(chunk) {
    this.out += chunk;
    for (const line of chunk.split('\n')) {
      const tokenMatch = line.match(/\bTOKEN (\{.*\})\s*$/);
      if (tokenMatch) {
        try {
          this.events.push(JSON.parse(tokenMatch[1]));
        } catch {}
      }
    }
    for (const waiter of [...this.#waiters]) {
      if (waiter.ready()) {
        clearTimeout(waiter.timer);
        this.#waiters.delete(waiter);
        waiter.resolve(waiter.value());
      }
    }
  }

  // On timeout, RESOLVE `false` (don't reject): the callers wrap every waiter in
  // `t.ok(await …)`, so a falsy result fails just that assertion, whereas a rejection becomes
  // an unhandled promise rejection that crashes the process and aborts the rest of the suite —
  // catastrophic for one flaky timeout. `false` (not `null`) is the safe sentinel: property
  // access on it (`evt.hops` for the `const x = await waitForEvent()` callers) yields
  // `undefined` rather than throwing. The tail is logged as a TAP diagnostic so a timeout is
  // still diagnosable.
  #wait(ready, value, ms, what) {
    if (ready()) {
      return Promise.resolve(value());
    }
    return new Promise((resolve) => {
      const waiter = { ready, value, resolve };
      waiter.timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        console.error(`# ${this.name}: timed out (${ms}ms) waiting for ${what}\n` + this.tail());
        resolve(false);
      }, ms);
      this.#waiters.add(waiter);
    });
  }

  // Resolve when the accumulated stdout matches `re`; returns the match, or `false` on timeout.
  waitForLine(re, ms = 30000) {
    return this.#wait(
      () => re.test(this.out),
      () => this.out.match(re),
      ms,
      `line ${re}`
    );
  }

  // Resolve with the first onEvent event named `name` (optionally matching `pred`).
  waitForEvent(name, ms = 30000, pred = () => true) {
    const find = () => this.events.find((evt) => evt.event === name && pred(evt));
    return this.#wait(() => !!find(), find, ms, `event ${name}`);
  }

  // Resolve when the gallery has reached at least `min` entries (robust to batched updates,
  // which can skip intermediate sizes). Returns the max size seen.
  waitForGallery(min, ms = 60000) {
    const max = () => {
      let maxSize = -1;
      for (const match of this.out.matchAll(/GALLERY size=(\d+)/g)) {
        maxSize = Math.max(maxSize, Number(match[1]));
      }
      return maxSize;
    };
    return this.#wait(() => max() >= min, max, ms, `gallery >= ${min}`);
  }

  tail(chars = 1200) {
    return `--- ${this.name} last output ---\n${this.out.slice(-chars)}`;
  }

  kill() {
    // negative pid → signal the whole process group (wrapper + native bare child)
    try {
      process.kill(-this.proc.pid, 'SIGKILL');
    } catch {
      try {
        this.proc.kill('SIGKILL');
      } catch {}
    }
  }
}

// A cluster = one bootstrap DHT + a shared match topic + the peers launched onto it, all under
// a throwaway temp dir. `await cluster.start()` before launching; `await cluster.destroy()` in
// the test teardown.
class Cluster {
  constructor({ lobbyMs = 5000 } = {}) {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-e2e-'));
    this.match = 'e2e-' + Math.random().toString(16).slice(2, 10);
    this.lobbyMs = String(lobbyMs);
    this.procs = [];
  }

  async start() {
    this.boot = new Proc('boot', ['bin/dht-local.js'], {});
    this.procs.push(this.boot);
    const bootMatch = await this.boot.waitForLine(/BOOTSTRAP 127\.0\.0\.1:(\d+)/, 15000);
    this.port = bootMatch[1];
    // Let the local DHT fully warm up before peers join. Without this the very first peer can
    // announce onto a half-formed DHT and end up isolated (found by nobody). Staggering the
    // peer launches (see the tests) is the matching half of reliable discovery.
    await sleep(2500);
    return this;
  }

  // Launch a peer with its own storage dir. `env` overrides (START, AUTOJOIN, AUTOSELFIE,
  // WALLET, …). `seed` (a BIP39 mnemonic) is written to the storage dir's
  // `wallet.seed` so the wallet is a specific FUNDED one (for the on-chain tier); omit it for
  // the local no-wallet tier. Returns the Proc.
  launch(name, env = {}, seed = null) {
    const dir = path.join(this.root, name);
    fs.mkdirSync(dir, { recursive: true });
    if (seed) {
      fs.writeFileSync(path.join(dir, 'wallet.seed'), seed.trim());
    }
    const proc = new Proc(name, ['bin/wave.run.js', name, dir], {
      HYPERWAVE_BOOTSTRAP: `127.0.0.1:${this.port}`,
      HYPERWAVE_MATCH: this.match,
      HYPERWAVE_LOBBY_MS: this.lobbyMs,
      ...env
    });
    this.procs.push(proc);
    return proc;
  }

  async destroy() {
    for (const proc of this.procs) {
      proc.kill();
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      fs.rmSync(this.root, { recursive: true, force: true });
    } catch {}
  }
}

// Resolve true when ANY of `procs` reaches `min` gallery entries, else false within `ms`. Use
// when the assertion is "the writes converged into a shared gallery" and no single peer is a
// guaranteed hub — e.g. under churn, the slowest node to converge shouldn't fail the test.
// (waitForGallery only ever settles truthy on success / false on timeout, so racing is sound.)
function waitForAnyGallery(procs, min, ms = 60000) {
  return Promise.race(procs.map((proc) => proc.waitForGallery(min, ms))).then(Boolean);
}

module.exports = { Cluster, Proc, sleep, waitForAnyGallery };
