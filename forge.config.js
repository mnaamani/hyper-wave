const fs = require('fs');
const path = require('path');
const plink = require('pear-link');

const pkg = require('./package.json');
const appName = pkg.productName ?? pkg.name;

function getWindowsKitVersion() {
  const programFiles =
    process.env['PROGRAMFILES(X86)'] || process.env.PROGRAMFILES;
  if (!programFiles) {
    return undefined;
  }
  const kitsDir = path.join(programFiles, 'Windows Kits');
  try {
    for (const kit of fs.readdirSync(kitsDir).sort().reverse()) {
      const binDir = path.join(kitsDir, kit, 'bin');
      if (!fs.existsSync(binDir)) {
        continue;
      }
      const version = fs
        .readdirSync(binDir)
        .filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name))
        .sort()
        .pop();
      if (version) {
        return version;
      }
    }
  } catch {
    return undefined;
  }
}

// The only top-level entries the packaged desktop app needs. Because this app IS the monorepo
// root, electron-packager would otherwise copy the WHOLE repo — mobile/ (with its generated,
// sometimes-broken CocoaPods symlinks), packages/, docs/, spike/, scripts/, .git/, … — into the
// bundle. We allowlist just the desktop app's files; node_modules is excluded here and rebuilt
// clean by the packageAfterCopy hook.
const BUNDLE_KEEP_DIRS = new Set([
  'electron',
  'renderer',
  'workers',
  'build',
  'assets',
  'flatpak'
]);
const BUNDLE_KEEP_FILES = new Set(['package.json', 'pear.json']);

// electron-packager ignore predicate: return true to EXCLUDE. Paths are repo-root-relative with a
// leading slash ('' is the root itself). Keep the root, the allowlisted top-level dirs and their
// subtrees, and the two root files; exclude everything else (mobile/, packages/, node_modules/, …).
function ignoreNonAppFiles(relPath) {
  if (relPath === '') {
    return false;
  }
  const segments = relPath.split('/'); // ['', 'electron', 'main.js']
  const top = segments[1];
  if (segments.length === 2) {
    return !BUNDLE_KEEP_DIRS.has(top) && !BUNDLE_KEEP_FILES.has(top);
  }
  return !BUNDLE_KEEP_DIRS.has(top);
}

let packagerConfig = {
  icon: 'build/icon',
  protocols: [{ name: appName, schemes: [pkg.name] }],
  derefSymlinks: true,
  ignore: ignoreNonAppFiles,
  // This app is the root of an npm workspace (packages/* + mobile), so root node_modules mixes the
  // app's production deps, the symlinked workspace packages, and all dev tooling. electron-packager's
  // default prune step walks the production dependency tree (flora-colossus) and trips over the
  // workspace symlinks. Disable it and let the packageAfterCopy hook below wipe the copied
  // node_modules and assemble a clean, self-contained production install inside the bundle.
  prune: false
};

if (process.env.MAC_CODESIGN_IDENTITY) {
  packagerConfig = {
    ...packagerConfig,
    osxSign: {
      identity: process.env.MAC_CODESIGN_IDENTITY,
      optionsForFile: () => ({
        entitlements: path.join(__dirname, 'build', 'entitlements.mac.plist')
      })
    },
    osxNotarize: {
      tool: 'notarytool',
      keychainProfile: process.env.KEYCHAIN_PROFILE
    }
  };
}

// The full, per-platform installer makers used for real releases (signed via env-gated config).
const releaseMakers = [
  {
    name: '@electron-forge/maker-dmg',
    platforms: ['darwin'],
    config: {}
  },
  {
    name: '@electron-forge/maker-msix',
    platforms: ['win32'],
    config: {
      appManifest: path.join(__dirname, 'build', 'AppxManifest.xml'),
      windowsKitVersion: getWindowsKitVersion(),
      ...(process.env.WINDOWS_SIGN_HOOK
        ? {
            windowsSignOptions: {
              hookModulePath: process.env.WINDOWS_SIGN_HOOK
            }
          }
        : {})
    }
  },
  {
    name: 'pear-electron-forge-maker-appimage',
    platforms: ['linux'],
    config: {
      icons: [
        { file: 'build/icon/icon-16x16.png', size: 16 },
        { file: 'build/icon/icon-32x32.png', size: 32 },
        { file: 'build/icon/icon-64x64.png', size: 64 },
        { file: 'build/icon/icon-128x128.png', size: 128 },
        { file: 'build/icon/icon-256x256.png', size: 256 }
      ]
    }
  },
  {
    name: 'pear-electron-forge-maker-flatpak',
    platforms: ['linux'],
    config: {
      appId: 'com.pears.HelloPear',
      icon: `${packagerConfig.icon}.png`,
      comment: 'Integrating Pear into a hello world electron desktop app',
      categories: ['Development']
    }
  },
  {
    name: 'pear-electron-forge-maker-snap',
    platforms: ['linux'],
    config: {
      snapcraftYamlPath: 'build/snapcraft.yaml',
      summary: 'Integrating Pear into a hello world electron desktop app',
      description:
        'End-to-end boilerplate for embedding pear-runtime into Electron apps and deploying peer-to-peer application updates.',
      contact: 'hello@holepunchto.to',
      license: 'Apache-2.0',
      issues: 'https://github.com/holepunchto/hello-pear-electron/issues',
      website: 'https://github.com/holepunchto/hello-pear-electron',
      icon: `${packagerConfig.icon}.png`
    }
  }
];

// CI packaging-test mode (build.yml sets HYPERWAVE_BUILD_TEST=1): build a single unsigned zip on
// EVERY platform. This still exercises the whole `npm run make` pipeline + the packageAfterCopy
// hook (the real regression surface) but needs no signing certs and none of the Linux installer
// toolchains (snapcraft/flatpak), so it runs green on macOS/ubuntu/windows runners.
const makers = process.env.HYPERWAVE_BUILD_TEST
  ? [{ name: '@electron-forge/maker-zip' }]
  : releaseMakers;

module.exports = {
  packagerConfig,

  makers,

  hooks: {
    // The npm workspace hoists this app's runtime deps (pear-runtime, corestore, the Bare stack,
    // hyperwave) to the REPO ROOT node_modules, so the copied app ships with an empty
    // node_modules and can't resolve them at runtime. Assemble a self-contained production install
    // right in the packaged app, resolving the workspace dep from its real path, then normalize
    // engines so pear-runtime's bare-semver doesn't choke on the freshly-installed tree.
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      const childProcess = require('child_process');
      const packagesDir = path.resolve(__dirname, 'packages');
      const coreDir = path.join(packagesDir, 'hyperwave-engine');
      // Workspace packages the app depends on — rewritten to file: links so the fresh production
      // install in the bundle resolves them from the monorepo (they aren't published).
      const workspaceLinks = {
        'hyperwave-engine': coreDir,
        'hyperwave-wallet-cashu': path.join(
          packagesDir,
          'hyperwave-wallet-cashu'
        ),
        'hyperwave-wallet-tron': path.join(packagesDir, 'hyperwave-wallet-tron')
      };
      // The abstract Wallet interface is NOT a direct dep of the app, but the concrete wallets
      // (cashu/tron) depend on hyperwave-wallet@^0.2.0, which is unpublished. Add it as a
      // top-level file: dep so the bundle's standalone install resolves it locally and npm
      // dedups it to satisfy the wallets' transitive requirement (0.2.0 satisfies ^0.2.0) —
      // no registry fetch, and node finds it at the top level at runtime, which is what the
      // wallets need.
      const walletInterfaceDir = path.join(packagesDir, 'hyperwave-wallet');
      const shim = path.resolve(__dirname, 'scripts', 'fix-bare-engines.js');
      const secretStreamPatch = path.resolve(
        __dirname,
        'scripts',
        'patch-secret-stream.js'
      );
      const pjPath = path.join(buildPath, 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
      // Point every workspace dep the app declares at its file: link (only those present).
      for (const [name, dir] of Object.entries(workspaceLinks)) {
        if (packageJson.dependencies[name]) {
          packageJson.dependencies[name] = 'file:' + dir;
        }
      }
      // Add the transitive interface package as a top-level file: dep (see above) so the
      // wallets' unpublished hyperwave-wallet requirement resolves locally.
      packageJson.dependencies['hyperwave-wallet'] =
        'file:' + walletInterfaceDir;
      delete packageJson.devDependencies;
      // Drop the app's own lifecycle scripts: the copied package.json carries the repo postinstall
      // (`node scripts/fix-bare-engines.js && …`), but scripts/ is not in the bundle (excluded) and
      // the steps are re-run explicitly below from source. Clearing them avoids a broken postinstall
      // during the bundle install; dependencies still run their own install scripts.
      delete packageJson.scripts;
      fs.writeFileSync(pjPath, JSON.stringify(packageJson, null, 2));
      // With prune disabled, electron-packager copies the repo-root node_modules verbatim — now
      // that the app IS the root package that tree is huge (electron, all makers, tfjs, …). Wipe
      // it and install a clean production-only tree so the bundle carries only what it needs.
      fs.rmSync(path.join(buildPath, 'node_modules'), {
        recursive: true,
        force: true
      });
      childProcess.execSync(
        'npm install --omit=dev --install-links --no-audit --no-fund --no-package-lock',
        {
          cwd: buildPath,
          stdio: 'inherit'
        }
      );
      childProcess.execSync(`node "${shim}" "${buildPath}"`, {
        stdio: 'inherit'
      });
      // Vendored secret-stream security patch (maxMessageSize) must ship in the bundle too.
      childProcess.execSync(`node "${secretStreamPatch}" "${buildPath}"`, {
        stdio: 'inherit'
      });
      // Rebuild the NSFW classifier bundle fresh into the packaged tree (esbuild lives in the repo
      // root's devDeps — available at build time — so this doesn't depend on the copy carrying it).
      const nsfwBuild = path.resolve(__dirname, 'scripts', 'build-nsfw.mjs');
      childProcess.execSync(`node "${nsfwBuild}" "${buildPath}"`, {
        stdio: 'inherit'
      });
      // Rebuild the QR bundle fresh into the packaged tree too (wallet top-up invoice QR).
      const qrBuild = path.resolve(__dirname, 'scripts', 'build-qr.mjs');
      childProcess.execSync(`node "${qrBuild}" "${buildPath}"`, {
        stdio: 'inherit'
      });
    },
    readPackageJson: async (forgeConfig, packageJson) => {
      if (process.env.UPGRADE_KEY) {
        packageJson.upgrade = process.env.UPGRADE_KEY;
      }

      try {
        plink.parse(packageJson.upgrade);
      } catch {
        throw new Error(
          'Use `pear touch` to get a valid upgrade key for package.json#upgrade'
        );
      }

      return packageJson;
    },
    preMake: async () => {
      fs.rmSync(path.join(__dirname, 'out', 'make'), {
        recursive: true,
        force: true
      });

      // The dmg maker loads native addons (macos-alias + fs-xattr, via appdmg) under the Node
      // running `make`. If those were last built against a different Node ABI (e.g. installed
      // under a different Volta/nvm version), the maker throws NODE_MODULE_VERSION mismatch.
      // Self-heal: rebuild them against the current Node before the maker loads them. Best-effort
      // — if the rebuild can't run, warn and let the maker try the existing binary.
      if (process.platform === 'darwin') {
        try {
          require('child_process').execSync(
            'npm rebuild macos-alias fs-xattr',
            { cwd: __dirname, stdio: 'inherit' }
          );
        } catch (err) {
          console.warn(
            '[preMake] could not rebuild dmg native addons:',
            err.message
          );
        }
      }

      const manifest = path.join(__dirname, 'build', 'AppxManifest.xml');
      const msixVersion = pkg.version.replace(/^(\d+\.\d+\.\d+)$/, '$1.0');
      const xml = fs.readFileSync(manifest, 'utf-8');
      fs.writeFileSync(
        manifest,
        xml.replace(/Version="[^"]*"/, `Version="${msixVersion}"`)
      );
    },
    postMake: async (forgeConfig, results) => {
      for (const result of results) {
        if (result.platform !== 'win32') {
          continue;
        }
        for (const artifact of result.artifacts) {
          if (!artifact.endsWith('.msix')) {
            continue;
          }
          const standardDir = path.join(
            __dirname,
            'out',
            `${appName}-win32-${result.arch}`
          );
          fs.mkdirSync(standardDir, { recursive: true });
          const dest = path.join(standardDir, path.basename(artifact));
          fs.renameSync(artifact, dest);
          fs.mkdirSync(path.dirname(artifact), { recursive: true });
          fs.copyFileSync(dest, artifact);
          result.artifacts[result.artifacts.indexOf(artifact)] = dest;
        }
      }
    }
  },

  plugins: [
    {
      name: 'electron-forge-plugin-universal-prebuilds',
      config: {}
    },
    {
      name: 'electron-forge-plugin-prune-prebuilds',
      config: {}
    }
  ]
};
