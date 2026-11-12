import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { SyncEngine, type EngineDeps, type PairStatus, type SyncPair } from '../sync/engine';
import { isIgnored, localNameProblem, type SyncPlatform } from '../sync/names';
import { statLocal } from '../sync/local';
import type { RemoteDrive } from '../sync/remote';
import { localFingerprint } from '../sync/types';
import { FetchServer, type ContentSource, type FetchProgress } from './fetch-server';
import { ItemStates } from './item-states';
import { createMaterializer } from './materializer';
import { RemoteMirror, type ChangeFeed } from './mirror';
import type { CloudFilesNative, CloudRootOptions } from './native';
import { PinKeeper } from './pins';

export interface CloudSpace {
  id: string;
  name: string;
}

export interface CloudDriveDeps {
  native: CloudFilesNative;
  /** The folder the drive shows up as; each space is a folder in it. */
  root: string;
  provider: string;
  account: string;
  version: string;
  displayName?: string;
  icon?: string;
  /** What Explorer calls the warning on a file that cannot be synced. */
  stateName?: string;
  /**
   * The warning's text, in the person's language: a `SkippedItem.reason`, `outside_space` for what
   * lies directly in the drive, or null for a file that failed. Without it no warnings are shown.
   */
  describeProblem?: (reason: string | null) => string;
  /** Also adds the folder to Explorer's navigation pane. */
  shell: boolean;
  /** Never inside the drive. */
  stateDir: string;
  createDrive: () => RemoteDrive;
  feed: ChangeFeed;
  source: ContentSource;
  platform: SyncPlatform;
  device: () => string;
  conflictLabel: () => string;
  onStatus: (statuses: PairStatus[]) => void;
  onFetch?: (progress: FetchProgress) => void;
  /** The feed says spaces were added, removed or renamed: read them and call `setSpaces`. */
  onSpacesChanged?: () => void;
  onPollError?: (err: unknown) => void;
  watchFolder?: EngineDeps['watchFolder'];
  debounceMs?: number;
  intervalMs?: number;
  /** How often the feed is read without a hint from the server. */
  pollMs?: number;
}

const POLL_MS = 60_000;

/**
 * Folder names for spaces on this computer: what the OS would refuse becomes "_", and a name taken
 * gets a number. Whoever had a name keeps it, so a new space never takes over another's folder.
 */
export function spaceFolders(
  spaces: CloudSpace[],
  platform: SyncPlatform,
  known: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  const key = (name: string) => (platform === 'linux' ? name : name.toLowerCase());
  const clean = (name: string): string => {
    // eslint-disable-next-line no-control-regex -- control characters are exactly what Windows forbids
    const bare = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
    if (!bare) return '_';
    return localNameProblem(bare, platform) ? `_${bare}` : bare;
  };
  const claim = (space: CloudSpace, name: string) => {
    out.set(space.id, name);
    taken.add(key(name));
  };
  // Unchanged names first, then the rest in a stable order.
  const rest: CloudSpace[] = [];
  for (const space of spaces) {
    const had = known.get(space.id);
    if (had !== undefined && had === clean(space.name) && !taken.has(key(had))) claim(space, had);
    else rest.push(space);
  }
  for (const space of rest.sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const name = clean(space.name);
    let candidate = name;
    for (let n = 2; taken.has(key(candidate)); n++) candidate = `${name} (${n})`;
    claim(space, candidate);
  }
  return out;
}

/**
 * The virtual drive: one sync root, a folder per space, and the ordinary sync engine with a pass
 * that places files instead of downloading them. The tree comes from the change feed.
 */
export class CloudDrive {
  private readonly mirror: RemoteMirror;
  private readonly engine: SyncEngine;
  private readonly server: FetchServer;
  private readonly keeper: PinKeeper;
  private readonly itemStates: ItemStates;
  private itemStatesRun: Promise<void> = Promise.resolve();
  private readonly rootOptions: CloudRootOptions;
  private key = '';
  private spaces: CloudSpace[] = [];
  private folders = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  /** Polls and space changes run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  private pollQueued = false;

  constructor(private readonly deps: CloudDriveDeps) {
    this.rootOptions = {
      root: deps.root,
      provider: deps.provider,
      account: deps.account,
      shell: deps.shell,
    };
    this.mirror = new RemoteMirror({ list: (s, p) => deps.createDrive().list(s, p) }, deps.feed);
    this.server = new FetchServer({
      native: deps.native,
      connection: () => this.key,
      source: deps.source,
      onProgress: deps.onFetch,
    });
    const materializer = createMaterializer(deps.native, (abs) => this.keeper.look(abs));
    this.engine = new SyncEngine({
      createDrive: () => this.mirror.tracking(deps.createDrive()),
      platform: deps.platform,
      device: deps.device,
      conflictLabel: deps.conflictLabel,
      // The server keeps its own trash, and the shell's would download each file first.
      trash: (abs) => rm(abs, { recursive: true, force: true }),
      stateDir: join(deps.stateDir, 'base'),
      onStatus: deps.onStatus,
      watchFolder: deps.watchFolder,
      debounceMs: deps.debounceMs,
      intervalMs: deps.intervalMs,
      passOptions: () => ({ materializer, listing: this.mirror }),
      onPassDone: () => {
        this.keeper.afterPass();
        this.refreshItemStates();
      },
    });
    this.itemStates = new ItemStates({
      native: deps.native,
      file: join(deps.stateDir, 'item-states.json'),
    });
    this.keeper = new PinKeeper({
      native: deps.native,
      root: deps.root,
      canFree: (abs) => this.isOnServer(abs),
    });
  }

  async start(spaces: CloudSpace[]): Promise<void> {
    const { native, root, version, displayName, icon, stateName } = this.deps;
    await mkdir(root, { recursive: true });
    await native.registerRoot({ ...this.rootOptions, version, displayName, icon, stateName });
    this.key = await native.connect(root, (event) => this.server.handle(event));
    this.stopped = false;
    this.folders = await this.loadFolders();
    await this.mirror.start(spaces.map((s) => s.id));
    await this.applySpaces(spaces);
    this.keeper.start();
    this.timer = setInterval(() => {
      this.notifyChange();
      this.keeper.tick();
      this.refreshItemStates();
    }, this.deps.pollMs ?? POLL_MS);
  }

  /** The server says something changed (WebSocket `node.updated`), or it is simply time to look. */
  notifyChange(): void {
    // One waiting is enough: it reads everything up to when it runs.
    if (this.pollQueued || this.stopped) return;
    this.pollQueued = true;
    void this.enqueue(async () => {
      this.pollQueued = false;
      if (!this.stopped) await this.poll();
    });
  }

  setSpaces(spaces: CloudSpace[]): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return;
      await this.mirror.setSpaces(spaces.map((s) => s.id));
      await this.applySpaces(spaces);
    });
  }

  statuses(): PairStatus[] {
    return this.engine.statuses();
  }

  syncNow(): void {
    this.engine.syncNow();
  }

  confirmDeletes(pairId: string): void {
    this.engine.confirmDeletes(pairId);
  }

  /** Runs passes and polls already asked for to their end. For quitting and tests. */
  async idle(): Promise<void> {
    await this.queue;
    await this.engine.idle();
    await this.queue;
    await this.keeper.idle();
    await this.itemStatesRun;
  }

  /** Disconnects; the files stay and show as unavailable until the next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.engine.stop();
    this.keeper.stop();
    this.server.stop();
    await this.queue.catch(() => undefined);
    await this.engine.idle();
    await this.keeper.idle();
    await this.itemStatesRun;
    if (this.key) await this.deps.native.disconnect(this.key).catch(() => undefined);
    this.key = '';
  }

  /** Takes the drive off this computer, see `takeOffComputer`. */
  async remove(): Promise<void> {
    await this.stop();
    await takeOffComputer(this.deps.native, this.rootOptions, this.deps.stateDir);
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async poll(): Promise<void> {
    try {
      const { changed, spacesChanged } = await this.mirror.poll();
      for (const id of changed) this.engine.notifyRemoteChange(id);
      if (spacesChanged) this.deps.onSpacesChanged?.();
      await this.applySpaces(this.spaces);
    } catch (err) {
      this.deps.onPollError?.(err);
    }
  }

  /**
   * Is this what the last pass saw? Windows' in-sync mark alone would not do: writing at the end of a
   * file leaves it set, and freeing that file would lose what was written.
   */
  private async isOnServer(abs: string): Promise<boolean> {
    const [folder, ...rest] = relative(this.deps.root, abs).split(sep);
    if (rest.length === 0) return false;
    const spaceId = [...this.folders].find(([, name]) => name === folder)?.[0];
    if (!spaceId) return false;
    const synced = this.engine.synced(this.pairId(spaceId), rest.join('/'));
    const now = await statLocal(abs);
    return !!synced && !!now && synced.local === localFingerprint(now);
  }

  /** One at a time: each works out the whole list, so the last one is right. */
  private refreshItemStates(): void {
    this.itemStatesRun = this.itemStatesRun
      .then(() => this.applyItemStates())
      .catch(() => undefined);
  }

  private async applyItemStates(): Promise<void> {
    const { describeProblem, root } = this.deps;
    if (!describeProblem || this.stopped) return;
    const problems = new Map<string, string>();
    const statuses = new Map(this.engine.statuses().map((s) => [s.id, s]));
    for (const [spaceId, folder] of this.folders) {
      const status = statuses.get(this.pairId(spaceId));
      if (!status) continue;
      const abs = (path: string) => join(root, folder, ...path.split('/'));
      for (const item of status.skipped) {
        if (item.side === 'local') problems.set(abs(item.path), describeProblem(item.reason));
      }
      for (const item of status.failed) problems.set(abs(item.path), describeProblem(null));
    }
    // Nothing syncs what lies beside the space folders, and no pass would ever say so.
    const folders = new Set(this.folders.values());
    for (const name of await readdir(root).catch(() => [] as string[])) {
      if (!folders.has(name) && !isIgnored(name)) {
        problems.set(join(root, name), describeProblem('outside_space'));
      }
    }
    await this.itemStates.update(problems);
  }

  private pairId(spaceId: string): string {
    return `space-${spaceId}`;
  }

  private pairs(): SyncPair[] {
    return this.spaces.map((s) => ({
      id: this.pairId(s.id),
      spaceId: s.id,
      spaceName: s.name,
      folderId: null,
      folderPath: '',
      localPath: join(this.deps.root, this.folders.get(s.id)!),
      paused: false,
    }));
  }

  /** Brings the folders of the spaces in line, then tells the engine. */
  private async applySpaces(spaces: CloudSpace[]): Promise<void> {
    const { root, platform, native } = this.deps;
    const previous = this.folders;
    const next = spaceFolders(spaces, platform, previous);
    const nextIds = new Set(spaces.map((s) => s.id));

    for (const [id, name] of previous) {
      if (nextIds.has(id)) continue;
      await this.engine.forget(this.pairId(id));
      await clearFolder(native, join(root, name));
    }
    this.spaces = spaces;

    for (const space of spaces) {
      const name = next.get(space.id)!;
      const had = previous.get(space.id);
      const path = join(root, name);
      if (had && had !== name && (await exists(join(root, had))) && !(await exists(path))) {
        // The space was renamed: the same folder, under its new name.
        await this.engine.hold(this.pairId(space.id));
        await rename(join(root, had), path);
      }
      if (await exists(path)) continue;
      // Gone without anyone asking the server: all of it would read as deleted here. Bring it back.
      await this.engine.forget(this.pairId(space.id));
      const [result] = await native.createPlaceholders(root, [
        { name, identity: `space:${space.id}`, folder: true, mtimeMs: Date.now() },
      ]);
      if (result !== '0x00000000') throw new Error(`could not create ${name}: ${result}`);
    }
    this.folders = next;
    await this.saveFolders();
    this.engine.setPairs(this.pairs());
  }

  private get foldersFile(): string {
    return join(this.deps.stateDir, 'spaces.json');
  }

  private async loadFolders(): Promise<Map<string, string>> {
    try {
      const entries = JSON.parse(await readFile(this.foldersFile, 'utf8')) as Array<
        [string, string]
      >;
      return new Map(entries);
    } catch {
      return new Map();
    }
  }

  private async saveFolders(): Promise<void> {
    await mkdir(this.deps.stateDir, { recursive: true });
    await writeFile(this.foldersFile, JSON.stringify([...this.folders]));
  }
}

/** Leaves only what would be lost: files the server does not have in this state. */
async function clearFolder(native: CloudFilesNative, dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if ((await stat(path).catch(() => null))?.isDirectory()) {
      await clearFolder(native, path);
      continue;
    }
    const info = await native.info(path).catch(() => null);
    if (info?.placeholder && info.inSync) await rm(path, { force: true }).catch(() => undefined);
  }
  await rmdir(dir).catch(() => undefined);
}

/**
 * Takes the drive off this computer. What exists only here stays as an ordinary file: changes not
 * uploaded yet must not be lost to signing out or uninstalling.
 */
export async function takeOffComputer(
  native: CloudFilesNative,
  options: CloudRootOptions,
  stateDir: string,
): Promise<void> {
  await clearFolder(native, options.root);
  await native.unregisterRoot(options).catch(() => undefined);
  await rm(stateDir, { recursive: true, force: true });
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}
