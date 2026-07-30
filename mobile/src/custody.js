// Custody + durability for the mobile host — the RN counterpart of electron/main.js's secret store
// (docs/secure-seed-storage.md). The Bare worklet never mints or persists a secret: this module
// resolves the two long-lived seeds from the OS keychain (expo-secure-store, backed by iOS Keychain
// / Android Keystore) and a PERSISTENT storage directory, then the host passes both to the worklet
// in the `init` command — exactly as Electron main injects them over its IPC pipe.
//
// Why it matters here more than on desktop: Cashu proofs are BEARER funds. They live at
// <storageDir>/cashu-proofs.json (cashu-wallet.js), outside the per-run hyperwave store the engine
// wipes on boot. The scaffold used to resolve storage under os.tmpdir() inside the worklet, which
// the OS may purge — a topped-up phone wallet could silently vanish. The document directory is the
// iOS/Android "safe from the system" location, so funds and the swarm identity survive a restart.
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Directory, File, Paths } from 'expo-file-system';

// Keychain entries. The values are injected verbatim into the engine (config.seed /
// config.swarmSeed) and never written to disk by the worklet.
const WALLET_SEED_KEY = 'hyperwave.wallet.seed';
const SWARM_SEED_KEY = 'hyperwave.swarm.seed';
// Instance storage: a subdirectory of the document dir, so the app's own files stay separable.
const STORAGE_SUBDIR = 'hyperwave';
// The chosen Cashu mint — NOT a secret, so it sits as a plain file next to the store (mirroring
// desktop's <dir>/cashu.mint) rather than in the keychain.
const MINT_FILE = 'cashu.mint';
// The chosen country (the engine's cosmetic peer `tag`) — a preference, not a secret.
const COUNTRY_FILE = 'country';

const HEX_SEED_BYTES = 32;

function toHex(bytes) {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

// expo-file-system speaks `file:///…` URIs; bare-fs (in the worklet) wants a plain absolute path.
function pathOfUri(uri) {
  const withoutScheme = uri.startsWith('file://')
    ? uri.slice('file://'.length)
    : uri;
  const decoded = decodeURI(withoutScheme);
  return decoded.endsWith('/') ? decoded.slice(0, -1) : decoded;
}

function storageDirectory() {
  const dir = new Directory(Paths.document, STORAGE_SUBDIR);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/**
 * The instance storage dir, as an absolute filesystem path for the worklet's `init.storageDir`.
 * Persistent (document directory): the Cashu proof ledger + seed files under it survive restarts;
 * only the `hyperwave/` Corestore inside it is wiped per run by the engine.
 * @returns {string} Absolute path, e.g. /var/mobile/…/Documents/hyperwave.
 */
export function resolveStorageDir() {
  return pathOfUri(storageDirectory().uri);
}

// Read one keychain-held seed, minting + storing it on first run. Both seeds are 32-byte hex: the
// Cashu wallet accepts a hex seed (no BIP39 needed — that is a WDK/Tron requirement), and the
// engine's loadOrCreateSwarmSeed expects 32-byte hex.
async function resolveSeed(key) {
  const existing = await SecureStore.getItemAsync(key);
  if (existing && existing.trim()) {
    return existing.trim();
  }
  const minted = toHex(Crypto.getRandomBytes(HEX_SEED_BYTES));
  await SecureStore.setItemAsync(key, minted, {
    // Available after first unlock, on this device only — never synced to another device or a
    // backup, so bearer funds can't be silently cloned.
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
  });
  return minted;
}

/**
 * Resolve both long-lived seeds for injection into the worklet. Best-effort: if the keychain is
 * unavailable the engine falls back to its own plaintext seed files (same behaviour as desktop
 * without a keyring backend), so a wallet still works — just less securely.
 * @returns {Promise<{seed?: string, swarmSeed?: string}>} Injectable engine config fragment.
 */
export async function resolveSeeds() {
  try {
    const seed = await resolveSeed(WALLET_SEED_KEY);
    const swarmSeed = await resolveSeed(SWARM_SEED_KEY);
    return { seed, swarmSeed };
  } catch (err) {
    console.warn(
      '[custody] keychain unavailable — the engine will use plaintext seed files:',
      err.message
    );
    return {};
  }
}

// Plain (non-secret) preferences kept as small files next to the store, mirroring desktop's
// <dir>/cashu.mint. The keychain is for secrets only.
function readPref(name) {
  try {
    const file = new File(storageDirectory(), name);
    if (!file.exists) {
      return undefined;
    }
    const value = file.textSync().trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function writePref(name, value) {
  try {
    const file = new File(storageDirectory(), name);
    if (!file.exists) {
      file.create();
    }
    file.write(String(value));
  } catch (err) {
    console.warn(`[custody] could not persist ${name}:`, err.message);
  }
}

/**
 * The peer's chosen Cashu mint, so a live `set-wallet-options` switch survives a restart.
 * @returns {string|undefined} The mint URL, or undefined for the wallet's default.
 */
export function readMint() {
  return readPref(MINT_FILE);
}

/**
 * Persist the active Cashu mint (called when the engine reports one on a `wallet` message).
 * @param {string} mint - The mint URL.
 * @returns {void}
 */
export function writeMint(mint) {
  writePref(MINT_FILE, mint);
}

/**
 * The peer's chosen country — the engine's cosmetic peer `tag`, asked once at onboarding.
 * @returns {string|undefined} The ISO 3166-1 alpha-2 code, or undefined if never chosen.
 */
export function readCountry() {
  return readPref(COUNTRY_FILE);
}

/**
 * Persist the chosen country so onboarding is asked once.
 * @param {string} code - The ISO code.
 * @returns {void}
 */
export function writeCountry(code) {
  writePref(COUNTRY_FILE, code);
}
