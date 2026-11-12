import { describe, expect, it, vi } from 'vitest';
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
} from '../src/common/send-to';

describe('paths on the command line', () => {
  it('takes what follows the flag', () => {
    expect(sendToPaths(['app.exe', '--send-to', 'C:\\a.txt', 'D:\\b c\\d.pdf'])).toEqual([
      'C:\\a.txt',
      'D:\\b c\\d.pdf',
    ]);
  });

  it('accepts network paths and drops switches Chromium mixes in', () => {
    expect(
      sendToPaths(['app.exe', '--send-to', '--allow-file-access-from-files', '\\\\nas\\x.txt']),
    ).toEqual(['\\\\nas\\x.txt']);
  });

  it('is empty without the flag and refuses relative paths', () => {
    expect(sendToPaths(['app.exe', 'C:\\a.txt'])).toEqual([]);
    expect(sendToPaths(['app.exe', '--send-to', 'a.txt', '..\\b'])).toEqual([]);
  });
});

describe('Explorer entries', () => {
  const place: ExplorerPlace = {
    classesRoot: 'FAKE\\Classes',
    sendToDir: 'C:\\fake\\SendTo',
    name: 'Crewhall',
    exePath: 'C:\\Apps\\Crewhall.exe',
    label: "Crewhall'a yükle",
  };
  const layers = () => {
    const values = new Map<string, string>();
    const registry = {
      set: vi.fn(async (key: string, name: string | null, value: string) => {
        values.set(`${key}|${name ?? ''}`, value);
      }),
      remove: vi.fn(async (_key: string) => undefined),
    };
    const shortcuts = {
      write: vi.fn((_p: string, _t: string, _a: string, _d: string) => true),
      remove: vi.fn(async (_p: string) => undefined),
    };
    return { values, registry, shortcuts };
  };

  it('adds the menu item for files and folders, quoting the paths', async () => {
    const { values, registry, shortcuts } = layers();
    await registerExplorer(place, registry, shortcuts);
    for (const kind of ['*', 'Directory']) {
      const key = `FAKE\\Classes\\${kind}\\shell\\CrewhallUpload`;
      expect(values.get(`${key}|`)).toBe("Crewhall'a yükle");
      expect(values.get(`${key}\\command|`)).toBe('"C:\\Apps\\Crewhall.exe" --send-to "%1"');
    }
    expect(shortcuts.write).toHaveBeenCalledWith(
      'C:\\fake\\SendTo\\Crewhall.lnk',
      'C:\\Apps\\Crewhall.exe',
      '--send-to',
      "Crewhall'a yükle",
    );
  });

  it('removes everything it added', async () => {
    const { registry, shortcuts } = layers();
    await unregisterExplorer(place, registry, shortcuts);
    expect(registry.remove).toHaveBeenCalledWith('FAKE\\Classes\\*\\shell\\CrewhallUpload');
    expect(registry.remove).toHaveBeenCalledWith('FAKE\\Classes\\Directory\\shell\\CrewhallUpload');
    expect(shortcuts.remove).toHaveBeenCalledWith('C:\\fake\\SendTo\\Crewhall.lnk');
  });

  it('uses another name for a test build, so the real entries stay', async () => {
    const { values, registry, shortcuts } = layers();
    await registerExplorer({ ...place, name: 'CrewhallDevCheck' }, registry, shortcuts);
    expect([...values.keys()].every((k) => k.includes('CrewhallDevCheckUpload'))).toBe(true);
    expect(shortcuts.write.mock.calls[0]?.[0]).toBe('C:\\fake\\SendTo\\CrewhallDevCheck.lnk');
  });
});

describe('gathering launches', () => {
  it('makes one batch of separate launches, without repeats', () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const batch = new SendBatch((p) => batches.push(p), 400);
    batch.add(['C:\\a']);
    vi.advanceTimersByTime(300);
    batch.add(['C:\\b', 'C:\\a']);
    vi.advanceTimersByTime(399);
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual([['C:\\a', 'C:\\b']]);
    batch.add([]);
    vi.advanceTimersByTime(1000);
    expect(batches).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe('reading what was chosen', () => {
  const tree: Record<string, { kind: 'file' | 'folder' | 'other'; size: number; list?: string[] }> =
    {
      'C:/top': { kind: 'folder', size: 0, list: ['a.txt', 'sub', 'link', 'gone'] },
      'C:/top/a.txt': { kind: 'file', size: 5 },
      'C:/top/sub': { kind: 'folder', size: 0, list: ['b.txt'] },
      'C:/top/sub/b.txt': { kind: 'file', size: 7 },
      'C:/top/link': { kind: 'other', size: 0 },
    };
  const fs: LocalFiles = {
    stat: async (p) => tree[p] ?? null,
    list: async (p) => tree[p]?.list ?? [],
    join: (a, b) => `${a}/${b}`,
    baseName: (p) => p.split('/').at(-1) ?? p,
  };

  it('walks folders, and marks links and missing files to skip', async () => {
    const entry = await readEntry('C:/top', fs);
    expect(entry.kind).toBe('folder');
    const kinds = entry.kind === 'folder' ? entry.children.map((c) => [c.name, c.kind]) : [];
    expect(kinds).toEqual([
      ['a.txt', 'file'],
      ['sub', 'folder'],
      ['link', 'skip'],
      ['gone', 'skip'],
    ]);
    expect(countFiles([entry])).toEqual({ files: 2, bytes: 12 });
  });
});

describe('uploading', () => {
  const file = (name: string): LocalEntry => ({ kind: 'file', path: `C:/${name}`, name, size: 1 });
  const fakeDrive = (failing: string[] = []) => ({
    createFolder: vi.fn(async (_s: string, _p: string | null, name: string) => {
      if (failing.includes(name)) throw new Error(name);
      return { id: `id-${name}` };
    }),
    uploadNew: vi.fn(
      async (_s: string, _p: string | null, name: string, _f: { path: string; size: number }) => {
        if (failing.includes(name)) throw new Error(name);
      },
    ),
  });
  const target = { spaceId: 's', folderId: 'f' };

  it('keeps the folder structure under the chosen folder', async () => {
    const drive = fakeDrive();
    const entries: LocalEntry[] = [
      file('a.txt'),
      { kind: 'folder', path: 'C:/sub', name: 'sub', children: [file('b.txt')] },
    ];
    const seen: number[] = [];
    const result = await sendEntries(entries, target, drive, (p) => seen.push(p.done));
    expect(result).toEqual({ uploaded: 2, failed: [], skipped: [] });
    expect(drive.uploadNew.mock.calls[0]?.slice(0, 3)).toEqual(['s', 'f', 'a.txt']);
    expect(drive.createFolder).toHaveBeenCalledWith('s', 'f', 'sub');
    expect(drive.uploadNew.mock.calls[1]?.slice(0, 3)).toEqual(['s', 'id-sub', 'b.txt']);
    expect(seen.at(-1)).toBe(2);
  });

  it('goes on after a failure and names what did not make it', async () => {
    const drive = fakeDrive(['bad.txt', 'badfolder']);
    const entries: LocalEntry[] = [
      file('bad.txt'),
      file('ok.txt'),
      { kind: 'folder', path: 'C:/badfolder', name: 'badfolder', children: [file('in.txt')] },
      { kind: 'skip', path: 'C:/link', name: 'link' },
    ];
    const result = await sendEntries(entries, target, drive, () => undefined);
    expect(result).toEqual({
      uploaded: 1,
      failed: ['C:/bad.txt', 'C:/badfolder'],
      skipped: ['C:/link'],
    });
    expect(drive.uploadNew).not.toHaveBeenCalledWith('s', expect.anything(), 'in.txt', {
      path: 'C:/in.txt',
      size: 1,
    });
  });

  it('stops starting new files once cancelled', async () => {
    const drive = fakeDrive();
    let cancelled = false;
    const result = await sendEntries(
      [file('a'), file('b')],
      target,
      {
        ...drive,
        uploadNew: async (...args) => {
          await drive.uploadNew(...args);
          cancelled = true;
        },
      },
      () => undefined,
      () => cancelled,
    );
    expect(result.uploaded).toBe(1);
    expect(drive.uploadNew).toHaveBeenCalledTimes(1);
  });
});
