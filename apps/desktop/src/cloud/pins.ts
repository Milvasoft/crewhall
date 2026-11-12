import { watch } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isRealLink } from '../sync/local';
import type { CloudFilesNative } from './native';

const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_PINNED = 0x80000;
const FILE_ATTRIBUTE_UNPINNED = 0x100000;
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x400000;

type Want = 'hydrate' | 'free';

/**
 * Explorer's two commands only set a mark, on every item inside a folder too, and the file system
 * passes a folder's mark on to what is created in it. Bringing the bytes or dropping them is left
 * to the provider. A freed file keeps its mark until something reads it: Windows clears it then, so
 * a file here with the mark still has to go.
 */
export function wantOf(attributes: number): Want | null {
  if (attributes & FILE_ATTRIBUTE_DIRECTORY) return null;
  const here = (attributes & FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS) === 0;
  if (attributes & FILE_ATTRIBUTE_PINNED) return here ? null : 'hydrate';
  if (attributes & FILE_ATTRIBUTE_UNPINNED) return here ? 'free' : null;
  return null;
}

export interface PinKeeperOptions {
  native: Pick<CloudFilesNative, 'attributes' | 'hydrate' | 'dehydrate'>;
  root: string;
  /** Is all of this file on the server? Only what is can lose its bytes here. */
  canFree: (abs: string) => Promise<boolean>;
  /** Paths relative to the root, as they change; returns the unsubscribe. */
  watchRoot?: (root: string, onChange: (name: string) => void, onGone: () => void) => () => void;
  now?: () => number;
  debounceMs?: number;
  retryMs?: number;
  maxHydrating?: number;
}

/** A failed try: how a program holding the file, or the network, gets its time. */
interface Waiting {
  want: Want;
  next: number;
  delay: number;
}

const DEBOUNCE_MS = 100;
const RETRY_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;
/**
 * A hydrate holds a pool thread until the file is here, and the bytes need one to arrive. The pool
 * has four, so these must stay fewer. A reader's download does not count, it holds none.
 */
const MAX_HYDRATING = 2;

/** Carries out "always keep on this device" and "free up space". */
export class PinKeeper {
  private stopped = true;
  private unwatch: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Paths to look at. */
  private readonly changed = new Set<string>();
  private readonly waiting = new Map<string, Waiting>();
  private readonly hydrateQueue: string[] = [];
  /** Hydrating, freeing or queued for either. */
  private readonly busy = new Set<string>();
  private hydrating = 0;
  private draining: Promise<void> | null = null;
  private sweeping: Promise<void> | null = null;

  constructor(private readonly options: PinKeeperOptions) {}

  /** Starts following changes, and catches up on what was asked for while the app was closed. */
  start(): void {
    this.stopped = false;
    this.attach();
    this.sweeping = this.sweep(this.options.root).finally(() => {
      this.sweeping = null;
    });
  }

  /** This file may need something done. */
  look(path: string): void {
    this.changed.add(path);
    this.schedule();
  }

  /** A pass finished: an upload that was in the way of freeing a file may be done. */
  afterPass(): void {
    for (const [path, waiting] of this.waiting) {
      if (waiting.want !== 'free') continue;
      waiting.next = 0;
      this.changed.add(path);
    }
    this.schedule();
  }

  /** The time has come for what failed earlier; and the watcher may need to come back. */
  tick(): void {
    if (this.stopped) return;
    this.attach();
    const at = this.now();
    for (const [path, waiting] of this.waiting) {
      if (waiting.next <= at) this.changed.add(path);
    }
    this.schedule();
  }

  /** Nothing new starts. A hydrate under way ends when its download fails or finishes. */
  stop(): void {
    this.stopped = true;
    this.unwatch?.();
    this.unwatch = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.changed.clear();
    this.hydrateQueue.length = 0;
  }

  async idle(): Promise<void> {
    while (
      this.sweeping ||
      this.draining ||
      this.timer ||
      this.hydrating > 0 ||
      this.hydrateQueue.length > 0
    ) {
      await (this.sweeping ?? this.draining ?? new Promise((r) => setTimeout(r, 10)));
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private attach(): void {
    if (this.unwatch) return;
    const watchRoot = this.options.watchRoot ?? defaultWatch;
    try {
      this.unwatch = watchRoot(
        this.options.root,
        (name) => this.look(join(this.options.root, name)),
        () => {
          this.unwatch = null;
        },
      );
    } catch {
      this.unwatch = null;
    }
  }

  private schedule(): void {
    if (this.stopped || this.timer || this.changed.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.draining ??= this.drain().finally(() => {
        this.draining = null;
        this.schedule();
      });
    }, this.options.debounceMs ?? DEBOUNCE_MS);
  }

  private async drain(): Promise<void> {
    for (const path of this.changed) {
      this.changed.delete(path);
      if (this.stopped) return;
      const attributes = await this.options.native.attributes(path).catch(() => null);
      if (attributes !== null) await this.act(path, attributes);
      else this.waiting.delete(path);
    }
  }

  private async sweep(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (this.stopped) return;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink() && (await isRealLink(path))) continue;
      const attributes = await this.options.native.attributes(path).catch(() => null);
      if (attributes === null) continue;
      if (attributes & FILE_ATTRIBUTE_DIRECTORY) await this.sweep(path);
      else await this.act(path, attributes);
    }
  }

  private async act(path: string, attributes: number): Promise<void> {
    const want = wantOf(attributes);
    if (!want) {
      this.waiting.delete(path);
      return;
    }
    if (this.busy.has(path)) return;
    // Trying may itself show up as a change: only time, or being asked for the other thing, counts.
    const waiting = this.waiting.get(path);
    if (waiting?.want === want && waiting.next > this.now()) return;
    if (want === 'free') await this.free(path);
    else this.hydrate(path);
  }

  private async free(path: string): Promise<void> {
    this.busy.add(path);
    try {
      if (!(await this.options.canFree(path))) {
        this.defer(path, 'free');
        return;
      }
      await this.options.native.dehydrate(path);
      this.waiting.delete(path);
    } catch {
      // Open in a program, changed since it was last marked, or not uploaded yet.
      this.defer(path, 'free');
    } finally {
      this.busy.delete(path);
    }
  }

  private hydrate(path: string): void {
    this.busy.add(path);
    this.hydrateQueue.push(path);
    this.pumpHydrates();
  }

  private pumpHydrates(): void {
    const max = this.options.maxHydrating ?? MAX_HYDRATING;
    while (!this.stopped && this.hydrating < max) {
      const path = this.hydrateQueue.shift();
      if (!path) return;
      this.hydrating++;
      void this.options.native
        .hydrate(path)
        .then(
          () => this.waiting.delete(path),
          () => this.defer(path, 'hydrate'),
        )
        .finally(() => {
          this.busy.delete(path);
          this.hydrating--;
          this.pumpHydrates();
        });
    }
  }

  private defer(path: string, want: Want): void {
    const first = this.options.retryMs ?? RETRY_MS;
    const previous = this.waiting.get(path);
    const delay =
      previous?.want === want ? Math.min(previous.delay * 2, Math.max(first, RETRY_MAX_MS)) : first;
    this.waiting.set(path, { want, next: this.now() + delay, delay });
  }
}

function defaultWatch(
  root: string,
  onChange: (name: string) => void,
  onGone: () => void,
): () => void {
  let closed = false;
  const close = () => {
    closed = true;
    watcher.close();
  };
  const watcher = watch(root, { recursive: true }, (_event, name) => {
    if (closed || !name) return;
    // Windows names the folder itself, absolutely, once it is deleted, and goes on doing so.
    if (isAbsolute(String(name))) {
      close();
      onGone();
      return;
    }
    onChange(String(name));
  });
  watcher.on('error', () => undefined);
  return close;
}
