// Bundled (esbuild) classifier: tfjs + nsfwjs + ONLY the mobilenet_v2 model, embedded so it loads
// from memory (no fetch — works in a sandboxed file:// Electron renderer). The IIFE browser build
// exposes { loadModel, classify } on a global; the build's node smoke test imports it too.
// We call nsfwjs's `core.load` directly (not the top-level `load`, which forces the default
// registry = ALL three models ≈ 40 MB) with a single-model registry, so esbuild embeds only
// mobilenet_v2 (~4 MB).
import * as tf from '@tensorflow/tfjs';
import { load as loadCore } from 'nsfwjs/core';
import { MobileNetV2Model } from 'nsfwjs/models/mobilenet_v2';

let modelPromise = null;
export function loadModel() {
  if (!modelPromise) {
    modelPromise = loadCore('MobileNetV2', {
      modelDefinitions: [MobileNetV2Model],
      size: 224
    });
  }
  return modelPromise;
}
export async function classify(input) {
  const model = await loadModel();
  return model.classify(input);
}
export { tf };
