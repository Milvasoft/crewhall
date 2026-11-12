import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createApiClient, type ApiClient } from '@crewhall/api-client';
import { resources } from '@crewhall/i18n';
import type { PublicBootstrap } from '@crewhall/shared';
import {
  BrowserWindow,
  Notification,
  app,
  globalShortcut,
  nativeImage,
  session,
  shell,
  type NativeImage,
  type WebContents,
} from 'electron';
import { badgeCount } from '../common/badge';
import { deepLinkTarget, parseDeepLink } from '../common/deeplink';
import { isMeetingPath, pathForServer, servesEnglishPaths } from '../common/paths';
import {
  createTranslator,
  pickLocale,
  type DesktopLocale,
  type Dictionary,
  type Translate,
} from '../common/i18n';
import type { BrandView, SettingsView, UpdateState } from '../common/ipc';
import { SETTINGS_EVENT } from '../common/ipc';
import {
  DEFAULT_GLOBAL_SHORTCUT,
  GlobalShortcut,
  type ShortcutProblem,
} from '../common/global-shortcut';
import {
  callContent,
  notificationContent,
  NoteGuard,
  wantsNativeNotification,
} from '../common/notify';
import {
  answerCallFromNote,
  declineCallFromNote,
  markNotificationRead,
  notificationButtons,
  replyToNotification,
  ringIsOver,
  type CallAction,
} from '../common/notify-actions';
import { realtimeEffects, ringAction } from '../common/window-policy';
import { RealtimeClient, type SocketLike } from '../common/realtime';
import { checkServer } from '../common/server';
import { SyncEngine, type PairStatus } from '../sync/engine';
import { createApiDrive } from '../sync/remote';
import type { SyncPlatform } from '../sync/names';
import { brandIcon, loadCachedIcon } from './branding';
import { buildAppMenu } from './menu';
import { PRELOAD, asset } from './paths';
import { SettingsStore, type StoredBrand } from './settings';
import { TrayController } from './tray';
import { ExtraWindows } from './extra-windows';
import { SendTo } from './send-to';
import { MeetingWindows } from './meeting-windows';
import { SystemWatch } from './system';
import { ViewerWindow } from './viewer';
import { VaultDevice } from './vault-device';
import { RemoteControlHost } from './remote-control';
import { Updater } from './updater';
import { VirtualDrive } from './virtual-drive';
import { coverWhileLoading } from './loading';
import {
  createMainWindow,
  fadeOutAndDestroy,
  openLocalWindow,
  showOffline,
  showOutdated,
} from './windows';

/** Everything the desktop app keeps between windows: settings, sockets, sync, tray. */
export class DesktopApp {
  readonly settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'));
  locale: DesktopLocale = 'tr';
  t: Translate = (k) => k;
  messages: Dictionary = {};

  main: BrowserWindow | null = null;
  setup: BrowserWindow | null = null;
  settingsWindow: BrowserWindow | null = null;
  /** The org's mark when it has a usable one (not SVG); else Crewhall's icons are used. */
  brandIcon: NativeImage | null = null;
  private readonly appIcon = nativeImage.createFromPath(asset('icon.png'));

  readonly tray: TrayController;
  readonly updater: Updater;
  readonly sync: SyncEngine;
  readonly virtualDrive: VirtualDrive;
  readonly remote: RemoteControlHost;
  readonly meetings: MeetingWindows;
  readonly extras: ExtraWindows;
  readonly sendTo: SendTo;
  readonly system: SystemWatch;
  readonly viewer: ViewerWindow;
  readonly vaultDevice: VaultDevice;
  private readonly shortcut = new GlobalShortcut(
    globalShortcut,
    () => this.summon(),
    process.platform,
  );
  /**
   * Notifications that can still be clicked. Electron drops the events of one that is garbage
   * collected, and a toast stays clickable in the Windows action centre after it hides.
   */
  private readonly notes: Notification[] = [];
  /** Ringing calls' notifications: closed as soon as the ring is over. */
  private readonly ringNotes = new Map<string, Notification>();
  private realtime: RealtimeClient | null = null;
  private badgeTimer: ReturnType<typeof setTimeout> | null = null;
  badge = 0;
  syncStatuses: PairStatus[] = [];
  private conflictsSeen = new Map<string, string>();
  /** Last error line logged per pair, so a failing pair logs once, not every pass. */
  private syncLog = new Map<string, string>();
  quitting = false;
  /** Opened at login: stay in the tray. */
  startHidden = false;

  constructor() {
    this.applyLocale();
    this.tray = new TrayController(this);
    this.updater = new Updater(this);
    this.remote = new RemoteControlHost(this);
    this.meetings = new MeetingWindows(this);
    this.extras = new ExtraWindows(this);
    this.sendTo = new SendTo(this);
    this.system = new SystemWatch(this);
    this.viewer = new ViewerWindow(this);
    this.vaultDevice = new VaultDevice(this);
    this.sync = new SyncEngine({
      createDrive: () =>
        createApiDrive(this.api(), (url, init) =>
          session.defaultSession.fetch(url, { ...init, credentials: 'omit' }),
        ),
      platform: (['win32', 'darwin'].includes(process.platform)
        ? process.platform
        : 'linux') as SyncPlatform,
      device: () => hostname(),
      conflictLabel: () => this.t('desktop.sync.conflictLabel'),
      trash: (abs) => shell.trashItem(abs),
      stateDir: join(app.getPath('userData'), 'sync'),
      onStatus: (statuses) => this.onSyncStatus(statuses),
      passOptions: () => ({ attributes: this.virtualDrive.attributes }),
    });
    this.virtualDrive = new VirtualDrive(this);
  }

  get origin(): string | null {
    return this.settings.get().serverUrl;
  }

  /** Typed /api/v1 client on the window's session: the same cookie the web page signed in with. */
  api(): ApiClient {
    const origin = this.origin;
    if (!origin) throw new Error('no server');
    return createApiClient({
      baseUrl: origin,
      credentials: 'include',
      locale: () => this.locale,
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        session.defaultSession.fetch(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          { ...init, credentials: 'include' },
        )) as typeof fetch,
    });
  }

  applyLocale(): void {
    this.locale = pickLocale(
      app.getPreferredSystemLanguages(),
      this.settings.get().brand?.defaultLocale,
      this.settings.get().userLocale,
    );
    const web = resources[this.locale].web as unknown as Dictionary;
    this.t = createTranslator(this.locale, web);
    this.messages = { desktop: web.desktop as Dictionary };
  }

  get brand(): BrandView | null {
    const b = this.settings.get().brand;
    return b
      ? {
          orgName: b.orgName,
          appName: b.appName,
          logoUrl: b.logoUrl,
          showPoweredBy: b.showPoweredBy,
        }
      : null;
  }

  /** Window and notification icon. */
  get icon(): NativeImage {
    return this.brandIcon ?? this.appIcon;
  }

  get appName(): string {
    return this.settings.get().brand?.appName ?? 'Crewhall';
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  async start(): Promise<void> {
    buildAppMenu(this);
    if (this.origin) this.brandIcon = loadCachedIcon();
    this.tray.create();
    this.updater.start();
    void this.sendTo.syncExplorer();
    const shortcut = this.shortcut.apply(this.settings.get().globalShortcut);
    if (shortcut.state === 'taken') {
      console.warn(`[shortcut] ${shortcut.accelerator} is held by another program`);
    }
    if (this.origin) {
      this.openMain();
      this.connectServices();
      void this.refreshBrand();
    } else {
      this.openSetup();
    }
  }

  /** Realtime, sync and badge for the configured server. */
  connectServices(): void {
    this.realtime?.stop();
    this.realtime = new RealtimeClient({
      // Presence: the computer's idle time and lock state (main/system).
      device: () => this.system.state(),
      getTicket: async () => {
        const t = await this.api().call('createWsTicket');
        return { ticket: t.ticket, path: t.path };
      },
      origin: () => this.origin ?? '',
      openSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      // What each event may do (common/window-policy): never open a window.
      onEvent: (event) => {
        for (const effect of realtimeEffects(event.type)) {
          if (effect === 'badge') this.refreshBadgeSoon(event.type === 'ready' ? 0 : undefined);
          if (effect === 'catch-up') void this.refreshUserLocale();
          if (effect === 'sync') {
            if (event.type === 'node.updated') this.sync.notifyRemoteChange(event.spaceId);
            else this.sync.syncNow();
            this.virtualDrive.notifyChange();
          }
          if (effect === 'notify' && event.type === 'notification') {
            this.showNotification(event.notification);
          }
          if (effect === 'ring' && event.type === 'call.ringing') this.incomingCall(event.call);
          if (effect === 'ring-over' && event.type === 'call.updated' && ringIsOver(event.call)) {
            this.ringNotes.get(event.call.id)?.close();
            this.ringNotes.delete(event.call.id);
          }
        }
      },
    });
    this.realtime.start();
    this.sync.setPairs(this.settings.get().syncPairs);
    this.virtualDrive.connect();
  }

  disconnectServices(): void {
    this.realtime?.stop();
    this.realtime = null;
    this.sync.setPairs([]);
    this.virtualDrive.disconnect();
    this.setBadge(0);
  }

  /** The web page signed in or navigated: try the socket again at once. */
  nudgeRealtime(): void {
    this.realtime?.retryNow();
    this.virtualDrive.notifyChange();
  }

  quit(): void {
    this.remote.end();
    this.quitting = true;
    this.sync.stop();
    this.virtualDrive.disconnect();
    this.realtime?.stop();
    app.quit();
  }

  // ---- windows ------------------------------------------------------------------------------

  /**
   * `loadingScreen`: the first-run window, already showing the loader; it stays until the new
   * app window has loaded (main/loading).
   */
  openMain(path = '/', loadingScreen: BrowserWindow | null = null, shownAt?: number): void {
    const origin = this.origin;
    if (!origin) return this.openSetup();
    if (!this.main || this.main.isDestroyed()) {
      this.main = createMainWindow(this, origin);
      this.main.on('closed', () => (this.main = null));
      // A new window shows behind the loader once its page has loaded.
      if (!this.startHidden) coverWhileLoading(this, this.main, loadingScreen, shownAt);
      else fadeOutAndDestroy(loadingScreen);
    } else {
      this.navigate(path);
      fadeOutAndDestroy(loadingScreen);
      if (!this.startHidden) this.showMain();
    }
    this.startHidden = false;
  }

  showMain(): void {
    if (!this.main || this.main.isDestroyed()) return this.openMain();
    if (this.main.isMinimized()) this.main.restore();
    this.main.show();
    this.main.focus();
  }

  /** The global shortcut: the app comes up, or the first-run window before there is a server. */
  private summon(): void {
    if (this.origin) {
      // Windows keeps focus from a background app: from the tray it needs the topmost step too.
      if (this.main && !this.main.isDestroyed()) this.bringToFront();
      else this.showMain();
      return;
    }
    if (this.setup && !this.setup.isDestroyed()) {
      this.setup.show();
      this.setup.focus();
    }
  }

  setGlobalShortcut(
    wanted: string | null | 'default',
  ): { ok: true } | { ok: false; error: ShortcutProblem } {
    const accelerator = wanted === 'default' ? DEFAULT_GLOBAL_SHORTCUT : wanted;
    let result: { ok: true } | { ok: false; error: ShortcutProblem } = { ok: true };
    if (accelerator === null) this.shortcut.apply(null);
    else result = this.shortcut.change(accelerator);
    if (result.ok) this.settings.update({ globalShortcut: accelerator });
    this.pushSettings();
    return result;
  }

  /** Incoming call: in front of everything, even from the tray. */
  bringToFront(): void {
    const win = this.main;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    // Windows only lets a background app take focus while it is topmost for a moment.
    win.setAlwaysOnTop(true);
    win.focus();
    setTimeout(() => !win.isDestroyed() && win.setAlwaysOnTop(false), 1500);
    if (process.platform === 'darwin') {
      app.focus({ steal: true });
      app.dock?.bounce('critical');
    } else if (!win.isFocused()) {
      win.flashFrame(true);
    }
  }

  /** The server serves English web paths (common/paths); until the bootstrap says so, Turkish. */
  get englishPaths(): boolean {
    return servesEnglishPaths(this.settings.get().brand?.capabilities);
  }

  /** A path from a notification, a link or a page (old or new form) in the form this server serves. */
  serverPath(path: string): string {
    return pathForServer(path, this.englishPaths);
  }

  /**
   * Opens a path from outside the page (a notification, a crewhall:// link): a meeting in its
   * meeting window, anything else in the main window.
   */
  openPath(path: string): void {
    const origin = this.origin;
    if (!origin || !path) return;
    if (isMeetingPath(path.split(/[?#]/)[0] ?? '')) {
      const target = deepLinkTarget(this.serverPath(path), origin);
      if (target && this.meetings.open(target)) return;
    }
    this.showMain();
    this.navigate(path);
  }

  /** In-app navigation without reloading the page (the router listens to popstate). */
  navigate(path: string): void {
    const origin = this.origin;
    const win = this.main;
    if (!origin || !win || win.isDestroyed() || !path) return;
    const target = deepLinkTarget(this.serverPath(path), origin);
    if (!target) return;
    const current = win.webContents.getURL();
    if (current.startsWith(`${origin}/`) || current === origin) {
      const rel = target.slice(origin.length);
      void win.webContents
        .executeJavaScript(
          `history.pushState(null, '', ${JSON.stringify(rel)}); dispatchEvent(new PopStateEvent('popstate'));`,
        )
        .catch(() => win.loadURL(target));
    } else {
      void win.loadURL(target);
    }
  }

  openSetup(prefill?: string): void {
    if (this.setup && !this.setup.isDestroyed()) {
      this.setup.focus();
      return;
    }
    this.setup = openLocalWindow(this, 'setup', prefill ? { server: prefill } : {}, {
      width: 520,
      height: 640,
      resizable: false,
    });
    this.setup.on('closed', () => {
      this.setup = null;
      // Closing the first-run screen without a server ends the app.
      if (!this.origin && !this.quitting) this.quit();
    });
  }

  openSettings(tab?: 'general' | 'sync' | 'about'): void {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.settingsWindow.show();
      this.settingsWindow.focus();
      return;
    }
    this.settingsWindow = openLocalWindow(this, 'settings', tab ? { tab } : {}, {
      width: 780,
      height: 640,
      minWidth: 640,
      minHeight: 480,
    });
    this.settingsWindow.on('closed', () => (this.settingsWindow = null));
  }

  showOffline(): void {
    if (this.main && !this.main.isDestroyed() && this.origin) showOffline(this.main, this.origin);
  }

  /** The server answered 426: this app is too old for it (common/client). */
  outdated = false;

  /**
   * The app's own update screen in the main window, and an update check at once (the feed is
   * the same server). Sockets and sync stop until the person tries again.
   */
  showOutdated(): void {
    if (this.outdated || !this.origin) return;
    this.outdated = true;
    console.warn('[client] the server answered 426: this app version is too old for it');
    this.disconnectServices();
    if (this.main && !this.main.isDestroyed()) {
      showOutdated(this.main, this.origin);
      this.showMain();
    }
    this.updater.check();
  }

  /** "Yeniden dene" on the offline or update screen. */
  retry(): void {
    if (!this.main || this.main.isDestroyed() || !this.origin) return;
    if (this.outdated) {
      this.outdated = false;
      this.connectServices();
    }
    void this.main.loadURL(`${this.origin}/`);
  }

  // ---- server -------------------------------------------------------------------------------

  /** First-run screen confirmed a server. */
  async connect(origin: string): Promise<void> {
    const startedAt = Date.now();
    const check = await checkServer(origin, (u, i) => session.defaultSession.fetch(u, i));
    if (!check.ok) throw new Error(check.error);
    if (this.origin && this.origin !== check.origin) {
      // A crewhall://connect link to another server: pairs belong to the old one.
      await this.virtualDrive.remove();
      this.disconnectServices();
      this.settings.update({ syncPairs: [] });
      this.extras.closeAll();
      this.main?.destroy();
      this.main = null;
    }
    this.storeBrand(check.origin, check.bootstrap);
    const s = this.settings.get();
    // Packaged builds only: a development run must not register itself to start at login.
    if (!s.autostartInitialized && app.isPackaged) {
      this.setAutostart(true);
      this.settings.update({ autostartInitialized: true });
    }
    this.applyLocale();
    buildAppMenu(this);
    const loadingScreen = this.setup;
    this.setup = null;
    this.openMain('/', loadingScreen, startedAt);
    this.connectServices();
    // The update feed lives on the server: a new server, a new feed.
    this.updater.configure();
    await this.updateIcon();
  }

  async changeServer(): Promise<void> {
    this.remote.end();
    this.meetings.closeAll();
    this.extras.closeAll();
    await this.virtualDrive.remove();
    this.disconnectServices();
    this.settings.update({ serverUrl: null, brand: null, syncPairs: [], userLocale: null });
    this.main?.destroy();
    this.main = null;
    this.settingsWindow?.destroy();
    this.settingsWindow = null;
    this.brandIcon = null;
    this.updater.configure();
    this.tray.refresh();
    this.openSetup();
  }

  /** Follow the language the person chose in the web app. */
  private async refreshUserLocale(): Promise<void> {
    const me = await this.api()
      .call('me')
      .catch(() => null);
    const locale = me?.user.locale ?? null;
    if (!locale || locale === this.settings.get().userLocale) return;
    this.settings.update({ userLocale: locale });
    this.applyLocale();
    buildAppMenu(this);
    this.tray.refresh();
    this.pushSettings();
  }

  /** Branding may change on the server; refresh it quietly on every start. */
  async refreshBrand(): Promise<void> {
    const origin = this.origin;
    if (!origin) return;
    const check = await checkServer(origin, (u, i) => session.defaultSession.fetch(u, i));
    if (!check.ok) return;
    this.storeBrand(origin, check.bootstrap);
    this.applyLocale();
    buildAppMenu(this);
    await this.updateIcon();
    this.tray.refresh();
    // A newer server may only now have said that it offers the feed the drive needs.
    if (this.realtime) this.virtualDrive.connect();
    this.pushSettings();
  }

  private storeBrand(origin: string, bootstrap: PublicBootstrap): void {
    const b = bootstrap.branding;
    const brand: StoredBrand = {
      orgName: b.orgName,
      appName: b.appName,
      logoUrl: b.logoLightUrl ?? b.markUrl,
      iconUrl: b.markUrl ?? b.faviconUrl,
      showPoweredBy: b.showPoweredBy,
      defaultLocale: b.defaultLocale,
      capabilities: bootstrap.server?.capabilities ?? [],
    };
    this.settings.update({ serverUrl: origin, brand });
  }

  private async updateIcon(): Promise<void> {
    const url = this.settings.get().brand?.iconUrl;
    this.brandIcon = url ? await brandIcon(url) : null;
    if (this.main && !this.main.isDestroyed() && process.platform !== 'darwin') {
      this.main.setIcon(this.icon);
    }
    this.tray.refresh();
  }

  // ---- notifications and badge --------------------------------------------------------------

  private readonly noteGuard = new NoteGuard();

  private windowInFront(): boolean {
    const main =
      !!this.main && !this.main.isDestroyed() && this.main.isVisible() && this.main.isFocused();
    return main || this.extras.anyFocused();
  }

  private showNotification(n: Parameters<typeof notificationContent>[0]): void {
    if (!this.settings.get().notifications || !Notification.isSupported()) return;
    if (this.windowInFront() || !wantsNativeNotification(n)) return;
    const origin = this.origin;
    if (!origin) return;
    const content = notificationContent(n, this.t, origin);
    if (!this.noteGuard.first(n, content)) return;
    const buttons = notificationButtons(n);
    const note = new Notification({
      title: content.title,
      body: content.body,
      icon: this.icon,
      silent: false,
      hasReply: buttons.reply,
      replyPlaceholder: this.t('desktop.notify.replyPlaceholder'),
      actions: buttons.actions.map((a) => ({
        type: 'button' as const,
        text: this.t(`desktop.notify.${a}`),
      })),
    });
    const open = () => {
      if (content.path) this.openPath(content.path);
      else this.showMain();
    };
    note.on('click', open);
    note.on('reply', ({ reply }) => void this.replyFromNote(n, reply, open));
    note.on('action', ({ actionIndex }) => {
      const action = buttons.actions[actionIndex];
      if (action === 'join') open();
      if (action === 'markRead') {
        void markNotificationRead(this.api(), n)
          .then(() => this.refreshBadgeSoon())
          .catch((e: unknown) => {
            console.warn('[notify] mark read failed', e);
            this.noteFailed(this.t('desktop.notify.actionFailed'), content.title, open);
          });
      }
    });
    this.keepNote(note);
    note.show();
  }

  private async replyFromNote(
    n: Parameters<typeof notificationContent>[0],
    text: string,
    open: () => void,
  ): Promise<void> {
    try {
      await replyToNotification(this.api(), n, text, randomUUID);
      this.refreshBadgeSoon();
    } catch (e) {
      console.warn('[notify] reply failed', e);
      // The text is only here: show it, so it can be written again in the conversation.
      this.noteFailed(this.t('desktop.notify.replyFailed'), text, open);
    }
  }

  /** An action on a notification could not be done; a click opens what it was about. */
  private noteFailed(title: string, body: string, open: () => void): void {
    if (!Notification.isSupported()) return;
    const note = new Notification({ title, body, icon: this.icon });
    note.on('click', open);
    this.keepNote(note);
    note.show();
  }

  private keepNote(note: Notification): void {
    this.notes.push(note);
    if (this.notes.length > 50) this.notes.shift();
  }

  private async callFromNote(
    call: Parameters<typeof callContent>[0],
    action: CallAction,
  ): Promise<void> {
    try {
      if (action === 'answer') this.openPath(await answerCallFromNote(this.api(), call));
      else await declineCallFromNote(this.api(), call);
    } catch (e) {
      // Usually the call just ended; the web shows what is true now.
      console.warn(`[notify] ${action} failed`, e);
      if (action === 'answer') this.showMain();
    }
  }

  /**
   * A ringing call: the main window comes forward only when it is already on screen; from the
   * tray or during a meeting the taskbar flashes and a notification offers to answer
   * (common/window-policy `ringAction`). Never a new window.
   */
  private incomingCall(call: Parameters<typeof callContent>[0]): void {
    const main = this.main && !this.main.isDestroyed() ? this.main : null;
    const action = ringAction({
      mainVisible: !!main?.isVisible(),
      mainMinimized: !!main?.isMinimized(),
      meetingOpen: this.meetings.count > 0,
    });
    if (action === 'raise') this.bringToFront();
    else if (main && process.platform !== 'darwin') main.flashFrame(true);
    else if (process.platform === 'darwin') app.dock?.bounce('informational');
    if (!this.settings.get().notifications || !Notification.isSupported()) return;
    if (this.windowInFront()) return;
    const content = callContent(call, this.t);
    const actions: CallAction[] = ['answer', 'decline'];
    const note = new Notification({
      title: content.title,
      body: content.body,
      icon: this.icon,
      urgency: 'critical',
      timeoutType: 'never',
      actions: actions.map((a) => ({
        type: 'button' as const,
        text: this.t(`desktop.notify.${a}`),
      })),
    });
    note.on('click', () => this.showMain());
    note.on('action', ({ actionIndex }) => {
      const action = actions[actionIndex];
      if (action) void this.callFromNote(call, action);
    });
    this.keepNote(note);
    this.ringNotes.set(call.id, note);
    note.show();
  }

  refreshBadgeSoon(delay = 500): void {
    if (this.badgeTimer) clearTimeout(this.badgeTimer);
    this.badgeTimer = setTimeout(() => {
      this.badgeTimer = null;
      void this.refreshBadge();
    }, delay);
  }

  private async refreshBadge(): Promise<void> {
    if (!this.origin) return;
    const api = this.api();
    // Chat or notifications may be switched off for the org (403 module_disabled).
    const [unreads, counts] = await Promise.all([
      api.call('getUnreads').catch(() => null),
      api.call('getNotificationCounts').catch(() => null),
    ]);
    if (!unreads && !counts) return;
    this.setBadge(badgeCount(unreads?.unreadConversations ?? 0, counts?.bySource ?? {}));
  }

  setBadge(count: number): void {
    this.badge = count;
    if (process.platform === 'win32') {
      const win = this.main;
      if (win && !win.isDestroyed()) {
        const overlay = this.tray.overlayFor(count);
        win.setOverlayIcon(overlay, overlay ? this.t('desktop.tray.unread', { count }) : '');
      }
    } else {
      app.setBadgeCount(count);
    }
    this.tray.refresh();
  }

  // ---- sync ---------------------------------------------------------------------------------

  private onSyncStatus(statuses: PairStatus[]): void {
    this.syncStatuses = statuses;
    for (const s of statuses) {
      const line = s.error ? `${s.state} ${s.error.code} ${JSON.stringify(s.error.details)}` : '';
      if (line && (s.state === 'error' || s.state === 'confirm') && this.syncLog.get(s.id) !== line)
        console.warn(`[sync] ${s.id}: ${line}`);
      this.syncLog.set(s.id, line);
    }
    this.tray.refresh();
    this.pushSettings();
    this.noteConflicts(statuses);
  }

  /** The spaces of the virtual drive: the same notes, in its own place in the settings. */
  onDriveStatus(statuses: PairStatus[]): void {
    this.pushSettings();
    this.noteConflicts(statuses);
  }

  /** One notification per pass that kept conflicting copies. */
  private noteConflicts(statuses: PairStatus[]): void {
    for (const s of statuses) {
      if (!s.lastSyncAt || !s.stats?.conflicts) continue;
      if (this.conflictsSeen.get(s.id) === s.lastSyncAt) continue;
      this.conflictsSeen.set(s.id, s.lastSyncAt);
      if (!Notification.isSupported() || !this.settings.get().notifications) continue;
      const note = new Notification({
        title: this.t('desktop.notify.conflict'),
        body: this.t('desktop.notify.conflictBody', { count: s.stats.conflicts }),
        icon: this.icon,
      });
      note.on('click', () => this.openSettings('sync'));
      note.show();
    }
  }

  // ---- settings -----------------------------------------------------------------------------

  get autostart(): boolean {
    return app.getLoginItemSettings().openAtLogin;
  }

  setAutostart(on: boolean): void {
    app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
    this.tray.refresh();
  }

  settingsView(): SettingsView {
    const s = this.settings.get();
    return {
      serverUrl: s.serverUrl,
      brand: this.brand,
      notifications: s.notifications,
      autostart: this.autostart,
      // Again each time: the program that held the shortcut may have gone.
      globalShortcut: this.shortcut.apply(s.globalShortcut),
      explorerMenu: s.explorerMenu,
      version: app.getVersion(),
      platform: process.platform,
      update: this.updater.state,
      pairs: s.syncPairs,
      statuses: this.syncStatuses,
      virtualDrive: this.virtualDrive.view(),
    };
  }

  pushSettings(): void {
    const view = this.settingsView();
    const win = this.settingsWindow;
    if (win && !win.isDestroyed()) win.webContents.send(SETTINGS_EVENT, view);
    // The update screen follows the update's progress too.
    if (this.outdated && this.main && !this.main.isDestroyed())
      this.main.webContents.send(SETTINGS_EVENT, view);
  }

  onUpdateState(state: UpdateState): void {
    this.tray.refresh();
    this.pushSettings();
    if (state.state === 'downloaded' && Notification.isSupported()) {
      const note = new Notification({
        title: this.t('desktop.notify.updateReady'),
        body: this.t('desktop.notify.updateReadyBody', { version: state.version }),
        icon: this.icon,
      });
      note.on('click', () => this.openSettings('about'));
      note.show();
    }
  }

  /** crewhall:// links from the OS. */
  handleDeepLink(raw: string): void {
    const link = parseDeepLink(raw);
    if (!link) return;
    if (link.kind === 'connect') {
      this.openSetup(link.server);
      return;
    }
    if (!this.origin) return this.openSetup();
    this.openPath(link.path);
  }

  /** A window showing the organization's pages: the main window or a meeting window. */
  isAppPage(contents: WebContents): boolean {
    const main = this.main;
    return (
      (!!main && !main.isDestroyed() && contents === main.webContents) ||
      this.meetings.has(contents) ||
      this.extras.has(contents)
    );
  }

  /** Sends an event to the main window's page (if it is there). */
  tellMainPage(channel: string, ...args: unknown[]): void {
    const main = this.main;
    if (main && !main.isDestroyed()) main.webContents.send(channel, ...args);
  }

  /** The main window's and every meeting window's page. */
  tellAppPages(channel: string, ...args: unknown[]): void {
    this.tellMainPage(channel, ...args);
    this.meetings.send(channel, ...args);
  }

  /** Presence: the computer locked, slept or woke up. */
  beatNow(): void {
    this.realtime?.beatNow();
  }

  get preload(): string {
    return PRELOAD;
  }
}
