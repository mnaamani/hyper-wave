// The wave currently shown + acted on in the main view (ring / gallery / lobby / capture).
// In the concurrent-wave world a peer can be aware of many waves at once (the directory); the
// "active" one is what the ring centre displays and what the action modules target.
//
// The OWNER of this value is the shared app core (hyperwave-app-core); this module is the
// renderer's ambient mirror of it — app.js writes it from every core snapshot so lobby/proof can
// read it synchronously (a join / staged moment / tip goes to the right wave) without threading a
// snapshot through them. Null = no wave selected yet.
let activeWaveId = null;

/** @returns {string|null} The active wave id, or null if none is selected. */
export function getActiveWave() {
  return activeWaveId;
}

/**
 * Set the active wave (app.js owns this — call it via selectWave, not directly).
 * @param {string|null} waveId The wave to make active.
 * @returns {void}
 */
export function setActiveWave(waveId) {
  activeWaveId = waveId || null;
}
