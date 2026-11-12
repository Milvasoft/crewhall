// electron-builder configuration (pnpm dist:win / dist:mac / dist:store). Everything the app needs
// at runtime is bundled into dist/ by scripts/build.mjs, so no node_modules are packed.
//
// Code signing: there is no Windows certificate. The NSIS installer is unsigned (SmartScreen warns
// on first install); the Microsoft Store package (appx) goes up unsigned and the Store signs it.
// macOS builds are ad-hoc signed until a Developer ID is given (CSC_LINK + CSC_KEY_PASSWORD), then
// signed with a hardened runtime and notarized when APPLE_API_KEY / APPLE_API_KEY_ID /
// APPLE_API_ISSUER or APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID are set
// (pipeline/azure-pipeline-desktop-mac.yml, docs/contracts/masaustu-yayin.md).
//
// The ad-hoc signature is required, not cosmetic: an unsigned app has a broken signature after
// packaging, and macOS then cannot remember the camera and microphone answers, so it asks on
// every call. Hardened runtime stays for a real Developer ID only: under it, ad-hoc signed code
// fails library validation and the app does not start.
const macDeveloperId = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

/**
 * Partner Center's values for the Store package (Product management > Product identity). Not in
 * the code: scripts/store-env.mjs stops dist:store when one is missing. Unset, they stay undefined,
 * so the NSIS and mac builds never see them.
 */
const storeEnv = (name) => process.env[name]?.trim() || undefined;

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
  // Microsoft Store (pnpm dist:store). The Store updates the app and signs the package; the app
  // notices it runs packaged (process.windowsStore, src/common/store.ts) and leaves out what MSIX
  // does not allow: its own updater, the Run key and the Explorer menu's registry entries.
  appx: {
    identityName: storeEnv('MS_STORE_IDENTITY_NAME'),
    publisher: storeEnv('MS_STORE_PUBLISHER'),
    publisherDisplayName: storeEnv('MS_STORE_PUBLISHER_NAME'),
    // Must match the name reserved in Partner Center.
    displayName: storeEnv('MS_STORE_DISPLAY_NAME') ?? 'Crewhall',
    applicationId: 'Crewhall',
    // The icon's own background (scripts/store-assets.mjs prints it), tiles in resources/appx/.
    backgroundColor: '#118478',
    languages: ['tr-TR', 'en-US'],
    // Meetings: the app is listed under camera and microphone in Windows' privacy settings.
    capabilities: ['runFullTrust', 'webcam', 'microphone'],
    // crewhall:// comes from `protocols` above; the startup task with its --hidden parameter needs
    // uap10 (Windows 10 2004), which electron-builder's own manifest template does not declare.
    addAutoLaunchExtension: false,
    customManifestPath: 'appx-manifest.xml',
    customExtensionsPath: 'resources/appx-extensions.xml',
    minVersion: '10.0.19041.0',
    maxVersionTested: '10.0.26100.0',
    artifactName: 'Crewhall-${version}-store.${ext}',
  },
  mac: {
    target: [
      { target: 'dmg', arch: ['universal'] },
      { target: 'zip', arch: ['universal'] },
    ],
    icon: 'resources/icon.png',
    category: 'public.app-category.productivity',
    // '-' is ad-hoc signing; undefined lets electron-builder use the Developer ID it finds.
    identity: macDeveloperId ? undefined : '-',
    hardenedRuntime: macDeveloperId,
    entitlements: 'resources/entitlements.mac.plist',
    entitlementsInherit: 'resources/entitlements.mac.plist',
    extendInfo: {
      NSCameraUsageDescription: 'Toplantılarda kamera için / Camera for meetings',
      NSMicrophoneUsageDescription: 'Toplantılarda mikrofon için / Microphone for meetings',
    },
    artifactName: 'Crewhall-${version}-mac.${ext}',
  },
};
