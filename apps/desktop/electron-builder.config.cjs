// electron-builder configuration (pnpm dist:win / dist:mac). Everything the app needs at runtime
// is bundled into dist/ by scripts/build.mjs, so no node_modules are packed.
//
// Code signing: there is no certificate yet. Windows builds are unsigned (SmartScreen warns on
// first install); macOS builds are ad-hoc signed, cannot be notarized and Squirrel.Mac will not
// auto-update them. Set CSC_LINK / CSC_KEY_PASSWORD (Windows) or an Apple Developer ID
// (macOS: CSC_LINK, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID) once they exist.

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.crewhall.desktop',
  productName: 'Crewhall',
  copyright: 'Crewhall',
  directories: {
    output: 'release',
    buildResources: 'resources',
  },
  files: ['dist/**', '!dist/**/*.map', 'package.json'],
  asar: true,
  // Native input for remote control (src/main/input-driver.ts) must stay a real file.
  asarUnpack: ['dist/native/**'],
  // Every dependency is bundled; do not walk the pnpm workspace.
  npmRebuild: false,
  nodeGypRebuild: false,
  extraMetadata: { main: 'dist/main.cjs', dependencies: {} },
  protocols: [{ name: 'Crewhall', schemes: ['crewhall'] }],
  // Updates come from each organization's own server (/api/v1/desktop/updates/<platform>/), so the
  // build names no feed; scripts/publish-updates.mjs writes latest.yml for DESKTOP_UPDATES_DIR.
  publish: null,
  extraResources: [{ from: 'resources/app-update.yml', to: 'app-update.yml' }],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'resources/icon.png',
    artifactName: 'Crewhall-Setup-${version}.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Crewhall',
    // Removes the Explorer menu entries on uninstall.
    include: 'resources/installer.nsh',
    // Turkish and English installer screens.
    installerLanguages: ['tr_TR', 'en_US'],
    language: '1055',
    multiLanguageInstaller: true,
    deleteAppDataOnUninstall: false,
    // .blockmap next to the installer: updates download only the changed blocks.
    differentialPackage: true,
  },
  mac: {
    target: [
      { target: 'dmg', arch: ['universal'] },
      { target: 'zip', arch: ['universal'] },
    ],
    icon: 'resources/icon.png',
    category: 'public.app-category.productivity',
    hardenedRuntime: true,
    entitlements: 'resources/entitlements.mac.plist',
    entitlementsInherit: 'resources/entitlements.mac.plist',
    extendInfo: {
      NSCameraUsageDescription: 'Toplantılarda kamera için / Camera for meetings',
      NSMicrophoneUsageDescription: 'Toplantılarda mikrofon için / Microphone for meetings',
    },
    artifactName: 'Crewhall-${version}-mac.${ext}',
  },
};
