// End-to-end test harness. Runs the REAL app: it spawns a local DHT bootstrap and N actual
// `bare lib/wave.run.js` peer processes, then lets a test await their log lines /
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
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const CORE_DIR = path.join(__dirname, '..') // e2e/ lives in the core package; spawn with cwd here
const BARE = process.env.BARE_BIN || 'bare' // same runtime `npm test` uses

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// One launched process (a peer or the bootstrap). Buffers stdout and exposes
// promise-based waiters over its lines and parsed `TOKEN {json}` events.
class Proc {
  constructor(name, args, env) {
    this.name = name
    this.out = ''
    this.events = [] // parsed onToken events, in order
    this._waiters = new Set() // { ready:()=>bool, value:()=>any, resolve, timer }
    // `detached` puts the child in its OWN process group. `bare` here is a Node wrapper that
    // spawns the native runtime as a child, so killing the wrapper PID alone would orphan the
    // real process (and a "killed" peer would keep running — breaking the healing test). We
    // kill the whole group instead (kill() below).
    this.proc = spawn(BARE, args, {
      cwd: CORE_DIR,
      env: { ...process.env, ...env },
      detached: true
    })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk) => this._ingest(chunk))
    this.proc.stderr.on('data', () => {}) // swallow (bare prints diagnostics here)
    this.proc.on('error', () => {})
  }

  _ingest(chunk) {
    this.out += chunk
    for (const line of chunk.split('\n')) {
      const m = line.match(/\bTOKEN (\{.*\})\s*$/)
      if (m) {
        try {
          this.events.push(JSON.parse(m[1]))
        } catch {}
      }
    }
    for (const w of [...this._waiters]) {
      if (w.ready()) {
        clearTimeout(w.timer)
        this._waiters.delete(w)
        w.resolve(w.value())
      }
    }
  }

  // On timeout, RESOLVE `false` (don't reject): the callers wrap every waiter in
  // `t.ok(await …)`, so a falsy result fails just that assertion, whereas a rejection becomes
  // an unhandled promise rejection that crashes the process and aborts the rest of the suite —
  // catastrophic for one flaky timeout. `false` (not `null`) is the safe sentinel: property
  // access on it (`draw.tickets` for the `const x = await waitForEvent()` callers) yields
  // `undefined` rather than throwing. The tail is logged as a TAP diagnostic so a timeout is
  // still diagnosable.
  _wait(ready, value, ms, what) {
    if (ready()) return Promise.resolve(value())
    return new Promise((resolve) => {
      const w = { ready, value, resolve }
      w.timer = setTimeout(() => {
        this._waiters.delete(w)
        console.error(`# ${this.name}: timed out (${ms}ms) waiting for ${what}\n` + this.tail())
        resolve(false)
      }, ms)
      this._waiters.add(w)
    })
  }

  // Resolve when the accumulated stdout matches `re`; returns the match, or `false` on timeout.
  waitForLine(re, ms = 30000) {
    return this._wait(
      () => re.test(this.out),
      () => this.out.match(re),
      ms,
      `line ${re}`
    )
  }

  // Resolve with the first onToken event named `name` (optionally matching `pred`).
  waitForEvent(name, ms = 30000, pred = () => true) {
    const find = () => this.events.find((e) => e.event === name && pred(e))
    return this._wait(() => !!find(), find, ms, `event ${name}`)
  }

  // Resolve when the gallery has reached at least `min` entries (robust to batched updates,
  // which can skip intermediate sizes). Returns the max size seen.
  waitForGallery(min, ms = 60000) {
    const max = () => {
      let mx = -1
      for (const m of this.out.matchAll(/GALLERY size=(\d+)/g)) mx = Math.max(mx, Number(m[1]))
      return mx
    }
    return this._wait(() => max() >= min, max, ms, `gallery >= ${min}`)
  }

  tail(n = 1200) {
    return `--- ${this.name} last output ---\n${this.out.slice(-n)}`
  }

  kill() {
    // negative pid → signal the whole process group (wrapper + native bare child)
    try {
      process.kill(-this.proc.pid, 'SIGKILL')
    } catch {
      try {
        this.proc.kill('SIGKILL')
      } catch {}
    }
  }
}

// A cluster = one bootstrap DHT + a shared match topic + the peers launched onto it, all under
// a throwaway temp dir. `await cluster.start()` before launching; `await cluster.destroy()` in
// the test teardown.
class Cluster {
  constructor({ lobbyMs = 5000 } = {}) {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-e2e-'))
    this.match = 'e2e-' + Math.random().toString(16).slice(2, 10)
    this.lobbyMs = String(lobbyMs)
    this.procs = []
  }

  async start() {
    this.boot = new Proc('boot', ['lib/bootstrap.js'], {})
    this.procs.push(this.boot)
    const m = await this.boot.waitForLine(/BOOTSTRAP 127\.0\.0\.1:(\d+)/, 15000)
    this.port = m[1]
    // Let the local DHT fully warm up before peers join. Without this the very first peer can
    // announce onto a half-formed DHT and end up isolated (found by nobody). Staggering the
    // peer launches (see the tests) is the matching half of reliable discovery.
    await sleep(2500)
    return this
  }

  // Launch a peer with its own storage dir. `env` overrides (START, AUTOJOIN, AUTOSELFIE,
  // WALLET, HYPERWAVE_RAFFLE_TRX, …). `seed` (a BIP39 mnemonic) is written to the storage dir's
  // `wallet.seed` so the wallet is a specific FUNDED one (for the on-chain tier); omit it for
  // the local no-wallet tier. Returns the Proc.
  launch(name, env = {}, seed = null) {
    const dir = path.join(this.root, name)
    fs.mkdirSync(dir, { recursive: true })
    if (seed) fs.writeFileSync(path.join(dir, 'wallet.seed'), seed.trim())
    const p = new Proc(name, ['lib/wave.run.js', name, dir], {
      HYPERWAVE_BOOTSTRAP: `127.0.0.1:${this.port}`,
      HYPERWAVE_MATCH: this.match,
      HYPERWAVE_LOBBY_MS: this.lobbyMs,
      ...env
    })
    this.procs.push(p)
    return p
  }

  async destroy() {
    for (const p of this.procs) p.kill()
    await new Promise((r) => setTimeout(r, 300))
    try {
      fs.rmSync(this.root, { recursive: true, force: true })
    } catch {}
  }
}

module.exports = { Cluster, Proc, sleep }
