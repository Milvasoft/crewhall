import { join, resolve } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { app, globalShortcut } from 'electron';
import { appUserModelId } from '../common/app-id';
import { PROTOCOL, findDeepLinkArg } from '../common/deeplink';
import { distribution, isStorePackage } from '../common/store';
import { REMOVE_DRIVE_FLAG } from '../common/virtual-drive';
import { macWebAuthnOptions } from '../common/webauthn';
import { DesktopApp } from './app';
import { registerIpc } from './ipc';
import { SettingsStore } from './settings';
import { registerTitleBar } from './titlebar';
import { removeVirtualDriveForUninstall } from './virtual-drive';

/**
 * Trust the OS certificate store in Node too (the /ws connection): organizations often run
 * their server with a certificate from their own internal CA, which Chromium already trusts.
 */
function trustSystemCertificates(): void {
  try {
    setDefaultCACertificates([...getCACertificates('default'), ...getCACertificates('system')]);
  } catch {
    // Older runtimes: bundled roots only.
  }
}

const dist = distribution(isStorePackage(process.platform, process.windowsStore));

function registerProtocol(): void {
  // A Store package declares crewhall:// in its manifest; the registry key would stay its own.
  if (!dist.registerProtocol) return;
  if (!process.defaultApp) {
    app.setAsDefaultProtocolClient(PROTOCOL);
  } else if (process.env.CREWHALL_REGISTER_PROTOCOL === '1' && process.argv[1]) {
    // `electron .` during development (opt-in, it rewires crewhall:// on this machine).
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [resolve(process.argv[1])]);
  }
}

// A separate profile for development and tests (settings, session, sync state).
if (process.env.CREWHALL_USER_DATA)
  app.setPath('userData', resolve(process.env.CREWHALL_USER_DATA));

if (process.argv.includes(REMOVE_DRIVE_FLAG)) {
  // The uninstaller waits for this: it must end whatever happens.
  setTimeout(() => app.exit(1), 60_000);
  void removeVirtualDriveForUninstall(
    new SettingsStore(join(app.getPath('userData'), 'settings.json')),
  ).then(
    () => app.exit(0),
    (err: unknown) => {
      console.warn('[drive] could not remove the virtual drive', err);
      app.exit(1);
    },
  );
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A Store package keeps the id Windows gave it, the one its Start entry and taskbar pin carry.
  if (dist.ownAppUserModelId) app.setAppUserModelId(appUserModelId(app.isPackaged));
  let desktop: DesktopApp | null = null;
  let pendingLink = findDeepLinkArg(process.argv);

  // macOS delivers links by event, possibly before the app is ready.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (desktop) desktop.handleDeepLink(url);
    else pendingLink = url;
  });

  // Windows: a second launch (also a crewhall:// link) wakes the running app.
  app.on('second-instance', (_event, argv) => {
    if (!desktop) return;
    const link = findDeepLinkArg(argv);
    if (link) desktop.handleDeepLink(link);
    else if (!desktop.sendTo.receive(argv)) desktop.showMain();
  });

  app.on('activate', () => desktop?.showMain());
  // Every window, with what made it: a page's window.open (its URL and frame) or the app itself.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('did-create-window', (win, details) => {
      console.info(
        `[window] page opened #${win.id} ${details.disposition} ${details.frameName || '-'} ${details.url} (from ${contents.getURL()})`,
      );
    });
  });
  app.on('browser-window-created', (_e, win) => {
    setImmediate(() => {
      if (!win.isDestroyed())
        console.info(`[window] created #${win.id} ${win.webContents.getURL()}`);
    });
  });
  app.on('before-quit', () => {
    if (desktop) desktop.quitting = true;
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // The tray keeps the app alive with every window closed.
  app.on('window-all-closed', () => undefined);

  void app.whenReady().then(async () => {
    trustSystemCertificates();
    registerProtocol();
    // Touch ID passkeys (vault unlock) on a signed mac build; see common/webauthn.
    const webAuthn = macWebAuthnOptions(process.platform, __MAC_KEYCHAIN_GROUP__);
    if (webAuthn) app.configureWebAuthn(webAuthn);
    desktop = new DesktopApp();
    desktop.startHidden =
      process.argv.includes('--hidden') ||
      (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin === true);
    registerIpc(desktop);
    registerTitleBar();
    desktop.remote.register();
    desktop.meetings.register();
    desktop.extras.register();
    desktop.vaultDevice.register();
    desktop.system.start();
    desktop.viewer.register();
    await desktop.start();
    desktop.sendTo.receive(process.argv);
    if (pendingLink) {
      desktop.handleDeepLink(pendingLink);
      pendingLink = undefined;
    }
  });
}
