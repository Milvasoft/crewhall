import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { app, session } from 'electron';
import { DriveController } from '../cloud/controller';
import { CloudDrive, takeOffComputer } from '../cloud/drive';
import type { FetchProgress } from '../cloud/fetch-server';
import { loadCloudFiles, type CloudFilesNative } from '../cloud/native';
import {
  DRIVE_CAPABILITY,
  SHOW_FETCH_FROM_BYTES,
  driveAccount,
  foldersOverlap,
  type DriveFetchView,
  type VirtualDriveView,
} from '../common/virtual-drive';
import type { PairStatus } from '../sync/engine';
import { createApiDrive, createChangeFeed, createContentSource } from '../sync/remote';
import type { DesktopApp } from './app';
import type { SettingsStore } from './settings';

/**
 * Only a packaged app registers with Explorer, and under its own name: a development run must not
 * show up in the navigation pane or touch the real drive's registration.
 */
const provider = (): string => (app.isPackaged ? 'Crewhall' : 'CrewhallDev');

const stateDir = (): string => join(app.getPath('userData'), 'virtual-drive');

const rootOptions = (root: string, account: string) => ({
  root,
  provider: provider(),
  account,
  shell: app.isPackaged,
});

/** The app's side of the virtual drive; the logic is in cloud/controller and cloud/drive. */
export class VirtualDrive {
  private readonly native: CloudFilesNative | null = loadCloudFiles();
  private readonly controller: DriveController;
  private readonly fetches = new Map<string, DriveFetchView>();
  private lastPush = 0;

  constructor(private readonly d: DesktopApp) {
    this.controller = new DriveController({
      settings: () => d.settings.get().virtualDrive,
      save: (patch) =>
        d.settings.update({ virtualDrive: { ...d.settings.get().virtualDrive, ...patch } }),
      defaultRoot: () => join(app.getPath('home'), 'Crewhall'),
      createDrive: (root, onSpacesChanged) => this.createDrive(root, onSpacesChanged),
      me: async () => (await d.api().call('me')).user.id,
      listSpaces: async () => {
        const { items } = await d.api().call('listSpaces', { query: {} });
        return items.map((s) => ({ id: s.id, name: s.name }));
      },
      checkRoot: (root) => this.checkRoot(root),
      onChange: () => d.pushSettings(),
      onStartFailed: (err) => console.warn('[drive] could not start', err),
    });
  }

  /** Reads attributes for ordinary sync pairs, which need no server support; undefined without it. */
  get attributes(): ((abs: string) => Promise<number>) | undefined {
    const native = this.native;
    return native ? (abs) => native.attributes(abs) : undefined;
  }

  /** The server offers the feed and the add-on is here. */
  get available(): boolean {
    const capabilities = this.d.settings.get().brand?.capabilities ?? [];
    return this.native !== null && capabilities.includes(DRIVE_CAPABILITY);
  }

  view(): VirtualDriveView | null {
    if (!this.available) return null;
    return { ...this.controller.view(), fetches: [...this.fetches.values()] };
  }

  connect(): void {
    if (this.available) void this.controller.connect();
  }

  disconnect(): void {
    void this.controller.disconnect();
  }

  notifyChange(): void {
    this.controller.notifyChange();
  }

  syncNow(): void {
    this.controller.syncNow();
  }

  confirmDeletes(pairId: string): void {
    this.controller.confirmDeletes(pairId);
  }

  setEnabled(on: boolean): ReturnType<DriveController['setEnabled']> {
    if (!this.available) return Promise.resolve({ ok: false, error: 'failed' });
    return this.controller.setEnabled(on);
  }

  setRoot(root: string): void {
    this.controller.setRoot(root);
  }

  /** Before the server changes, while its id is still known. */
  remove(): Promise<void> {
    return this.native ? this.controller.remove() : Promise.resolve();
  }

  get root(): string {
    return this.controller.root;
  }

  private async checkRoot(root: string) {
    for (const pair of this.d.settings.get().syncPairs) {
      if (foldersOverlap(root, pair.localPath, process.platform)) return 'overlap' as const;
    }
    // Anything already here would read as made here, and its folders as spaces.
    const entries = await readdir(root).catch(() => [] as string[]);
    return entries.length > 0 ? ('notEmpty' as const) : null;
  }

  private onFetch(progress: FetchProgress): void {
    if (progress.total < SHOW_FETCH_FROM_BYTES) return;
    const { path, done, total, state } = progress;
    const finished = state !== 'running';
    if (finished) this.fetches.delete(path);
    else this.fetches.set(path, { path: basename(path), done, total });
    const now = Date.now();
    if (finished || now - this.lastPush > 500) {
      this.lastPush = now;
      this.d.pushSettings();
    }
  }

  private createDrive(root: string, onSpacesChanged: () => void): CloudDrive {
    const native = this.native;
    if (!native) throw new Error('no add-on');
    const fetchOut = (url: string, init?: RequestInit) =>
      session.defaultSession.fetch(url, { ...init, credentials: 'omit' });
    const origin = this.d.origin ?? '';
    return new CloudDrive({
      native,
      ...rootOptions(root, driveAccount(hash, origin)),
      version: app.getVersion(),
      displayName: this.d.appName,
      icon: `${process.execPath},0`,
      stateName: this.d.t('desktop.sync.drive.itemState'),
      describeProblem: (reason) =>
        reason
          ? this.d.t(`desktop.sync.skipReasons.${reason}`)
          : this.d.t('desktop.sync.drive.notSynced'),
      stateDir: stateDir(),
      createDrive: () => createApiDrive(this.d.api(), fetchOut),
      feed: createChangeFeed(this.d.api()),
      source: createContentSource(this.d.api(), fetchOut),
      platform: 'win32',
      device: () => hostname(),
      conflictLabel: () => this.d.t('desktop.sync.conflictLabel'),
      onStatus: (statuses: PairStatus[]) => this.d.onDriveStatus(statuses),
      onFetch: (progress) => this.onFetch(progress),
      onSpacesChanged,
      onPollError: (err) => console.warn('[drive] reading the feed failed', err),
    });
  }
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The uninstaller's `--remove-virtual-drive`: no window, no server, only what is on this computer. */
export async function removeVirtualDriveForUninstall(settings: SettingsStore): Promise<void> {
  const { enabled, userId, root } = settings.get().virtualDrive;
  const native = loadCloudFiles();
  if (!native || (!enabled && !userId)) return;
  const origin = settings.get().serverUrl ?? '';
  const folder = root ?? join(app.getPath('home'), 'Crewhall');
  await takeOffComputer(native, rootOptions(folder, driveAccount(hash, origin)), stateDir());
  settings.update({ virtualDrive: { enabled: false, root, userId: null } });
  await settings.flush();
}
