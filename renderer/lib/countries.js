// Country + flag helpers for the renderer. The data + rules live in the shared app core
// (hyperwave-app-core), so the desktop picker and the mobile picker can't drift; this module is
// just the renderer's import path for them.
export {
  flagOf,
  COUNTRIES
} from '../../node_modules/hyperwave-app-core/lib/countries.js';
