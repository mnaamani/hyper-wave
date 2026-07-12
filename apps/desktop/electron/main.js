const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  shell,
  clipboard
} = require('electron');
const os = require('os');
const path = require('path');
const PearRuntime = require('pear-runtime');
const FramedStream = require('framed-stream');

const { isMac, isLinux, isWindows } = require('which-runtime');
const { command, flag } = require('paparam');
const pkg = require('../package.json');
const { name, productName, version, upgrade } = pkg;

const protocol = name;
// Should match value of 'UPDATER' in /renderer/updater.js
const updaterWorkerSpecifier = '/workers/updater.js';

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
  function sendWorkerIPC(data) {
    sendToAll('pear:worker:ipc:' + specifier, data);
  }
  function onBeforeQuit() {
    pipe.destroy();
  }
  ipcMain.handle('pear:worker:writeIPC:' + specifier, (evt, data) => {
    return pipe.write(data);
  });
  workers.set(specifier, pipe);
  pipe.on('data', sendWorkerIPC);
  worker.stdout.on('data', sendWorkerStdout);
  worker.stderr.on('data', sendWorkerStderr);
  worker.once('exit', (code) => {
    app.removeListener('before-quit', onBeforeQuit);
    ipcMain.removeHandler('pear:worker:writeIPC:' + specifier);
    pipe.removeListener('data', sendWorkerIPC);
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
