// Bare/Pear compatibility shim (runs as postinstall, under Node).
//
// Some deps (notably @noble/hashes and @noble/curves, pulled in transitively by WDK)
// declare `engines.node` as a semver RANGE with `^`/`||`, e.g. "^14.21.3 || >=16". When
// the app runs under **pear-runtime** (the GUI's Bare), `bare-module-resolve` validates
// each package's `engines` against `Bare.versions` — and Bare's minimal `bare-semver`
// range parser doesn't understand `^` or `||`, so it throws:
//   INVALID_VERSION: Unexpected token '^' in '^14.21.3 || >=16' ...
// (Standalone `bare` doesn't set `Bare.versions.node`, so the check is skipped there —
// which is why headless works but the GUI/pear-runtime crashes on wallet init.)
//
// `engines` is advisory metadata; the code runs fine under Bare. So we normalize any
// engines value bare-semver can't parse to a permissive, parseable range. Idempotent.
const fs = require('fs')
const path = require('path')

const NODE_MODULES = path.join(__dirname, '..', 'node_modules')
const SAFE = '>=0.0.0' // always satisfied — removes the (advisory) constraint, stays parseable

// Use bare-semver ITSELF as the oracle: a range is a problem iff bare-semver can't parse it
// (the same check the pear-runtime resolver runs). Covers `^`, `||`, `~`, `x`, spaces after
// operators (`>= 16`), hyphen ranges, etc. — no need to enumerate the syntaxes by hand.
let semver = null
let probe = null // a high version so `satisfies` reaches (and eagerly parses) the range
try {
  semver = require('bare-semver')
  probe = new semver.Version(999, 0, 0)
} catch {}

function bareCanParse(range) {
  if (!semver || !probe) return true // no oracle available — leave it alone
  try {
    semver.satisfies(probe, range) // throws INVALID_VERSION iff the range is unparseable
    return true
  } catch {
    return false
  }
}

function walk(dir, depth = 0) {
  if (depth > 6) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const full = path.join(dir, e.name)
    if (e.name === '.bin') continue
    // recurse into scopes (@scope/) and nested node_modules
    if (e.name.startsWith('@')) {
      walk(full, depth)
      continue
    }
    fixPackage(full)
    const nested = path.join(full, 'node_modules')
    if (fs.existsSync(nested)) walk(nested, depth + 1)
  }
}

let fixed = 0
function fixPackage(pkgDir) {
  const file = path.join(pkgDir, 'package.json')
  let json
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return
  }
  const eng = json.engines
  if (!eng || typeof eng !== 'object') return
  let changed = false
  for (const [k, v] of Object.entries(eng)) {
    if (typeof v === 'string' && !bareCanParse(v)) {
      eng[k] = SAFE
      changed = true
    }
  }
  if (changed) {
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n')
    fixed++
    console.log(`[fix-bare-engines] normalized engines in ${path.relative(NODE_MODULES, file)}`)
  }
}

if (fs.existsSync(NODE_MODULES)) {
  walk(NODE_MODULES)
  console.log(`[fix-bare-engines] done (${fixed} package.json normalized)`)
}
