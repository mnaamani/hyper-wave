import * as hud from './lib/hud.js';

// OTA updater (pear-runtime). The worker (workers/updater.js) seeds the upgrade drive and emits
// 'updating' while a new version downloads and 'updated' once it's fully downloaded + staged. We
// surface a prompt on 'updated'; applying it swaps the version in (main's pear:applyUpdate) and
// relaunches (main's app:afterUpdate) — both already exposed on the bridge.
const bridge = window.bridge;
const decoder = new TextDecoder('utf-8');
// should match value of 'updaterWorkerSpecifier' in /electron/main.js
const UPDATER = '/workers/updater.js';

const promptEl = document.getElementById('update-prompt');
const applyBtn = document.getElementById('update-apply');
const dismissBtn = document.getElementById('update-dismiss');

bridge.startWorker(UPDATER);
bridge.onWorkerIPC(UPDATER, (data) => {
  const message = decoder.decode(data);
  if (message === 'updating') {
    hud.updatingStatus('⬇ downloading update…');
  } else if (message === 'updated') {
    // A new version is downloaded + ready — prompt the user to restart into it.
    hud.updatingStatus('');
    promptEl.classList.add('show');
  }
});

// Apply: swap the new version in, then relaunch into it. appAfterUpdate quits the app, so anything
// after it won't run; the catch only fires if the swap itself failed.
applyBtn.onclick = async () => {
  applyBtn.disabled = true;
  applyBtn.innerText = 'updating…';
  hud.updatingStatus('applying update…');
  try {
    await bridge.applyUpdate();
    await bridge.appAfterUpdate();
  } catch (err) {
    hud.updatingStatus('⚠ update failed: ' + (err?.message || err));
    applyBtn.disabled = false;
    applyBtn.innerText = 'Restart to update';
  }
};

// Later: hide the prompt but leave a quiet reminder; the staged update applies on the next restart.
dismissBtn.onclick = () => {
  promptEl.classList.remove('show');
  hud.updatingStatus('an update is ready — restart to apply');
};
