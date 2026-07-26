// Public entry for the HyperWave app core — the framework-agnostic view-model both hosts drive.
// ESM only, dependency-free, and consumable WITHOUT a bundler step: the Electron renderer imports
// it over file:// and React Native imports it through Metro.
export { createAppCore } from './lib/app-core.js';
export { withCountry, asMoment, asEntry } from './lib/theme.js';
export {
  unitLabelFor,
  networksMatch,
  mergeWalletMeta
} from './lib/wallet-meta.js';
export { topicForNetwork } from './lib/topic.js';
