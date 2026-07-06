const fs = require('fs')
const path = require('path')
const plink = require('pear-link')

const pkg = require('./package.json')
const appName = pkg.productName ?? pkg.name

function getWindowsKitVersion() {
  const programFiles = process.env['PROGRAMFILES(X86)'] || process.env.PROGRAMFILES
  if (!programFiles) return undefined
  const kitsDir = path.join(programFiles, 'Windows Kits')
  try {
    for (const kit of fs.readdirSync(kitsDir).sort().reverse()) {
      const binDir = path.join(kitsDir, kit, 'bin')
      if (!fs.existsSync(binDir)) continue
      const version = fs
        .readdirSync(binDir)
        .filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d))
        .sort()
        .pop()
      if (version) return version
    }
  } catch {
    return undefined
  }
}

let packagerConfig = {
  icon: 'build/icon',
  protocols: [{ name: appName, schemes: [pkg.name] }],
  derefSymlinks: true
}

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
  }
}

module.exports = {
  packagerConfig,

  makers: [
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
  ],

  hooks: {
    // The npm workspace hoists this app's runtime deps (pear-runtime, corestore, the Bare stack,
    // hyperwave-lib-core) to the REPO ROOT node_modules, so the copied app ships with an empty
    // node_modules and can't resolve them at runtime. Assemble a self-contained production install
    // right in the packaged app, resolving the workspace dep from its real path, then normalize
    // engines so pear-runtime's bare-semver doesn't choke on the freshly-installed tree.
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      const cp = require('child_process')
      const coreDir = path.resolve(__dirname, '..', '..', 'packages', 'hyperwave-lib-core')
      const shim = path.resolve(__dirname, '..', '..', 'scripts', 'fix-bare-engines.js')
      const pjPath = path.join(buildPath, 'package.json')
      const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'))
      pj.dependencies['hyperwave-lib-core'] = 'file:' + coreDir
      delete pj.devDependencies
      fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2))
      cp.execSync('npm install --omit=dev --install-links --no-audit --no-fund --no-package-lock', {
        cwd: buildPath,
        stdio: 'inherit'
      })
      cp.execSync(`node "${shim}" "${buildPath}"`, { stdio: 'inherit' })
    },
    readPackageJson: async (forgeConfig, packageJson) => {
      if (process.env.UPGRADE_KEY) {
        packageJson.upgrade = process.env.UPGRADE_KEY
      }

      try {
        plink.parse(packageJson.upgrade)
      } catch {
        throw new Error('Use `pear touch` to get a valid upgrade key for package.json#upgrade')
      }

      return packageJson
    },
    preMake: async () => {
      fs.rmSync(path.join(__dirname, 'out', 'make'), { recursive: true, force: true })

      const manifest = path.join(__dirname, 'build', 'AppxManifest.xml')
      const msixVersion = pkg.version.replace(/^(\d+\.\d+\.\d+)$/, '$1.0')
      const xml = fs.readFileSync(manifest, 'utf-8')
      fs.writeFileSync(manifest, xml.replace(/Version="[^"]*"/, `Version="${msixVersion}"`))
    },
    postMake: async (forgeConfig, results) => {
      for (const result of results) {
        if (result.platform !== 'win32') continue
        for (const artifact of result.artifacts) {
          if (!artifact.endsWith('.msix')) continue
          const standardDir = path.join(__dirname, 'out', `${appName}-win32-${result.arch}`)
          fs.mkdirSync(standardDir, { recursive: true })
          const dest = path.join(standardDir, path.basename(artifact))
          fs.renameSync(artifact, dest)
          fs.mkdirSync(path.dirname(artifact), { recursive: true })
          fs.copyFileSync(dest, artifact)
          result.artifacts[result.artifacts.indexOf(artifact)] = dest
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
}
