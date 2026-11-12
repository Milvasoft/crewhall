import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CloudFilesNative } from './native';

/** Windows' own warning icon, the one its stock icon list names for this. */
export const WARNING_ICON = 'imageres.dll,-84';

/** Telling Explorer is one call per file: a folder full of bad names must not become a storm. */
const MAX_SHOWN = 500;

export interface ItemStatesOptions {
  native: Pick<CloudFilesNative, 'setItemState'>;
  /** They stay on the files after a restart, so what was shown has to be known then too. */
  file: string;
  icon?: string;
  maxShown?: number;
}

/**
 * Explorer's own icons say "not synced yet" and keep saying it for a file that never will be: this
 * adds a warning next to those. What is remembered is the path, so a file moved while it has a
 * warning keeps it.
 */
export class ItemStates {
  private shown = new Map<string, string>();
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ItemStatesOptions) {}

  /** Path and text of every file with something to say; everything else loses its warning. */
  update(problems: ReadonlyMap<string, string>): Promise<void> {
    this.queue = this.queue.then(() => this.apply(problems)).catch(() => undefined);
    return this.queue;
  }

  private async apply(problems: ReadonlyMap<string, string>): Promise<void> {
    if (!this.loaded) await this.load();
    const { native, icon = WARNING_ICON, maxShown = MAX_SHOWN } = this.options;
    const wanted = new Map([...problems].sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, maxShown));
    let changed = false;
    for (const path of [...this.shown.keys()]) {
      if (wanted.has(path)) continue;
      this.shown.delete(path);
      changed = true;
      // Fails when the file went away, and with it what was shown.
      await native.setItemState(path, '', '').catch(() => undefined);
    }
    for (const [path, text] of wanted) {
      if (this.shown.get(path) === text) continue;
      const shown = await native.setItemState(path, text, icon).then(
        () => true,
        () => false,
      );
      if (!shown) continue;
      this.shown.set(path, text);
      changed = true;
    }
    if (changed) await this.save();
  }

  private async load(): Promise<void> {
    this.loaded = true;
    try {
      const entries = JSON.parse(await readFile(this.options.file, 'utf8')) as Array<
        [string, string]
      >;
      this.shown = new Map(entries);
    } catch {
      this.shown = new Map();
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.options.file), { recursive: true });
    await writeFile(this.options.file, JSON.stringify([...this.shown]));
  }
}
