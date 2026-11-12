import { execFile } from 'node:child_process';
import { lstat, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { ApiError } from '@crewhall/api-client';
import { BrowserWindow, app, session, shell } from 'electron';
import { SEND_EVENT, type SendInfo, type SendState } from '../common/ipc';
import {
  SendBatch,
  countFiles,
  readEntry,
  registerExplorer,
  sendEntries,
  sendToPaths,
  unregisterExplorer,
  type ExplorerPlace,
  type LocalEntry,
  type LocalFiles,
  type RegistryLayer,
  type SendDrive,
  type SendResult,
  type SendTarget,
  type ShortcutLayer,
} from '../common/send-to';
import { createApiDrive } from '../sync/remote';
import type { DesktopApp } from './app';
import { openLocalWindow } from './windows';

const run = promisify(execFile);

/** The per-user registry, through reg.exe: no native module and no administrator rights. */
const realRegistry: RegistryLayer = {
  async set(key, name, value) {
    const which = name === null ? ['/ve'] : ['/v', name];
    await run('reg.exe', ['add', key, ...which, '/t', 'REG_SZ', '/d', value, '/f']);
  },
  async remove(key) {
    await run('reg.exe', ['delete', key, '/f']).catch(() => undefined);
  },
};

const realShortcuts: ShortcutLayer = {
  write: (path, target, args, description) =>
    shell.writeShortcutLink(path, 'create', {
      target,
      args,
      description,
      icon: target,
      iconIndex: 0,
    }),
  remove: (path) => rm(path, { force: true }),
};

const localFiles: LocalFiles = {
  async stat(path) {
    const s = await lstat(path);
    if (s.isSymbolicLink()) return { kind: 'other', size: 0 };
    if (s.isDirectory()) return { kind: 'folder', size: 0 };
    return s.isFile() ? { kind: 'file', size: s.size } : { kind: 'other', size: 0 };
  },
  list: (path) => readdir(path),
  join,
  baseName: (path) => basename(path),
};

/** Files sent from Windows Explorer: their window, and the entries in Explorer's menus. */
export class SendTo {
  private win: BrowserWindow | null = null;
  private entries: LocalEntry[] = [];
  /** Chosen while an upload runs: shown when it is done. */
  private waiting: string[] = [];
  private uploading = false;
  private cancelled = false;
  private readonly batch = new SendBatch((paths) => void this.show(paths));

  constructor(private readonly d: DesktopApp) {}

  /** A command line (this start or a second launch); true when it was about sending files. */
  receive(argv: readonly string[]): boolean {
    const paths = sendToPaths(argv);
    this.batch.add(paths);
    return paths.length > 0;
  }

  private get place(): ExplorerPlace {
    return {
      classesRoot: 'HKCU\\Software\\Classes',
      sendToDir: join(app.getPath('appData'), 'Microsoft', 'Windows', 'SendTo'),
      // A development run only registers under a name of its own, and only when asked to.
      name: process.env.CREWHALL_EXPLORER_NAME ?? 'Crewhall',
      exePath: process.execPath,
      label: this.d.t('desktop.sendTo.menuLabel'),
    };
  }

  private get canRegister(): boolean {
    // A Store package writes the registry and SendTo only for itself: Explorer would see nothing.
    if (!this.d.dist.explorerMenu) return false;
    return process.platform === 'win32' && (app.isPackaged || !!process.env.CREWHALL_EXPLORER_NAME);
  }

  /** Every start: an update may have moved the program, or the language changed. */
  async syncExplorer(): Promise<void> {
    if (!this.canRegister) return;
    const place = this.place;
    try {
      if (this.d.settings.get().explorerMenu) {
        await registerExplorer(place, realRegistry, realShortcuts);
      } else {
        await unregisterExplorer(place, realRegistry, realShortcuts);
      }
    } catch (e) {
      console.warn('[send-to] could not update the Explorer menu', e);
    }
  }

  private async show(paths: string[]): Promise<void> {
    if (this.uploading) {
      this.waiting.push(...paths);
      return;
    }
    if (!this.d.origin) return this.d.showMain();
    const entries: LocalEntry[] = [];
    for (const p of paths) entries.push(await readEntry(p, localFiles));
    this.entries = entries;
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.reload();
      this.win.show();
      this.win.focus();
      return;
    }
    this.win = openLocalWindow(
      this.d,
      'send',
      {},
      { width: 520, height: 560, minWidth: 420, minHeight: 420 },
    );
    this.win.on('closed', () => {
      this.win = null;
      // The upload goes no further than the file it is on.
      this.cancelled = true;
    });
  }

  info(): SendInfo {
    const { files, bytes } = countFiles(this.entries);
    return { names: this.entries.map((e) => e.name), files, bytes };
  }

  cancel(): void {
    this.cancelled = true;
  }

  private drive(): SendDrive {
    const remote = createApiDrive(this.d.api(), (url, init) =>
      session.defaultSession.fetch(url, { ...init, credentials: 'omit' }),
    );
    return {
      async createFolder(spaceId, parentId, name) {
        try {
          return await remote.createFolder(spaceId, parentId, name);
        } catch (e) {
          if (!(e instanceof ApiError) || e.code !== 'node_name_taken') throw e;
          // A folder of that name is already there: its contents join it.
          const same = (await remote.list(spaceId, parentId)).find(
            (n) => n.name === name && n.kind === 'folder',
          );
          if (!same) throw e;
          return same;
        }
      },
      async uploadNew(spaceId, parentId, name, file) {
        await remote.upload(spaceId, parentId, name, file, undefined, 'rename');
      },
    };
  }

  async start(target: SendTarget): Promise<SendResult> {
    this.uploading = true;
    this.cancelled = false;
    const send = (state: SendState) => {
      if (this.win && !this.win.isDestroyed()) this.win.webContents.send(SEND_EVENT, state);
    };
    try {
      return await sendEntries(this.entries, target, this.drive(), send, () => this.cancelled);
    } finally {
      this.uploading = false;
      this.d.refreshBadgeSoon();
      const next = this.waiting;
      this.waiting = [];
      if (next.length > 0) this.batch.add(next);
    }
  }
}
