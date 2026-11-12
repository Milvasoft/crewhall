/**
 * "Gönder → Crewhall" and "Crewhall'a yükle" in Windows Explorer. Everything that touches the
 * computer or the server comes in as a parameter: the tests never write to the real registry,
 * SendTo folder or Drive.
 */

/** What Explorer adds to the app's command line, followed by the chosen paths. */
export const SEND_TO_FLAG = '--send-to';

/** The chosen paths on a command line. Chromium's own switches may be mixed in; those go. */
export function sendToPaths(argv: readonly string[]): string[] {
  const at = argv.indexOf(SEND_TO_FLAG);
  if (at < 0) return [];
  return argv.slice(at + 1).filter((a) => /^([a-zA-Z]:[\\/]|\\\\)/.test(a));
}

export interface RegistryLayer {
  /** `name` null: the key's default value. */
  set(key: string, name: string | null, value: string): Promise<void>;
  /** The key and everything under it; a missing key is fine. */
  remove(key: string): Promise<void>;
}

export interface ShortcutLayer {
  write(path: string, target: string, args: string, description: string): boolean;
  remove(path: string): Promise<void>;
}

export interface ExplorerPlace {
  /** The registry's per-user classes, `HKCU\Software\Classes`. */
  classesRoot: string;
  /** `%APPDATA%\Microsoft\Windows\SendTo`. */
  sendToDir: string;
  /** Names the shortcut and the registry keys; a test build uses its own. */
  name: string;
  exePath: string;
  label: string;
}

const verbKeys = (p: ExplorerPlace) =>
  ['*', 'Directory'].map((kind) => `${p.classesRoot}\\${kind}\\shell\\${p.name}Upload`);
const shortcutPath = (p: ExplorerPlace) => `${p.sendToDir}\\${p.name}.lnk`;

/** Writes the menu entries; safe to repeat (an update may move the program). */
export async function registerExplorer(
  place: ExplorerPlace,
  registry: RegistryLayer,
  shortcuts: ShortcutLayer,
): Promise<void> {
  for (const key of verbKeys(place)) {
    await registry.set(key, null, place.label);
    await registry.set(key, 'Icon', `"${place.exePath}",0`);
    // Several files chosen: Explorer starts us once per file (the app gathers them), up to 100.
    await registry.set(key, 'MultiSelectModel', 'Player');
    await registry.set(`${key}\\command`, null, `"${place.exePath}" ${SEND_TO_FLAG} "%1"`);
  }
  shortcuts.write(shortcutPath(place), place.exePath, SEND_TO_FLAG, place.label);
}

export async function unregisterExplorer(
  place: ExplorerPlace,
  registry: RegistryLayer,
  shortcuts: ShortcutLayer,
): Promise<void> {
  for (const key of verbKeys(place)) await registry.remove(key);
  await shortcuts.remove(shortcutPath(place));
}

/** Gathers paths from Explorer's separate launches into one batch. */
export class SendBatch {
  private paths: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onBatch: (paths: string[]) => void,
    private readonly waitMs = 400,
  ) {}

  add(paths: readonly string[]): void {
    if (paths.length === 0) return;
    for (const p of paths) if (!this.paths.includes(p)) this.paths.push(p);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const batch = this.paths;
      this.paths = [];
      this.onBatch(batch);
    }, this.waitMs);
  }
}

export type LocalEntry =
  | { kind: 'file'; path: string; name: string; size: number }
  | { kind: 'folder'; path: string; name: string; children: LocalEntry[] }
  /** Gone, unreadable or a link: named in the result, not uploaded. */
  | { kind: 'skip'; path: string; name: string };

export interface LocalFiles {
  /** Null when it cannot be read. Links count as `other`: they may point anywhere. */
  stat(path: string): Promise<{ kind: 'file' | 'folder' | 'other'; size: number } | null>;
  list(path: string): Promise<string[]>;
  join(parent: string, name: string): string;
  baseName(path: string): string;
}

export async function readEntry(path: string, fs: LocalFiles): Promise<LocalEntry> {
  const name = fs.baseName(path);
  const s = await fs.stat(path).catch(() => null);
  if (!s || s.kind === 'other') return { kind: 'skip', path, name };
  if (s.kind === 'file') return { kind: 'file', path, name, size: s.size };
  const names = await fs.list(path).catch(() => null);
  if (!names) return { kind: 'skip', path, name };
  const children: LocalEntry[] = [];
  for (const child of names) children.push(await readEntry(fs.join(path, child), fs));
  return { kind: 'folder', path, name, children };
}

export function countFiles(entries: readonly LocalEntry[]): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const e of entries) {
    if (e.kind === 'file') {
      files += 1;
      bytes += e.size;
    } else if (e.kind === 'folder') {
      const inner = countFiles(e.children);
      files += inner.files;
      bytes += inner.bytes;
    }
  }
  return { files, bytes };
}

export interface SendTarget {
  spaceId: string;
  folderId: string | null;
}

export interface SendDrive {
  createFolder(spaceId: string, parentId: string | null, name: string): Promise<{ id: string }>;
  /** A name that is taken keeps both: the new file gets another name. */
  uploadNew(
    spaceId: string,
    parentId: string | null,
    name: string,
    file: { path: string; size: number },
  ): Promise<void>;
}

export interface SendProgress {
  done: number;
  total: number;
  current: string;
}

export interface SendResult {
  uploaded: number;
  /** Paths that did not make it; the rest of the batch still goes. */
  failed: string[];
  skipped: string[];
}

/** Uploads the entries; one failure does not stop the others. */
export async function sendEntries(
  entries: readonly LocalEntry[],
  target: SendTarget,
  drive: SendDrive,
  onProgress: (p: SendProgress) => void,
  isCancelled: () => boolean = () => false,
): Promise<SendResult> {
  const result: SendResult = { uploaded: 0, failed: [], skipped: [] };
  const { files: total } = countFiles(entries);
  let done = 0;

  const send = async (entry: LocalEntry, parentId: string | null): Promise<void> => {
    if (isCancelled()) return;
    if (entry.kind === 'skip') {
      result.skipped.push(entry.path);
      return;
    }
    if (entry.kind === 'file') {
      onProgress({ done, total, current: entry.name });
      try {
        await drive.uploadNew(target.spaceId, parentId, entry.name, {
          path: entry.path,
          size: entry.size,
        });
        result.uploaded += 1;
      } catch (e) {
        console.warn('[send-to] upload failed', entry.path, e);
        result.failed.push(entry.path);
      }
      done += 1;
      return;
    }
    let folder: { id: string };
    try {
      folder = await drive.createFolder(target.spaceId, parentId, entry.name);
    } catch (e) {
      console.warn('[send-to] folder failed', entry.path, e);
      result.failed.push(entry.path);
      done += countFiles(entry.children).files;
      return;
    }
    for (const child of entry.children) await send(child, folder.id);
  };

  for (const entry of entries) await send(entry, target.folderId);
  onProgress({ done, total, current: '' });
  return result;
}
