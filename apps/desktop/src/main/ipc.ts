import { paths } from '@crewhall/shared';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { app, dialog, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { API_METHODS, type DesktopApi, type FolderView, type ServerCheckView } from '../common/ipc';
import { checkServer } from '../common/server';
import { foldersOverlap } from '../common/virtual-drive';
import type { SyncPair } from '../sync/engine';
import type { DesktopApp } from './app';
import { RENDERER_URL_PREFIX } from './paths';
import { chooseScreen, openScreenSettings, screenAccess, screenSources } from './windows';

type Handlers = {
  [K in (typeof API_METHODS)[number]]: (...args: never[]) => ReturnType<DesktopApi[K]>;
};

const Str = z.string().min(1).max(2048);
const NewPair = z.object({
  spaceId: Str,
  spaceName: z.string().max(200),
  folderId: Str.nullable(),
  folderPath: z.string().max(2048),
  localPath: Str,
});

/** Handlers of the `desktop` API; only the app's own file:// pages may call them. */
export function registerIpc(d: DesktopApp): void {
  const handlers: Handlers = {
    i18n: async () => ({ locale: d.locale, messages: d.messages }),

    checkServer: async (input: string): Promise<ServerCheckView> => {
      const check = await checkServer(Str.parse(input), (u, i) =>
        session.defaultSession.fetch(u, i),
      );
      if (!check.ok) return check;
      const b = check.bootstrap.branding;
      return {
        ok: true,
        origin: check.origin,
        brand: {
          orgName: b.orgName,
          appName: b.appName,
          logoUrl: b.logoLightUrl ?? b.markUrl,
          showPoweredBy: b.showPoweredBy,
        },
      };
    },

    connect: async (origin: string) => d.connect(Str.parse(origin)),

    getSettings: async () => d.settingsView(),

    setSettings: async (patch: {
      notifications?: boolean;
      autostart?: boolean;
      explorerMenu?: boolean;
    }) => {
      const p = z
        .object({ notifications: z.boolean(), autostart: z.boolean(), explorerMenu: z.boolean() })
        .partial()
        .parse(patch);
      if (p.notifications !== undefined) d.settings.update({ notifications: p.notifications });
      if (p.autostart !== undefined) d.setAutostart(p.autostart);
      if (p.explorerMenu !== undefined) {
        d.settings.update({ explorerMenu: p.explorerMenu });
        await d.sendTo.syncExplorer();
      }
      return d.settingsView();
    },

    setGlobalShortcut: async (accelerator: unknown) =>
      d.setGlobalShortcut(z.string().max(64).nullable().parse(accelerator)),

    sendInfo: async () => d.sendTo.info(),
    sendStart: async (target: unknown) =>
      d.sendTo.start(z.object({ spaceId: Str, folderId: Str.nullable() }).parse(target)),
    sendCancel: async () => d.sendTo.cancel(),
    sendOpenApp: async (input: unknown) => {
      const drive = z.object({ slug: Str, folderId: Str.nullable() }).nullable().parse(input);
      if (!drive) return d.showMain();
      d.openPath(
        drive.folderId
          ? paths.driveFolder(drive.slug, drive.folderId)
          : paths.driveSpace(drive.slug),
      );
    },

    changeServer: async () => d.changeServer(),

    listSpaces: async () => {
      const { items } = await d.api().call('listSpaces', { query: {} });
      return items.map((s) => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        canEdit: s.myRole !== 'viewer',
      }));
    },

    listFolders: async (spaceId: string, parentId: string | null): Promise<FolderView[]> => {
      const out: FolderView[] = [];
      let cursor: string | undefined;
      do {
        const page = await d.api().call('listNodes', {
          params: { spaceId: Str.parse(spaceId) },
          query: {
            parentId: parentId ? Str.parse(parentId) : undefined,
            type: 'folder',
            limit: 100,
            cursor,
          },
        });
        out.push(...page.items.map((n) => ({ id: n.id, name: n.name })));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return out;
    },

    pickLocalFolder: async () => {
      const win = d.settingsWindow ?? undefined;
      const options = {
        properties: ['openDirectory', 'createDirectory'] as Array<
          'openDirectory' | 'createDirectory'
        >,
      };
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },

    addPair: async (input) => {
      const p = NewPair.parse(input);
      const localPath = resolve(p.localPath);
      const s = await stat(localPath).catch(() => null);
      if (!s?.isDirectory()) return { ok: false, error: 'notDirectory' };
      const pairs = d.settings.get().syncPairs;
      const taken = pairs.map((x) => x.localPath);
      // The virtual drive's folder is off limits too: two syncs would fight over its files.
      if (d.settings.get().virtualDrive.enabled) taken.push(d.virtualDrive.root);
      if (taken.some((folder) => foldersOverlap(localPath, folder, process.platform))) {
        return { ok: false, error: 'overlap' };
      }
      const pair: SyncPair = { id: randomUUID(), ...p, localPath, paused: false };
      const next = [...pairs, pair];
      d.settings.update({ syncPairs: next });
      d.sync.setPairs(next);
      d.pushSettings();
      return { ok: true };
    },

    removePair: async (id: string) => {
      const next = d.settings.get().syncPairs.filter((p) => p.id !== id);
      d.settings.update({ syncPairs: next });
      d.sync.setPairs(next);
      d.pushSettings();
    },

    setPaused: async (id: string, paused: boolean) => {
      const next = d.settings
        .get()
        .syncPairs.map((p) => (p.id === id ? { ...p, paused: z.boolean().parse(paused) } : p));
      d.settings.update({ syncPairs: next });
      d.sync.setPairs(next);
      d.pushSettings();
    },

    syncNow: async (id?: string) => d.sync.syncNow(id),
    confirmDeletes: async (id: string) => d.sync.confirmDeletes(Str.parse(id)),

    openPairFolder: async (id: string) => {
      const pair = d.settings.get().syncPairs.find((p) => p.id === id);
      if (pair) await shell.openPath(pair.localPath);
    },

    setVirtualDrive: async (enabled: boolean) =>
      d.virtualDrive.setEnabled(z.boolean().parse(enabled)),

    pickVirtualDriveFolder: async () => {
      const win = d.settingsWindow ?? undefined;
      const options = {
        properties: ['openDirectory', 'createDirectory'] as Array<
          'openDirectory' | 'createDirectory'
        >,
      };
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      const folder = result.canceled ? null : result.filePaths[0];
      if (folder) d.virtualDrive.setRoot(resolve(folder));
    },

    openVirtualDrive: async () => {
      await shell.openPath(d.virtualDrive.root);
    },

    syncVirtualDrive: async () => d.virtualDrive.syncNow(),
    confirmVirtualDriveDeletes: async (id: string) => d.virtualDrive.confirmDeletes(Str.parse(id)),

    checkUpdates: async () => d.updater.check(),
    installUpdate: async () => d.updater.install(),
    screenSources: async () => screenSources(),
    chooseSource: async (id: string | null) => chooseScreen(id === null ? null : Str.parse(id)),
    screenAccess: async () => screenAccess(),
    openScreenSettings: async () => openScreenSettings(),
    relaunch: async () => {
      app.relaunch();
      app.exit(0);
    },

    answerControl: async (yes: boolean) => d.remote.answer(yes === true),
    stopControl: async () => d.remote.stop(),
    openAccessibilitySettings: async () => d.remote.openAccessibilitySettings(),

    retry: async () => d.retry(),
  };

  for (const method of API_METHODS) {
    ipcMain.handle(`desktop:${method}`, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const url = event.senderFrame?.url ?? '';
      if (!url.startsWith(RENDERER_URL_PREFIX)) throw new Error('forbidden');
      return (handlers[method] as (...a: unknown[]) => unknown)(...args);
    });
  }
}
