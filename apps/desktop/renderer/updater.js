import * as hud from './lib/hud.js';

// OTA updater worker (kept from the template)
const bridge = window.bridge;
const decoder = new TextDecoder('utf-8');
// should match value of 'updaterWorkerSpecifier' in /electron/main.js
const UPDATER = '/workers/updater.js';
bridge.startWorker(UPDATER);
bridge.onWorkerIPC(UPDATER, (data) => {
  if (decoder.decode(data) === 'updating') {
    hud.updatingStatus('updating...');
  }
});
