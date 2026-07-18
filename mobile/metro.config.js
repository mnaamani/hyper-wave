// Expo Metro config for a monorepo. Metro bundles the RN JS (App.js etc.) — NOT the engine
// (that's the Bare worklet, bundled separately by `bare-pack`). So Metro only needs to (a) watch
// the workspace root and (b) resolve RN/Expo deps from the hoisted root node_modules, plus (c)
// treat the .mjs bare-pack bundle as a source file we can import.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules')
];
config.resolver.disableHierarchicalLookup = true;
config.resolver.sourceExts.push('mjs', 'cjs');

module.exports = config;
