import type { PairStatus, SyncPair } from '../sync/engine';
import type { DesktopFeature } from './client';
import type { ShortcutProblem, ShortcutStatus } from './global-shortcut';
import type { SendProgress, SendResult, SendTarget } from './send-to';
import type { Dictionary, DesktopLocale } from './i18n';
import type { DriveProblem, VirtualDriveView } from './virtual-drive';

/**
 * Bridge between the app's own pages (setup, settings, screen picker, offline) and the main
 * process. The server's web pages never get it: the preload exposes it only on file:// pages
 * and every handler checks the sender again.
 */

export interface BrandView {
  orgName: string;
  appName: string;
  /** A logo the page can show (light variant). */
  logoUrl: string | null;
  showPoweredBy: boolean;
}

export type ServerCheckView =
  | { ok: true; origin: string; brand: BrandView }
  | { ok: false; error: 'invalid' | 'unreachable' | 'notCrewhall' | 'needsSetup' };

export type UpdateState =
  /** `store`: the Microsoft Store build, which the Store updates (common/store). */
  | { state: 'disabled' | 'store' | 'idle' | 'checking' | 'none' | 'error' }
  | { state: 'available' | 'downloaded'; version: string };

export interface SettingsView {
  serverUrl: string | null;
  brand: BrandView | null;
  notifications: boolean;
  autostart: boolean;
  /**
   * The Microsoft Store build: Windows starts it at sign-in through the package's startup task
   * (`autostart` means nothing then), and it has no Explorer menu (common/store).
   */
  store: boolean;
  globalShortcut: ShortcutStatus;
  explorerMenu: boolean;
  version: string;
  platform: string;
  update: UpdateState;
  pairs: SyncPair[];
  statuses: PairStatus[];
  /** Null where it cannot run: another OS, an app without the add-on, an older server. */
  virtualDrive: VirtualDriveView | null;
}

/** What Explorer sent to the app. */
export interface SendInfo {
  names: string[];
  files: number;
  bytes: number;
}
export type SendState = SendProgress;

export interface SpaceView {
  id: string;
  name: string;
  slug: string;
  /** Viewers cannot upload: the list warns before pairing. */
  canEdit: boolean;
}

export interface FolderView {
  id: string;
  name: string;
}

export interface NewPair {
  spaceId: string;
  spaceName: string;
  folderId: string | null;
  folderPath: string;
  localPath: string;
}

export interface ScreenSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  /** data: URL of a small preview. */
  thumbnail: string;
}

export interface ScreenAccess {
  /** True on macOS, where the person grants it in System Settings and restarts the app. */
  needsSystemGrant: boolean;
  granted: boolean;
}

export interface DesktopApi {
  i18n(): Promise<{ locale: DesktopLocale; messages: Dictionary }>;
  /** What the current page is for (set when the window opened it). */
  checkServer(input: string): Promise<ServerCheckView>;
  connect(origin: string): Promise<void>;
  getSettings(): Promise<SettingsView>;
  setSettings(patch: {
    notifications?: boolean;
    autostart?: boolean;
    explorerMenu?: boolean;
  }): Promise<SettingsView>;
  sendInfo(): Promise<SendInfo>;
  sendStart(target: SendTarget): Promise<SendResult>;
  sendCancel(): Promise<void>;
  /** Brings up the main window, at this Drive folder when one is given. */
  sendOpenApp(drive: { slug: string; folderId: string | null } | null): Promise<void>;
  /** A shortcut, null to switch it off; 'default' goes back to the app's own. */
  setGlobalShortcut(
    accelerator: string | null | 'default',
  ): Promise<{ ok: true } | { ok: false; error: ShortcutProblem }>;
  changeServer(): Promise<void>;
  listSpaces(): Promise<SpaceView[]>;
  listFolders(spaceId: string, parentId: string | null): Promise<FolderView[]>;
  pickLocalFolder(): Promise<string | null>;
  addPair(pair: NewPair): Promise<{ ok: true } | { ok: false; error: 'overlap' | 'notDirectory' }>;
  removePair(id: string): Promise<void>;
  setPaused(id: string, paused: boolean): Promise<void>;
  syncNow(id?: string): Promise<void>;
  confirmDeletes(id: string): Promise<void>;
  openPairFolder(id: string): Promise<void>;
  setVirtualDrive(enabled: boolean): Promise<{ ok: true } | { ok: false; error: DriveProblem }>;
  /** Asks for another folder; only while the drive is off. */
  pickVirtualDriveFolder(): Promise<void>;
  openVirtualDrive(): Promise<void>;
  syncVirtualDrive(): Promise<void>;
  confirmVirtualDriveDeletes(id: string): Promise<void>;
  checkUpdates(): Promise<void>;
  installUpdate(): Promise<void>;
  /** Store build: Windows' startup apps page, where its startup task is turned on or off. */
  openStartupSettings(): Promise<void>;
  /** Store build: the Store's downloads and updates page. */
  openStoreUpdates(): Promise<void>;
  screenSources(): Promise<ScreenSource[]>;
  chooseSource(id: string | null): Promise<void>;
  /** macOS only asks for screen recording in System Settings; whether the app has it. */
  screenAccess(): Promise<ScreenAccess>;
  /** macOS: open Privacy › Screen & System Audio Recording. */
  openScreenSettings(): Promise<void>;
  /** Quits and starts the app again (macOS applies a new screen recording grant only then). */
  relaunch(): Promise<void>;
  retry(): Promise<void>;
  /** Remote control consent window: "Ver" (true) or "Reddet". */
  answerControl(yes: boolean): Promise<void>;
  /** The band's Stop button. */
  stopControl(): Promise<void>;
  /** macOS: open Privacy › Accessibility so the app may inject input. */
  openAccessibilitySettings(): Promise<void>;
  /** Pushed by the main process while the settings page is open. */
  onSettings(listener: (settings: SettingsView) => void): () => void;
  onSend(listener: (state: SendState) => void): () => void;
}

/** Invoke channels: `desktop:<method>`. */
export const API_METHODS = [
  'i18n',
  'checkServer',
  'connect',
  'getSettings',
  'setSettings',
  'setGlobalShortcut',
  'sendInfo',
  'sendStart',
  'sendCancel',
  'sendOpenApp',
  'changeServer',
  'listSpaces',
  'listFolders',
  'pickLocalFolder',
  'addPair',
  'removePair',
  'setPaused',
  'syncNow',
  'confirmDeletes',
  'openPairFolder',
  'setVirtualDrive',
  'pickVirtualDriveFolder',
  'openVirtualDrive',
  'syncVirtualDrive',
  'confirmVirtualDriveDeletes',
  'checkUpdates',
  'installUpdate',
  'screenSources',
  'chooseSource',
  'screenAccess',
  'openScreenSettings',
  'relaunch',
  'openStartupSettings',
  'openStoreUpdates',
  'retry',
  'answerControl',
  'stopControl',
  'openAccessibilitySettings',
] as const satisfies ReadonlyArray<Exclude<keyof DesktopApi, 'onSettings' | 'onSend'>>;

export type ApiMethod = (typeof API_METHODS)[number];

export const SETTINGS_EVENT = 'desktop:settings';
export const SEND_EVENT = 'desktop:send';

/** Pages of the app: dist/renderer/index.html?view=<view>. */
export type View =
  | 'setup'
  | 'outdated'
  | 'settings'
  | 'picker'
  | 'send'
  | 'offline'
  | 'loading'
  | 'control-request'
  | 'control-permission'
  | 'control-banner'
  | 'control-border';

/** IPC channels between the meeting page (preload `crewhallDesktop.remoteControl`) and main. */
export const RC = {
  share: 'rc:share',
  allowed: 'rc:allowed',
  requests: 'rc:requests',
  controller: 'rc:controller',
  input: 'rc:input',
  end: 'rc:end',
  answer: 'rc:answer',
  revoke: 'rc:revoke',
} as const;

export interface ControlPerson {
  identity: string;
  name: string;
}

/** IPC channels of meeting windows. */
/**
 * Our own files the page opens as a pop-up (an image, PDF or video): main hands them back to the
 * page's shared viewer instead of opening a window (`open`); the page says it listens (`listen`).
 */
export const FILES = { open: 'files:open', listen: 'files:listen' } as const;

/** Main → pages: Windows locked or the computer went to sleep (the vault locks). */
export const SYSTEM_LOCK = 'system:lock';

/** IPC channels of the Windows Hello vault unlock (main/vault-device, common/vault-device). */
export const VAULT_DEVICE = {
  status: 'vault-device:status',
  challenge: 'vault-device:challenge',
  enrol: 'vault-device:enrol',
  unlock: 'vault-device:unlock',
  passwordUnlocked: 'vault-device:password-unlocked',
  forget: 'vault-device:forget',
} as const;

/** WebAuthn results as base64url, for the app to verify. */
export interface VaultDeviceRegistration {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  publicKey: string;
  alg: number;
}
export interface VaultDeviceAssertion {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}
export type VaultDeviceStatus =
  | { available: false }
  | { available: true; enrolled: false; stale?: string }
  | { available: true; enrolled: true; usable: boolean; unlockId: string };

export const MEETING = {
  open: 'meeting:open',
  kind: 'meeting:kind',
  closed: 'meeting:closed',
} as const;

/**
 * What the organization's web pages get in the desktop app (`window.crewhallDesktop`). The
 * meeting room relays `meet.control` data messages through `remoteControl`.
 */
export interface DesktopWebBridge {
  isDesktop: true;
  platform: string;
  /** The app's version, for display and support only: the web checks `features`. */
  version: string;
  /** What this bridge can do (common/client DESKTOP_FEATURES). */
  features: readonly DesktopFeature[];
  /**
   * Opens a meeting (a page of this server) in its own window, or brings it up when it is already
   * open. Resolves false when the address is not a page of the server.
   */
  openMeeting(url: string): Promise<boolean>;
  /** Opens one of the server's pages in a further window; false when it is not one. */
  openWindow(url: string): Promise<boolean>;
  /** The main window hears when a meeting window closed or left its meeting (its URL). */
  onMeetingClosed(listener: (url: string) => void): () => void;
  /** Which window this page is in. */
  windowKind(): Promise<'main' | 'meeting'>;
  /**
   * The window has no system title bar (common/titlebar): the page's top bar takes its place.
   * `set` says whether such a bar is on screen, its height and colours (for the window buttons).
   */
  /**
   * Our own file the page tried to open in a new window (feature `openFile`): show it in the
   * page's own viewer. Registering tells the app this page has one.
   */
  onOpenFile(listener: (file: { url: string; name: string }) => void): () => void;
  /** Windows locked, screen saver or sleep (feature `systemLock`): the vault locks at once. */
  onSystemLock(listener: () => void): () => void;
  /**
   * Vault unlock with Windows Hello (feature `vaultDevice`): the app keeps the device secret
   * encrypted and releases it after a Hello assertion it verifies. `userId` scopes it per person;
   * `stamp` is the vault's keyVersion and passwordChangedAt (a new password ends it).
   */
  vaultDevice: {
    status(userId: string, stamp: string): Promise<VaultDeviceStatus>;
    challenge(
      userId: string,
      purpose: 'enrol' | 'unlock',
    ): Promise<{ challenge: string; rpId: string; credentialId?: string }>;
    enrol(
      userId: string,
      input: {
        unlockId: string;
        secret: string;
        stamp: string;
        credential: VaultDeviceRegistration;
      },
    ): Promise<{ replaced: string | null }>;
    unlock(
      userId: string,
      assertion: VaultDeviceAssertion,
    ): Promise<{ unlockId: string; secret: string }>;
    passwordUnlocked(userId: string, stamp: string): Promise<unknown>;
    forget(userId: string): Promise<{ unlockId: string | null }>;
  };
  titleBar: {
    overlay: true;
    set(state: { owned: boolean; height: number; bg: string; fg: string }): void;
  };
  /**
   * Remote control, sharer side. The page owns the protocol (requests, grant/deny/revoke, audit);
   * the app asks on top of everything, applies the granted person's input and asks for a revoke
   * when the sharer takes control back.
   */
  remoteControl: {
    /** The local screen share started or stopped; true when it can be controlled. */
    shareChanged(active: boolean): Promise<{ controllable: boolean }>;
    /** Org or moderator policy. */
    setAllowed(allowed: boolean): void;
    /** People asking for control right now (the page's list). */
    setRequests(people: ControlPerson[]): void;
    /** Who the page granted control to, or null. */
    setController(person: ControlPerson | null): void;
    /** A `meet.control` message from a participant (JSON as received); input is applied. */
    input(identity: string, json: string): void;
    /** Left the room or lost the connection. */
    end(): void;
    /** The app's question was answered: the page grants or denies. */
    onAnswer(listener: (identity: string, yes: boolean) => void): () => void;
    /** The sharer took control back (Stop, shortcut, own mouse): the page revokes. */
    onRevoke(listener: (reason: string) => void): () => void;
  };
}
