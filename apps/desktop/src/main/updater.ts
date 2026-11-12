import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateState } from '../common/ipc';
import { feedUrlFor, isNoRelease } from '../common/update';
import type { DesktopApp } from './app';

const SIX_HOURS = 6 * 60 * 60 * 1000;

/**
 * electron-updater over the organization's own server: the generic feed at
 * `<server>/api/v1/desktop/updates/<win|mac>/` (latest.yml, installer, blockmap). There is no
 * separate update server; when the server changes, the feed changes with it. A 404 means the
 * server hosts no release: "up to date". Never a downgrade: only a newer version installs.
 *
 * No code signing certificate yet: Windows installs unsigned updates (SmartScreen may warn on
 * first install); macOS (Squirrel.Mac) refuses unsigned updates, so mac users update by hand.
 */
export class Updater {
  state: UpdateState = { state: 'disabled' };
  private timer: ReturnType<typeof setInterval> | null = null;
  private feed: string | null = null;
  private wired = false;

  constructor(private readonly d: DesktopApp) {}

  start(): void {
    if (!app.isPackaged) return;
    // The Microsoft Store installs its own updates; a downloaded installer could not replace a
    // package anyway.
    if (!this.d.dist.selfUpdate) return this.set({ state: 'store' });
    if (!this.wired) {
      this.wired = true;
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.allowDowngrade = false;
      autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }));
      autoUpdater.on('update-not-available', () => this.set({ state: 'none' }));
      autoUpdater.on('update-available', (info) =>
        this.set({ state: 'available', version: info.version }),
      );
      autoUpdater.on('update-downloaded', (info) =>
        this.set({ state: 'downloaded', version: info.version }),
      );
      autoUpdater.on('error', (err) => this.failed(err));
      this.timer = setInterval(() => this.check(), SIX_HOURS);
    }
    this.configure();
  }

  /** Points the updater at the current server (called on start and when the server changes). */
  configure(): void {
    if (!this.wired) return;
    const feed = feedUrlFor(this.d.origin, process.platform, this.d.settings.get().updateUrl);
    if (feed === this.feed) return;
    this.feed = feed;
    if (!feed) {
      this.set({ state: 'disabled' });
      return;
    }
    // One range per request: the server answers single ranges only.
    autoUpdater.setFeedURL({ provider: 'generic', url: feed, useMultipleRangeRequest: false });
    if (this.state.state !== 'downloaded') this.set({ state: 'idle' });
    setTimeout(() => this.check(), 15_000);
  }

  check(): void {
    if (!this.feed || this.state.state === 'downloaded' || this.state.state === 'checking') return;
    autoUpdater.checkForUpdates().catch((err: unknown) => this.failed(err));
  }

  install(): void {
    if (this.state.state !== 'downloaded') return;
    this.d.quitting = true;
    autoUpdater.quitAndInstall();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private failed(err: unknown): void {
    if (isNoRelease(err)) return this.set({ state: 'none' });
    console.warn(`[update] ${err instanceof Error ? err.message : String(err)}`);
    this.set({ state: 'error' });
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.d.onUpdateState(state);
  }
}
