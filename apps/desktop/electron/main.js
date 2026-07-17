const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  shell,
  clipboard,
  safeStorage
} = require('electron');
const os = require('os');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const bip39 = require('bip39');
const PearRuntime = require('pear-runtime');
const FramedStream = require('framed-stream');
// The client half of the bare-rpc host<->UI seam. Only lib/rpc is required (not the whole engine),
// so main doesn't pull Hyperswarm/Corestore into the Electron main process — just bare-rpc + b4a.
const { createRpcClient } = require('hyperwave-engine/lib/rpc');

const { isMac, isLinux, isWindows } = require('which-runtime');
const { command, flag } = require('paparam');
const pkg = require('../package.json');
const { name, productName, version, upgrade } = pkg;

const protocol = name;
// Should match value of 'UPDATER' in /renderer/updater.js
const updaterWorkerSpecifier = '/workers/updater.js';
// The hyperwave worker speaks the bare-rpc seam; must match the renderer's startWorker specifier.
const hyperwaveWorkerSpecifier = '/workers/hyperwave.js';

const workers = new Map();

const appName = productName ?? name;

const cmd = command(
  appName,
  flag('--storage <dir>', 'pass custom storage to pear-runtime'),
  flag('--no-updates', 'start without OTA updates'),
  flag('--no-sandbox', 'start without Chromium sandbox').hide()
);

cmd.parse(app.isPackaged ? process.argv.slice(1) : process.argv.slice(2));

// Resolve a relative --storage to absolute: app.setPath requires it, and the worker's
// bare-fs/Corestore would otherwise resolve it against a different cwd. Resolve against the
// directory the user ran the command from — npm switches cwd to the workspace (apps/desktop)
// when `npm start` delegates, but preserves the original in INIT_CWD.
const pearStore = cmd.flags.storage
  ? path.resolve(process.env.INIT_CWD || process.cwd(), cmd.flags.storage)
  : cmd.flags.storage;
const updates = cmd.flags.updates;

if (pearStore) {
  app.setPath('userData', pearStore);
}

ipcMain.on('pkg', (evt) => {
  evt.returnValue = pkg;
});

// Dev vs distributed build (false under `npm start`, true in a packaged app). The renderer uses
// this to gate a dev-only debug handle; app.isPackaged lives in main, so expose it over the bridge.
ipcMain.on('isPackaged', (evt) => {
  evt.returnValue = app.isPackaged;
});

// Copy text to the OS clipboard (e.g. the wallet address). The renderer is sandboxed, so it goes
// through main rather than navigator.clipboard.
ipcMain.handle('copy-text', (_evt, text) =>
  clipboard.writeText(String(text ?? ''))
);

// Open a URL in the user's default browser (e.g. the Nile faucet). Restricted to http(s) so a
// compromised renderer can't ask main to open file:// or other schemes.
ipcMain.handle('open-external', (_evt, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    return shell.openExternal(url);
  }
});

function getAppPath() {
  if (!app.isPackaged) {
    return null;
  }
  if (isLinux && process.env.APPIMAGE) {
    return process.env.APPIMAGE;
  }
  if (isWindows) {
    return process.execPath;
  }
  return path.join(process.resourcesPath, '..', '..');
}

function sendToAll(name, data) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(name, data);
    }
  }
}

// --- Secret store (apps/docs/secure-seed-storage.md) ---------------------------------------------
// The wallet + swarm seeds are long-lived secrets. Rather than the (Bare) worker writing them as
// plaintext files, Electron main encrypts them with the OS keychain (safeStorage — a main-process-
// only API) and injects the decrypted values into the worker over the IPC pipe. The engine is
// already injection-ready (`config.seed` / `config.swarmSeed`, used verbatim + never persisted).

// True only when the OS actually keychain-encrypts. On Linux with no keyring backend, safeStorage
// silently uses 'basic_text' (plaintext) — we treat that as unavailable so we never write a `.enc`
// file that is really cleartext (implying security we don't have); the worker keeps its own
// plaintext seed files instead (unchanged behaviour) with a warning.
function encryptionSecure() {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return false;
    }
    if (
      isLinux &&
      typeof safeStorage.getSelectedStorageBackend === 'function' &&
      safeStorage.getSelectedStorageBackend() === 'basic_text'
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Resolve one seed to inject: decrypt an existing keychain blob, else adopt a legacy plaintext seed
// file (upgrade from a pre-secure-storage build) into one, else generate a fresh secret. The `.enc`
// and any legacy plaintext live at <dir>/<name>.seed[.enc] — siblings of (not inside) the per-run
// hyperwave store the engine wipes. Best-effort: any failure logs and returns what it can.
function resolveSeed({ dir, name, generate }) {
  const encFile = path.join(dir, name + '.seed.enc');
  const plainFile = path.join(dir, name + '.seed');
  try {
    if (fs.existsSync(encFile)) {
      return safeStorage.decryptString(fs.readFileSync(encFile));
    }
  } catch (err) {
    console.error(`[seed] could not decrypt the ${name} seed:`, err.message);
  }
  // First run OR a plaintext-build upgrade: reuse an existing plaintext seed if present (its on-disk
  // format is already the injectable one — a mnemonic / 32-byte hex), else mint a new secret.
  let seed = null;
  try {
    if (fs.existsSync(plainFile)) {
      seed = fs.readFileSync(plainFile, 'utf8').trim();
    }
  } catch {}
  if (!seed) {
    seed = generate();
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(encFile, safeStorage.encryptString(seed));
    if (fs.existsSync(plainFile)) {
      // Migrated: the secret is now keychain-encrypted, so remove the plaintext copy.
      try {
        fs.rmSync(plainFile);
      } catch (err) {
        console.error(
          `[seed] could not remove the plaintext ${name} seed:`,
          err.message
        );
      }
    }
  } catch (err) {
    console.error(`[seed] could not persist the ${name} seed:`, err.message);
  }
  return seed;
}

// Resolve both seeds for injection into the worker, or {} to leave the worker on its plaintext-file
// fallback (when the OS can't encrypt). `dir` is the instance storage dir.
function resolveSeeds(dir) {
  if (!encryptionSecure()) {
    console.warn(
      '[seed] OS keychain encryption unavailable — the engine will use plaintext seed files ' +
        '(NOT encrypted). See apps/docs/secure-seed-storage.md.'
    );
    return {};
  }
  return {
    // 12-word BIP39 mnemonic — the same bip39 lib+version WDK validates/derives with.
    seed: resolveSeed({
      dir,
      name: 'wallet',
      generate: () => bip39.generateMnemonic()
    }),
    // 32-byte hex — the swarm-identity seed format loadOrCreateSwarmSeed expects.
    swarmSeed: resolveSeed({
      dir,
      name: 'swarm',
      generate: () => nodeCrypto.randomBytes(32).toString('hex')
    })
  };
}

// The chosen wallet account index (BIP-44) — persisted plain (not a secret) next to the seeds, so a
// live account switch survives a restart. Missing/garbage → 0 (the default account).
function readAccountIndex(dir) {
  try {
    const value = parseInt(
      fs.readFileSync(path.join(dir, 'wallet.account'), 'utf8').trim(),
      10
    );
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}
function writeAccountIndex(dir, index) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'wallet.account'), String(index));
  } catch (err) {
    console.error(
      '[main] could not persist the wallet account index:',
      err.message
    );
  }
}

function getWorker(specifier) {
  if (workers.has(specifier)) {
    return workers.get(specifier);
  }
  const appPath = getAppPath();
  let dir = null;
  let dirSource = null;
  if (pearStore) {
    dir = pearStore;
    dirSource = '--storage flag';
  } else if (appPath === null) {
    // Dev (`npm start`, unpackaged): getAppPath() is null, so storage is the OS temp dir — NOT
    // ~/Library/Application Support. That branch is packaged-app only.
    dir = path.join(os.tmpdir(), 'pear', appName);
    dirSource = 'default (dev: os.tmpdir)';
  } else {
    const isSnap = !!process.env.SNAP_USER_COMMON;
    const linuxConfigHome =
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    if (isMac) {
      dir = path.join(os.homedir(), 'Library', 'Application Support', appName);
    } else if (isSnap) {
      dir = path.join(process.env.SNAP_USER_COMMON, appName);
    } else if (isLinux) {
      dir = path.join(linuxConfigHome, appName);
    } else {
      dir = path.join(os.homedir(), 'AppData', 'Roaming', appName);
    }
    dirSource = 'default (packaged)';
  }

  // Resolve to absolute (a relative --storage arg resolves against cwd, same as the worker's
  // bare-fs/Corestore downstream) so the log shows the true on-disk location.
  console.log(`[main] storage dir: ${path.resolve(dir)}  (${dirSource})`);

  let extension = '.msix';
  if (isLinux) {
    extension = '.AppImage';
  } else if (isMac) {
    extension = '.app';
  }

  const worker = PearRuntime.run(require.resolve('..' + specifier), [
    dir,
    appPath,
    updates,
    version,
    upgrade,
    productName + extension
  ]);
  const pipe = new FramedStream(worker);

  function sendWorkerStdout(data) {
    sendToAll('pear:worker:stdout:' + specifier, data);
  }
  function sendWorkerStderr(data) {
    sendToAll('pear:worker:stderr:' + specifier, data);
  }
  function onBeforeQuit() {
    pipe.destroy();
  }

  // The hyperwave worker speaks the bare-rpc seam; every other worker (the updater) uses the
  // generic byte relay. For the seam, main IS the RPC client (it holds the worker's FramedStream)
  // and re-exposes it to the renderer over Electron's own IPC: `hw:call` (invoke -> reply) and a
  // one-way `hw:event` push stream. So the full request/response chain is two idiomatic hops —
  // renderer invoke -> main handle -> bare-rpc request -> worker. bare-rpc owns pipe.on('data'),
  // so we must NOT also attach the generic relay to the same pipe (it would double-consume it).
  let teardownIPC = null;
  if (specifier === hyperwaveWorkerSpecifier) {
    const client = createRpcClient({
      stream: pipe,
      onEvent: (msg) => {
        // Persist the active wallet account index (a live set-account switch reports it here) so the
        // choice survives a restart. Not a secret (just an integer) — plain file next to the seeds.
        if (
          msg &&
          msg.type === 'wallet' &&
          Number.isInteger(msg.accountIndex)
        ) {
          writeAccountIndex(dir, msg.accountIndex);
        }
        sendToAll('hw:event', msg);
      }
    });
    // Init the worker: deliver the storage dir + the keychain-decrypted seeds over the pipe (never
    // argv/env — a secret must not be visible to `ps`) + the last-chosen wallet account index. The
    // worker builds the engine on receipt (serveEngine's onBootstrap). Sent before the renderer can
    // issue any command (getWorker runs from the renderer's startWorker request, and the framed pipe
    // buffers until the worker reads).
    Promise.resolve(
      client.call('init', {
        storageDir: dir,
        config: { ...resolveSeeds(dir), accountIndex: readAccountIndex(dir) }
      })
    ).catch((err) => console.error('[main] worker init failed:', err.message));
    ipcMain.handle('hw:call', (evt, payload) =>
      client.call(payload.type, payload.args || {})
    );
    teardownIPC = () => ipcMain.removeHandler('hw:call');
  } else {
    const sendWorkerIPC = (data) =>
      sendToAll('pear:worker:ipc:' + specifier, data);
    ipcMain.handle('pear:worker:writeIPC:' + specifier, (evt, data) => {
      return pipe.write(data);
    });
    pipe.on('data', sendWorkerIPC);
    teardownIPC = () => {
      ipcMain.removeHandler('pear:worker:writeIPC:' + specifier);
      pipe.removeListener('data', sendWorkerIPC);
    };
  }

  workers.set(specifier, pipe);
  worker.stdout.on('data', sendWorkerStdout);
  worker.stderr.on('data', sendWorkerStderr);
  worker.once('exit', (code) => {
    app.removeListener('before-quit', onBeforeQuit);
    teardownIPC();
    worker.stdout.removeListener('data', sendWorkerStdout);
    worker.stderr.removeListener('data', sendWorkerStderr);
    sendToAll('pear:worker:exit:' + specifier, code);
    workers.delete(specifier);
  });
  app.on('before-quit', onBeforeQuit);
  return pipe;
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 540,
    height: 880,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // allow webcam access for the proof-window selfie capture
  win.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback) => callback(permission === 'media')
  );

  // Right-click edit menu for text fields (e.g. paste a wallet address into Send). Electron
  // ships no default context menu, so without this only the keyboard shortcuts work. Built from
  // roles (cut/copy/paste/select-all) with editing entries shown only when a field is editable.
  win.webContents.on('context-menu', (_evt, params) => {
    if (!params.isEditable && !params.selectionText) {
      return;
    }
    const items = [];
    if (params.isEditable) {
      items.push({ role: 'cut', enabled: !!params.selectionText });
    }
    if (params.isEditable || params.selectionText) {
      items.push({ role: 'copy', enabled: !!params.selectionText });
    }
    if (params.isEditable) {
      items.push({ role: 'paste' });
      items.push({ type: 'separator' });
      items.push({ role: 'selectAll' });
    }
    if (items.length) {
      Menu.buildFromTemplate(items).popup({ window: win });
    }
  });

  const devServerUrl = process.env.PEAR_DEV_SERVER_URL;

  if (devServerUrl) {
    await win.loadURL(devServerUrl);
    win.webContents.openDevTools();
    return;
  }

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

ipcMain.handle('pear:applyUpdate', () => {
  const pipe = getWorker(updaterWorkerSpecifier);

  return new Promise((resolve, reject) => {
    function onData(data) {
      const message = data.toString();

      if (message === 'pear:updateApplied') {
        pipe.removeListener('data', onData);
        resolve();
      }
    }

    pipe.on('data', onData);
    pipe.write('pear:applyUpdate');
  });
});
ipcMain.handle('pear:startWorker', (evt, filename) => {
  getWorker(filename);
  return true;
});
ipcMain.handle('app:afterUpdate', () => {
  if (isLinux && process.env.APPIMAGE) {
    app.relaunch({
      execPath: process.env.APPIMAGE,
      args: [
        '--appimage-extract-and-run',
        ...process.argv
          .slice(1)
          .filter((arg) => arg !== '--appimage-extract-and-run')
      ]
    });
  } else if (!isWindows) {
    app.relaunch();
  }
  app.quit();
});

function handleDeepLink(url) {
  console.log('deep link:', url);
}

app.setAsDefaultProtocolClient(protocol);

app.on('open-url', (evt, url) => {
  evt.preventDefault();
  handleDeepLink(url);
});

const lock = app.requestSingleInstanceLock();

if (!lock) {
  app.quit();
} else {
  app.on('second-instance', (evt, args) => {
    const url = args.find((arg) => arg.startsWith(protocol + '://'));
    if (url) {
      handleDeepLink(url);
    }
  });

  app.whenReady().then(() => {
    createWindow().catch((err) => {
      console.error('Failed to create window:', err);
      app.quit();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow().catch((err) => {
          console.error('Failed to create window:', err);
        });
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
