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
//  - `wave.run.js` already prints structured events as `[name] EVENT {json}`; we parse those,
//    so assertions read against the protocol's own event stream, not brittle prose.
//  - Teardown kills tracked PIDs (never `pkill`), so it can't touch unrelated processes.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const CORE_DIR = path.join(__dirname, '..'); // e2e/ lives in the core package; spawn with cwd here
const BARE = process.env.BARE_BIN || 'bare'; // same runtime `npm test` uses

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every spawned Proc, tracked so we can GUARANTEE cleanup even when a test times out or throws
// before its teardown runs. brittle aborts a timed-out test without unwinding t.teardown, so
// cluster.destroy() never fired and the detached peer processes were orphaned — they piled up across
// reruns and stole CPU (badly skewing later runs). A synchronous process-exit hook is the backstop:
// it kills every still-live process group on the way out. Normal teardown still runs first and clears
// the registry, so this only ever mops up what a crash/timeout left behind.
const LIVE_PROCS = new Set();
let exitHooksInstalled = false;

/** SIGKILL a detached child's whole process group (wrapper + native bare child); falls back to the pid. */
function killProcGroup(proc) {
  try {
    process.kill(-proc.pid, 'SIGKILL'); // negative pid → the whole group
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {}
  }
}

/**
 * Kill every still-tracked process group. Synchronous (safe to call from a process 'exit' hook).
 * If E2E_DUMP=<dir> is set, first write each peer's full stdout there — the harness normally only
 * surfaces the timed-out peer's short tail, so this is how you get CI-level per-peer visibility into
 * a failure (which peer got skipped, who healed, etc.) locally: `E2E_DUMP=/tmp/e2e npm run ...`.
 */
function killAllProcs() {
  const dumpDir = process.env.E2E_DUMP;
  if (dumpDir) {
    try {
      fs.mkdirSync(dumpDir, { recursive: true });
    } catch {}
  }
  for (const entry of LIVE_PROCS) {
    if (dumpDir) {
      try {
        fs.writeFileSync(path.join(dumpDir, entry.name + '.log'), entry.out);
      } catch {}
    }
    killProcGroup(entry.proc);
  }
  LIVE_PROCS.clear();
}

/** Install the process-exit backstop once: kill any surviving peers on normal exit or a signal. */
function installExitHooks() {
  if (exitHooksInstalled) {
    return;
  }
  exitHooksInstalled = true;
  process.on('exit', killAllProcs); // sync; fires on normal exit AND after a timed-out test aborts
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      killAllProcs();
      process.exit(1);
    });
  }
}

// One launched process (a peer or the bootstrap). Buffers stdout and exposes
// promise-based waiters over its lines and parsed `EVENT {json}` events.
class Proc {
  #waiters = new Set(); // { ready:()=>bool, value:()=>any, resolve, timer }

  constructor(name, args, env) {
    this.name = name;
    this.out = '';
    this.events = []; // parsed onEvent events, in order
    // `detached` puts the child in its OWN process group. `bare` here is a Node wrapper that
    // spawns the native runtime as a child, so killing the wrapper PID alone would orphan the
    // real process (and a "killed" peer would keep running — breaking the kill test). We
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
    installExitHooks(); // guarantee this process group is killed even if a test times out
    LIVE_PROCS.add(this);
  }

  #ingest(chunk) {
    this.out += chunk;
    for (const line of chunk.split('\n')) {
      const eventMatch = line.match(/\bEVENT (\{.*\})\s*$/);
      if (eventMatch) {
        try {
          this.events.push(JSON.parse(eventMatch[1]));
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
        console.error(
          `# ${this.name}: timed out (${ms}ms) waiting for ${what}\n` +
            this.tail()
        );
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
    const find = () =>
      this.events.find((evt) => evt.event === name && pred(evt));
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
    LIVE_PROCS.delete(this);
    killProcGroup(this.proc); // negative pid → the whole group (wrapper + native bare child)
  }
}

// A cluster = one bootstrap DHT + a shared match topic + the peers launched onto it, all under
// a throwaway temp dir. `await cluster.start()` before launching; `await cluster.destroy()` in
// the test teardown.
//
// E2E_PUBLIC=1: skip the local testnet DHT and run the peers on the PUBLIC DHT instead (still
// isolated — the match topic is random per cluster). A diagnostic knob: the local 3-node testnet
// is its own scenario (fresh nodes, loopback firewall/holepunch quirks), and failures there don't
// necessarily reproduce on the real network — the desktop app runs multi-instance on one machine
// over the public DHT flawlessly. Public discovery on a cold topic takes ~20-35s, so expect
// slower (but more production-faithful) runs.
class Cluster {
  constructor({ lobbyMs = 5000 } = {}) {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-e2e-'));
    const randomHex = Math.random().toString(16);
    this.match = 'e2e-' + randomHex.slice(2, 10);
    this.lobbyMs = String(lobbyMs);
    this.public = process.env.E2E_PUBLIC === '1';
    this.procs = [];
  }

  async start() {
    if (this.public) {
      return this; // public DHT: no local bootstrap to spin up
    }
    this.boot = new Proc('boot', ['bin/dht-local.js'], {});
    this.procs.push(this.boot);
    const bootMatch = await this.boot.waitForLine(
      /BOOTSTRAP 127\.0\.0\.1:(\d+)/,
      15000
    );
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
      // public mode: omit HYPERWAVE_BOOTSTRAP so peers use the public DHT (random topic isolates us)
      ...(this.public ? {} : { HYPERWAVE_BOOTSTRAP: `127.0.0.1:${this.port}` }),
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
  return Promise.race(procs.map((proc) => proc.waitForGallery(min, ms))).then(
    Boolean
  );
}

module.exports = { Cluster, Proc, sleep, waitForAnyGallery };
