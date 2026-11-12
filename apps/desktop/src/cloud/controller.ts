import type { DriveProblem, VirtualDriveView } from '../common/virtual-drive';
import type { PairStatus } from '../sync/engine';
import type { CloudSpace } from './drive';

/** What is kept between runs. `userId`: whose files are on disk; `account`: the sync root's id. */
export interface DriveSettings {
  enabled: boolean;
  root: string | null;
  userId: string | null;
}

/** The part of `CloudDrive` this needs. */
export interface DriveHandle {
  start(spaces: CloudSpace[]): Promise<void>;
  stop(): Promise<void>;
  remove(): Promise<void>;
  setSpaces(spaces: CloudSpace[]): Promise<void>;
  notifyChange(): void;
  syncNow(): void;
  confirmDeletes(pairId: string): void;
  statuses(): PairStatus[];
}

export interface ControllerDeps {
  settings(): DriveSettings;
  save(patch: Partial<DriveSettings>): void;
  defaultRoot(): string;
  /** A drive on this folder; `onSpacesChanged` when the feed says the list of spaces changed. */
  createDrive(root: string, onSpacesChanged: () => void): DriveHandle;
  /** The signed-in person; rejects with `status` 401 when nobody is. */
  me(): Promise<string>;
  listSpaces(): Promise<CloudSpace[]>;
  /** Why this folder cannot hold the drive. */
  checkRoot(root: string): Promise<DriveProblem | null>;
  onChange(): void;
  onStartFailed?(err: unknown): void;
  /** How long to wait before each new try after a failed start; the last one repeats. */
  retryDelaysMs?: readonly number[];
}

/** Soon at first: a server restarting or a network coming up is usually back within seconds. */
const RETRY_DELAYS_MS = [2_000, 10_000, 60_000];

function errorOf(err: unknown): NonNullable<VirtualDriveView['error']> {
  if ((err as { status?: unknown } | null)?.status === 401) {
    return { code: 'signed_out', details: {} };
  }
  return { code: 'failed', details: { text: err instanceof Error ? err.message : String(err) } };
}

/** Turns the drive on and off with the setting, the server connection and who is signed in. */
export class DriveController {
  private drive: DriveHandle | null = null;
  private spaces: CloudSpace[] = [];
  private state: VirtualDriveView['state'] = 'off';
  private error: VirtualDriveView['error'] = null;
  private wanted = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  /** One step at a time: turning it on and off quickly must not overlap. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ControllerDeps) {}

  get root(): string {
    return this.deps.settings().root ?? this.deps.defaultRoot();
  }

  /** The server connection is up: start if the person wants the drive. */
  connect(): Promise<void> {
    this.wanted = true;
    return this.enqueue(() => this.bringUp());
  }

  /** The server connection is down: the files stay, showing as unavailable. */
  disconnect(): Promise<void> {
    this.wanted = false;
    return this.enqueue(() => this.takeDown());
  }

  /** A hint from the server, or the page signed in and it is worth trying again. */
  notifyChange(): void {
    if (this.drive) this.drive.notifyChange();
    else if (this.wanted && this.state === 'error') void this.enqueue(() => this.bringUp());
  }

  syncNow(): void {
    this.drive?.syncNow();
  }

  confirmDeletes(pairId: string): void {
    this.drive?.confirmDeletes(pairId);
  }

  async setEnabled(
    on: boolean,
    root?: string,
  ): Promise<{ ok: true } | { ok: false; error: DriveProblem }> {
    return this.enqueue(async () => {
      if (!on) {
        await this.takeOff();
        return { ok: true as const };
      }
      const wanted = root ?? this.root;
      const problem = await this.deps.checkRoot(wanted);
      if (problem) return { ok: false as const, error: problem };
      this.deps.save({ enabled: true, root: wanted });
      await this.bringUp();
      return { ok: true as const };
    });
  }

  /** The folder to use once it is switched on. */
  setRoot(root: string): void {
    if (!this.deps.settings().enabled) this.deps.save({ root });
    this.deps.onChange();
  }

  /** Signing out of this server for good: nothing of it stays on the computer. */
  remove(): Promise<void> {
    this.wanted = false;
    return this.enqueue(() => this.takeOff());
  }

  view(): VirtualDriveView {
    const statuses = this.drive?.statuses() ?? [];
    return {
      enabled: this.deps.settings().enabled,
      root: this.root,
      state: this.state,
      error: this.error,
      spaces: this.spaces.map((space) => ({
        ...space,
        status: statuses.find((s) => s.id === `space-${space.id}`) ?? null,
      })),
      fetches: [],
    };
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private set(state: VirtualDriveView['state'], error: VirtualDriveView['error'] = null): void {
    this.state = state;
    this.error = error;
    this.deps.onChange();
  }

  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  private async bringUp(): Promise<void> {
    const settings = this.deps.settings();
    this.clearRetry();
    if (!settings.enabled || !this.wanted) {
      this.set('off');
      return;
    }
    if (this.drive) {
      this.set('running');
      return;
    }
    this.set('starting');
    const root = this.root;
    let drive: DriveHandle | null = null;
    try {
      const userId = await this.deps.me();
      // Someone else's files are on this computer: they go first, as if that person signed out.
      if (settings.userId && settings.userId !== userId) {
        await this.deps.createDrive(root, () => undefined).remove();
      }
      this.deps.save({ userId });
      this.spaces = await this.deps.listSpaces();
      drive = this.deps.createDrive(root, () => void this.refreshSpaces());
      await drive.start(this.spaces);
      this.drive = drive;
      this.failures = 0;
      this.set('running');
    } catch (err) {
      await drive?.stop().catch(() => undefined);
      this.deps.onStartFailed?.(err);
      this.set('error', errorOf(err));
      const delays = this.deps.retryDelaysMs ?? RETRY_DELAYS_MS;
      const delay = delays[Math.min(this.failures, delays.length - 1)];
      this.failures++;
      this.retry = setTimeout(() => void this.enqueue(() => this.bringUp()), delay);
    }
  }

  private async takeDown(): Promise<void> {
    this.clearRetry();
    this.failures = 0;
    const drive = this.drive;
    this.drive = null;
    await drive?.stop().catch(() => undefined);
    this.set('off');
  }

  private async takeOff(): Promise<void> {
    await this.takeDown();
    const { enabled, userId } = this.deps.settings();
    if (enabled || userId) {
      await this.deps
        .createDrive(this.root, () => undefined)
        .remove()
        .catch(() => undefined);
    }
    this.spaces = [];
    this.deps.save({ enabled: false, userId: null });
    this.set('off');
  }

  private refreshSpaces(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.drive) return;
      try {
        this.spaces = await this.deps.listSpaces();
        await this.drive.setSpaces(this.spaces);
        this.deps.onChange();
      } catch {
        // The next change from the feed asks again.
      }
    });
  }
}
