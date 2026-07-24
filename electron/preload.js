const { contextBridge, ipcRenderer } = require('electron');

function toBuffer(data) {
  if (data === null || data === undefined || typeof data === 'number') {
    return data;
  }
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

contextBridge.exposeInMainWorld('bridge', {
  pkg() {
    return ipcRenderer.sendSync('pkg');
  },
  // true in a packaged/distributed build, false under `npm start` (dev). Gates dev-only tooling.
  isPackaged() {
    return ipcRenderer.sendSync('isPackaged');
  },
  // Copy text to the clipboard (a Lightning invoice) and open external links (a lightning: invoice)
  // via main — the sandboxed renderer can't do these itself.
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  applyUpdate: () => ipcRenderer.invoke('pear:applyUpdate'),
  appAfterUpdate: () => ipcRenderer.invoke('app:afterUpdate'),
  startWorker: (specifier) => ipcRenderer.invoke('pear:startWorker', specifier),
  onWorkerStdout: (specifier, listener) => {
    const wrap = (evt, data) => listener(toBuffer(data));
    ipcRenderer.on('pear:worker:stdout:' + specifier, wrap);
    return () =>
      ipcRenderer.removeListener('pear:worker:stdout:' + specifier, wrap);
  },
  onWorkerStderr: (specifier, listener) => {
    const wrap = (evt, data) => listener(toBuffer(data));
    ipcRenderer.on('pear:worker:stderr:' + specifier, wrap);
    return () =>
      ipcRenderer.removeListener('pear:worker:stderr:' + specifier, wrap);
  },
  onWorkerIPC: (specifier, listener) => {
    const wrap = (evt, data) => listener(toBuffer(data));
    ipcRenderer.on('pear:worker:ipc:' + specifier, wrap);
    return () =>
      ipcRenderer.removeListener('pear:worker:ipc:' + specifier, wrap);
  },
  onWorkerExit: (specifier, listener) => {
    const wrap = (evt, code) => listener(code);
    ipcRenderer.on('pear:worker:exit:' + specifier, wrap);
    return () =>
      ipcRenderer.removeListener('pear:worker:exit:' + specifier, wrap);
  },
  writeWorkerIPC: (specifier, data) => {
    return ipcRenderer.invoke('pear:worker:writeIPC:' + specifier, data);
  },
  // HyperWave app IPC (the bare-rpc host<->UI seam). Electron main runs the bare-rpc client over
  // the worker pipe; these ride Electron's own IPC. `hwCall` is request/response (invoke resolves
  // with the reply, or undefined for fire-and-forget commands); `onHwEvent` is the one-way stream
  // of engine notifications (and request/response replies — see createRpcClient).
  hwCall: (type, args) => ipcRenderer.invoke('hw:call', { type, args }),
  onHwEvent: (listener) => {
    const wrap = (evt, msg) => listener(msg);
    ipcRenderer.on('hw:event', wrap);
    return () => ipcRenderer.removeListener('hw:event', wrap);
  }
});
