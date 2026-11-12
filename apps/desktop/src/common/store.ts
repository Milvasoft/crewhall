/**
 * The Microsoft Store build (pnpm dist:store) is the same app in an MSIX package. Inside one,
 * Windows keeps the app's registry and AppData writes to itself, so nothing outside the package
 * sees them, and the Store installs updates. What changes is decided here, from Electron's
 * `process.windowsStore`, so it can be tested anywhere.
 */

/** Runs from a Store (appx/MSIX) package. */
export function isStorePackage(platform: string, windowsStore: boolean | undefined): boolean {
  return platform === 'win32' && windowsStore === true;
}

export interface Distribution {
  /** electron-updater over the organization's server; the Store updates its own packages. */
  selfUpdate: boolean;
  /**
   * `app`: the app writes its login item (Run key, macOS login items).
   * `system`: a startup task in the package manifest; the person turns it on and off in Windows'
   * Settings > Apps > Startup, and the app can neither read nor change it.
   */
  loginItem: 'app' | 'system';
  /**
   * "Crewhall'a yükle" and Send to. Both are written to HKCU and %APPDATA%, which a package only
   * writes for itself. A packaged app would need a COM shell extension (IExplorerCommand) declared
   * in the manifest, which this app does not have.
   */
  explorerMenu: boolean;
  /** crewhall:// through the registry; a package declares it in its manifest instead. */
  registerProtocol: boolean;
  /**
   * The app's own AppUserModelID. A package already has one (its family name and application id):
   * another would split the taskbar button from the pinned Start entry.
   */
  ownAppUserModelId: boolean;
}

export function distribution(store: boolean): Distribution {
  return {
    selfUpdate: !store,
    loginItem: store ? 'system' : 'app',
    explorerMenu: !store,
    registerProtocol: !store,
    ownAppUserModelId: !store,
  };
}

/** Windows' own page of startup apps, where the Store build's startup task is turned on or off. */
export const STARTUP_SETTINGS_URL = 'ms-settings:startupapps';

/** The Store's downloads and updates page. */
export const STORE_UPDATES_URL = 'ms-windows-store://downloadsandupdates';
