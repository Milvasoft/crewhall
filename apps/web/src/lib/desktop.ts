/**
 * What the Crewhall desktop app (apps/desktop, preload) exposes to these pages. Absent in a
 * browser. Kept structural: the web app does not depend on the desktop package.
 */
export interface ControlPerson {
  identity: string;
  name: string;
}

/** Remote control, sharer side (apps/desktop src/common/ipc.ts `DesktopWebBridge`). */
export interface DesktopRemoteControlBridge {
  shareChanged(active: boolean): Promise<{ controllable: boolean }>;
  setAllowed(allowed: boolean): void;
  setRequests(people: ControlPerson[]): void;
  setController(person: ControlPerson | null): void;
  input(identity: string, json: string): void;
  end(): void;
  onAnswer(listener: (identity: string, yes: boolean) => void): () => void;
  onRevoke(listener: (reason: string) => void): () => void;
}

/**
 * What a desktop app can do (apps/desktop src/common/client.ts). Each organization runs its own
 * server version and desktop apps update on their own: ask for a feature with desktopHas(),
 * never compare versions.
 */
export type DesktopFeature =
  | 'openMeeting'
  | 'meetingClosed'
  | 'windowKind'
  | 'remoteControl'
  | 'titleBar'
  | 'webauthn'
  | 'vaultDevice'
  | 'systemLock'
  | 'openFile'
  | 'openWindow';

export interface DesktopBridge {
  isDesktop: true;
  platform: string;
  /** The app's version: for display and support only. */
  version?: string;
  /** What this app's bridge offers; absent before desktop 0.2.5. */
  features?: readonly string[];
  /** Opens a meeting (a page of this server) in its own window; false when it is not one. */
  openMeeting?(url: string): Promise<boolean>;
  /** Opens one of this server's pages in a further window; false when it is not one. */
  openWindow?(url: string): Promise<boolean>;
  /** In the main window: a meeting window closed or left its meeting (its URL). */
  onMeetingClosed?(listener: (url: string) => void): () => void;
  /** Which window this page is in (a meeting window can hide the app navigation). */
  windowKind?(): Promise<'main' | 'meeting'>;
  remoteControl?: DesktopRemoteControlBridge;
  /** The window has no system title bar: a top bar of the page takes its place (desktop-titlebar). */
  titleBar?: DesktopTitleBarBridge;
  /**
   * One of our files (image, PDF, video) the page tried to open in a new window: show it in the
   * shared viewer instead (feature `openFile`). Registering tells the app this page has one.
   */
  onOpenFile?(listener: (file: { url: string; name: string }) => void): () => void;
  /** Windows locked, screen saver or sleep: the vault locks at once (lib/vault/autolock). */
  onSystemLock?(listener: () => void): () => void;
  /** Vault unlock with Windows Hello / Touch ID (lib/vault/desktop-device). */
  vaultDevice?: DesktopVaultDeviceBridge;
}

/** apps/desktop src/common/titlebar.ts: what the window buttons need from the page. */
export interface DesktopTitleBarState {
  /** A bar marked `data-titlebar` is on screen; else the app keeps a thin strip above the page. */
  owned: boolean;
  height: number;
  /** CSS colours (hex) of the bar and its text: the window buttons take them. */
  bg: string;
  fg: string;
}

/** apps/desktop src/common/ipc.ts DesktopWebBridge.vaultDevice; WebAuthn results in base64url. */
export interface DesktopVaultDeviceBridge {
  status(
    userId: string,
    stamp: string,
  ): Promise<
    | { available: false }
    | { available: true; enrolled: false; stale?: string }
    | { available: true; enrolled: true; usable: boolean; unlockId: string }
  >;
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
      credential: {
        credentialId: string;
        clientDataJSON: string;
        authenticatorData: string;
        publicKey: string;
        alg: number;
      };
    },
  ): Promise<{ replaced: string | null }>;
  unlock(
    userId: string,
    assertion: {
      credentialId: string;
      clientDataJSON: string;
      authenticatorData: string;
      signature: string;
    },
  ): Promise<{ unlockId: string; secret: string }>;
  passwordUnlocked(userId: string, stamp: string): Promise<unknown>;
  forget(userId: string): Promise<{ unlockId: string | null }>;
}

export interface DesktopTitleBarBridge {
  overlay: true;
  set(state: DesktopTitleBarState): void;
}

declare global {
  interface Window {
    /** Desktop app preload (apps/desktop src/preload). */
    crewhallDesktop?: DesktopBridge;
  }
}

export function desktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const b = window.crewhallDesktop;
  return b?.isDesktop ? b : null;
}

/** Desktop apps before the feature list: what their bridge had, by member. */
const LEGACY: Partial<Record<DesktopFeature, keyof DesktopBridge>> = {
  openMeeting: 'openMeeting',
  meetingClosed: 'onMeetingClosed',
  windowKind: 'windowKind',
  remoteControl: 'remoteControl',
};

/** This page runs in a desktop app that can do `feature`. False in a browser. */
export function desktopHas(feature: DesktopFeature): boolean {
  const b = desktopBridge();
  if (!b) return false;
  if (Array.isArray(b.features)) return b.features.includes(feature);
  const member = LEGACY[feature];
  return member !== undefined && b[member] !== undefined;
}
