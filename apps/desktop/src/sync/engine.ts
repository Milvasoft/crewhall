import { watch } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isIgnored, type SyncPlatform } from './names';
import { runPass, SyncError, type PassOptions, type PassStats } from './pass';
import type { RemoteDrive } from './remote';
import type { BaseEntry, SkippedItem, Snapshot } from './types';

/** A Drive folder (or a whole space) paired with a local folder. */
export interface SyncPair {
  id: string;
  spaceId: string;
  spaceName: string;
  /** Null: the whole space. */
  folderId: string | null;
  /** Shown in the list: "Projeler / 2026". */
  folderPath: string;
  localPath: string;
  paused: boolean;
}

export type PairState = 'idle' | 'syncing' | 'error' | 'paused' | 'confirm';

/** `code` is an i18n key under web.desktop.sync.errors. */
export interface PairError {
  code: 'local_root_missing' | 'remote_root_missing' | 'mass_delete' | 'signed_out' | 'failed';
  details: Record<string, number | string>;
}

export interface PairStatus {
  id: string;
  state: PairState;
  lastSyncAt: string | null;
  error: PairError | null;
  progress: { done: number; total: number } | null;
  stats: PassStats | null;
  skipped: SkippedItem[];
  /** Items that failed in the last pass (locked files, network). */
  failed: Array<{ path: string; message: string }>;
}

export interface EngineDeps {
  createDrive: () => RemoteDrive;
  platform: SyncPlatform;
  device: () => string;
  conflictLabel: () => string;
  trash: (abs: string) => Promise<void>;
  /** Where each pair's last synced state is kept (never inside the synced folder). */
  stateDir: string;
  onStatus: (statuses: PairStatus[]) => void;
  /**
   * Local change feed; defaults to a recursive fs.watch. Returns the unsubscribe. `onGone`: it
   * stopped by itself, because the folder went away.
   */
  watchFolder?: (root: string, onChange: () => void, onGone: () => void) => () => void;
  /** Full pass even without change events. */
  intervalMs?: number;
  /** Wait for a burst of changes to end. */
  debounceMs?: number;
  /** What this engine's passes need beyond the above: the virtual drive, the file attributes. */
  passOptions?: () => Pick<PassOptions, 'materializer' | 'listing' | 'attributes'>;
  /** A pair's pass ended, however it went. */
  onPassDone?: (pairId: string) => void;
}

type BaseFile = { version: 1; entries: Array<[string, BaseEntry]> };

interface Slot {
  pair: SyncPair;
  status: PairStatus;
  /** As saved after the last pass; null until one has read it. */
  base: Snapshot<BaseEntry> | null;
  running: boolean;
  queued: boolean;
  allowMassDelete: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  unwatch: (() => void) | null;
}

/** Runs the passes of every pair: on start, on local and remote changes, and on an interval. */
export class SyncEngine {
  private readonly slots = new Map<string, Slot>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly deps: EngineDeps) {}

  setPairs(pairs: SyncPair[]): void {
    const next = new Map(pairs.map((p) => [p.id, p]));
    for (const [id, slot] of this.slots) {
      if (!next.has(id)) {
        this.release(slot);
        this.slots.delete(id);
        void rm(this.statePath(id), { force: true });
      }
    }
    for (const pair of pairs) {
      const slot = this.slots.get(pair.id);
      if (slot) {
        const resumed = slot.pair.paused && !pair.paused;
        slot.pair = pair;
        if (pair.paused) {
          this.release(slot);
          slot.status = { ...slot.status, state: 'paused', progress: null };
        } else if (resumed) {
          slot.status = { ...slot.status, state: 'idle' };
          this.attach(slot);
          this.schedule(slot, 0);
        }
      } else {
        const created: Slot = {
          pair,
          status: emptyStatus(pair.id, pair.paused ? 'paused' : 'idle'),
          base: null,
          running: false,
          queued: false,
          allowMassDelete: false,
          timer: null,
          unwatch: null,
        };
        this.slots.set(pair.id, created);
        if (!pair.paused) {
          this.attach(created);
          this.schedule(created, 0);
        }
      }
    }
    if (!this.interval && !this.stopped) {
      this.interval = setInterval(() => this.syncNow(), this.deps.intervalMs ?? 5 * 60_000);
    }
    this.emit();
  }

  /** Pass for one pair, or all of them. */
  syncNow(pairId?: string): void {
    for (const slot of this.slots.values()) {
      if (!pairId || slot.pair.id === pairId) this.schedule(slot, 0);
    }
  }

  /** Something changed in a Drive space (WebSocket `node.updated`). */
  notifyRemoteChange(spaceId: string): void {
    for (const slot of this.slots.values()) {
      if (slot.pair.spaceId === spaceId) this.schedule(slot);
    }
  }

  /** The person confirmed the large delete the last pass stopped at. */
  confirmDeletes(pairId: string): void {
    const slot = this.slots.get(pairId);
    if (!slot) return;
    slot.allowMassDelete = true;
    this.schedule(slot, 0);
  }

  statuses(): PairStatus[] {
    return [...this.slots.values()].map((s) => s.status);
  }

  /** What the last pass recorded for this path; undefined before the first pass of this run. */
  synced(pairId: string, path: string): BaseEntry | undefined {
    return this.slots.get(pairId)?.base?.get(path);
  }

  /** Pauses a pair and waits for its pass, until the next `setPairs` lists it unpaused. */
  async hold(pairId: string): Promise<void> {
    const slot = this.slots.get(pairId);
    if (!slot) return;
    slot.pair = { ...slot.pair, paused: true };
    slot.queued = false;
    this.release(slot);
    while (slot.running) await new Promise((r) => setTimeout(r, 10));
    slot.status = { ...slot.status, state: 'paused', progress: null };
  }

  /** Starts a pair over: without its last synced state, what is missing no longer reads as deleted. */
  async forget(pairId: string): Promise<void> {
    await this.hold(pairId);
    await rm(this.statePath(pairId), { force: true });
  }

  /** Waits for running passes; used on quit and in tests. */
  async idle(): Promise<void> {
    while ([...this.slots.values()].some((s) => s.running || s.timer)) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    for (const slot of this.slots.values()) this.release(slot);
  }

  private attach(slot: Slot): void {
    if (slot.unwatch) return;
    const watchFolder = this.deps.watchFolder ?? defaultWatch;
    try {
      slot.unwatch = watchFolder(
        slot.pair.localPath,
        () => this.schedule(slot),
        () => {
          slot.unwatch = null;
          this.schedule(slot);
        },
      );
    } catch {
      // A missing folder fails the pass with a clear error; the interval keeps retrying.
      slot.unwatch = null;
    }
  }

  private release(slot: Slot): void {
    slot.unwatch?.();
    slot.unwatch = null;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
  }

  private schedule(slot: Slot, delay = this.deps.debounceMs ?? 2000): void {
    if (this.stopped || slot.pair.paused) return;
    if (slot.running) {
      slot.queued = true;
      return;
    }
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => {
      slot.timer = null;
      void this.run(slot);
    }, delay);
  }

  private async run(slot: Slot): Promise<void> {
    if (slot.running || this.stopped) return;
    slot.running = true;
    this.update(slot, { state: 'syncing', progress: null });
    const { pair } = slot;
    try {
      let base = await this.loadBase(pair.id);
      slot.base = base;
      // Conflict copies are uploaded by the pass after the one that made them.
      for (let round = 0; round < 3; round++) {
        const result = await runPass({
          root: pair.localPath,
          spaceId: pair.spaceId,
          folderId: pair.folderId,
          drive: this.deps.createDrive(),
          base,
          platform: this.deps.platform,
          device: this.deps.device(),
          conflictLabel: this.deps.conflictLabel(),
          trash: this.deps.trash,
          allowMassDelete: slot.allowMassDelete,
          ...this.deps.passOptions?.(),
          onProgress: (done, total) => this.update(slot, { progress: { done, total } }),
        });
        slot.allowMassDelete = false;
        base = result.base;
        await this.saveBase(pair.id, base);
        slot.base = base;
        this.update(slot, {
          state: 'idle',
          error: null,
          progress: null,
          lastSyncAt: new Date().toISOString(),
          stats: result.stats,
          skipped: result.skipped,
          failed: result.errors.map((e) => ({ path: e.path, message: e.message })),
        });
        if (!result.again) break;
      }
    } catch (err) {
      const error = toPairError(err);
      this.update(slot, {
        state: error.code === 'mass_delete' ? 'confirm' : 'error',
        error,
        progress: null,
      });
    } finally {
      slot.running = false;
      this.deps.onPassDone?.(pair.id);
      // The folder went away and may be back.
      if (!slot.pair.paused && !this.stopped) this.attach(slot);
      if (slot.queued) {
        slot.queued = false;
        this.schedule(slot);
      }
    }
  }

  private update(slot: Slot, patch: Partial<PairStatus>): void {
    slot.status = { ...slot.status, ...patch };
    if (slot.pair.paused) slot.status.state = 'paused';
    this.emit();
  }

  private emit(): void {
    // A failing listener (tray, window) must never fail a sync pass.
    try {
      this.deps.onStatus(this.statuses());
    } catch {
      // ignore
    }
  }

  private statePath(pairId: string): string {
    return join(this.deps.stateDir, `${pairId.replace(/[^\w-]/g, '_')}.json`);
  }

  private async loadBase(pairId: string): Promise<Snapshot<BaseEntry>> {
    try {
      const file = JSON.parse(await readFile(this.statePath(pairId), 'utf8')) as BaseFile;
      return new Map(file.version === 1 ? file.entries : []);
    } catch {
      return new Map();
    }
  }

  private async saveBase(pairId: string, base: Snapshot<BaseEntry>): Promise<void> {
    await mkdir(this.deps.stateDir, { recursive: true });
    const file: BaseFile = { version: 1, entries: [...base.entries()] };
    const path = this.statePath(pairId);
    // Write then rename, so a crash never leaves half a state file (which would read as "new").
    await writeFile(`${path}.tmp`, JSON.stringify(file));
    await rename(`${path}.tmp`, path);
  }
}

function emptyStatus(id: string, state: PairState): PairStatus {
  return {
    id,
    state,
    lastSyncAt: null,
    error: null,
    progress: null,
    stats: null,
    skipped: [],
    failed: [],
  };
}

export function toPairError(err: unknown): PairError {
  if (err instanceof SyncError) return { code: err.code, details: err.details };
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 401) return { code: 'signed_out', details: {} };
  return { code: 'failed', details: { text: err instanceof Error ? err.message : String(err) } };
}

function defaultWatch(root: string, onChange: () => void, onGone: () => void): () => void {
  let closed = false;
  const close = () => {
    closed = true;
    watcher.close();
  };
  const watcher = watch(root, { recursive: true }, (_event, name) => {
    if (closed) return;
    // Windows names the folder itself, absolutely, once it is deleted, and goes on doing so as fast
    // as it can: a flood that would keep the debounce from ever running a pass.
    if (name && isAbsolute(String(name))) {
      close();
      onGone();
      return;
    }
    const leaf = name ? String(name).split(/[\\/]/).pop() : undefined;
    if (leaf && isIgnored(leaf)) return;
    onChange();
  });
  watcher.on('error', () => undefined);
  return close;
}
