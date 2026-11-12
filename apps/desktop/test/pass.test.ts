import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPass, SyncError, type PassOptions, type PassResult } from '../src/sync/pass';
import type { BaseEntry } from '../src/sync/types';
import { FakeDrive } from './fake-drive';

let root: string;
let drive: FakeDrive;
let base: Map<string, BaseEntry>;
let mtime = Date.parse('2026-10-22T09:00:00.000Z');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'crewhall-sync-'));
  drive = new FakeDrive();
  base = new Map();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeLocal(path: string, content: string): Promise<void> {
  const abs = join(root, ...path.split('/'));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
  // Distinct mtimes, as real edits have; the sync compares size and mtime.
  mtime += 60_000;
  await utimes(abs, new Date(mtime), new Date(mtime));
}

async function localTree(dir = root, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const path = prefix + d.name;
    if (d.isDirectory()) {
      out.push(`${path}/`);
      out.push(...(await localTree(join(dir, d.name), `${path}/`)));
    } else out.push(`${path}=${await readFile(join(dir, d.name), 'utf8')}`);
  }
  return out.sort();
}

describe('files that are only in another cloud', () => {
  const RECALL_ON_DATA_ACCESS = 0x400000;
  const NORMAL = 0x20;
  /** How Electron sees a placeholder: a plain file in the listing, told only by its attributes. */
  const marks = (online: string[]) => ({
    attributes: (abs: string) =>
      Promise.resolve(online.some((name) => abs.endsWith(name)) ? RECALL_ON_DATA_ACCESS : NORMAL),
  });

  it('leaves out an entry the listing shows as a plain file', async () => {
    await writeLocal('bulutta.txt', 'okunmamalı');
    await writeLocal('burada.txt', 'burada');
    const result = await pass(marks(['bulutta.txt']));
    expect(result.skipped).toEqual([{ path: 'bulutta.txt', side: 'local', reason: 'online_only' }]);
    expect(drive.tree()).toEqual(['burada.txt=burada']);
  });

  it('does not go into a folder that is only in the cloud', async () => {
    await writeLocal('uzak/ic.txt', 'x');
    const result = await pass(marks(['uzak']));
    expect(result.skipped.map((s) => s.path)).toEqual(['uzak']);
    expect(drive.tree()).toEqual([]);
  });

  it('does not take a file that moved to the cloud for deleted', async () => {
    await writeLocal('a.txt', 'kalsın');
    await pass(marks([]));
    drive.calls.length = 0;
    const result = await pass(marks(['a.txt']));
    expect(result.stats).toMatchObject({ deletedRemote: 0, deletedLocal: 0, uploaded: 0 });
    expect(drive.tree()).toEqual(['a.txt=kalsın']);
  });

  it('keeps a plain file whose attributes could not be read', async () => {
    await writeLocal('a.txt', 'içerik');
    const result = await pass({ attributes: () => Promise.reject(new Error('denied')) });
    expect(result.skipped).toEqual([]);
    expect(drive.tree()).toEqual(['a.txt=içerik']);
  });

  it('asks nothing of a pass with placeholders of its own', async () => {
    await writeLocal('a.txt', 'içerik');
    const asked: string[] = [];
    const materializer = {
      placeFile: () => Promise.resolve(),
      placeFolder: () => Promise.resolve(),
      replaceFile: () => Promise.resolve(),
      settle: () => Promise.resolve(),
      isCurrent: () => Promise.resolve(false),
    };
    await pass({
      materializer,
      attributes: (abs) => {
        asked.push(abs);
        return Promise.resolve(RECALL_ON_DATA_ACCESS);
      },
    });
    expect(asked).toEqual([]);
    expect(drive.tree()).toEqual(['a.txt=içerik']);
  });
});

async function pass(extra: Partial<PassOptions> = {}): Promise<PassResult> {
  const result = await runPass({
    root,
    spaceId: drive.spaceId,
    folderId: null,
    drive,
    base,
    platform: 'win32',
    device: 'LAPTOP',
    conflictLabel: 'çakışan kopya',
    trash: (abs) => rm(abs, { recursive: true, force: true }),
    now: () => new Date(2026, 9, 22, 14, 5),
    ...extra,
  });
  base = result.base;
  return result;
}

/** Passes until settled; the last one must find nothing to do. */
async function sync(extra: Partial<PassOptions> = {}): Promise<PassResult> {
  let result = await pass(extra);
  for (let i = 0; i < 3 && result.again; i++) result = await pass(extra);
  expect(result.errors).toEqual([]);
  drive.calls.length = 0;
  const idle = await pass(extra);
  expect(drive.calls.filter((c) => !c.startsWith('list'))).toEqual([]);
  expect(idle.stats).toEqual({
    uploaded: 0,
    moved: 0,
    movedLocal: 0,
    downloaded: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    conflicts: 0,
  });
  return result;
}

describe('server renames move the local copy', () => {
  const abs = (p: string) => join(root, ...p.split('/'));
  const noTransfers = () => expect(drive.calls.filter((c) => !c.startsWith('list'))).toEqual([]);

  it('renames the file here: nothing downloaded, nothing sent, nothing trashed', async () => {
    await writeLocal('rapor.txt', 'içerik');
    await pass();
    const { id } = drive.find('rapor.txt')!;
    const before = await stat(abs('rapor.txt'));
    drive.relocate('rapor.txt', 'yeni ad.txt');
    drive.calls.length = 0;
    const trashed: string[] = [];
    const result = await pass({ trash: async (p) => void trashed.push(p) });
    expect(result.errors).toEqual([]);
    expect(result.stats).toMatchObject({ movedLocal: 1, downloaded: 0, deletedLocal: 0 });
    noTransfers();
    expect(trashed).toEqual([]);
    expect(await localTree()).toEqual(['yeni ad.txt=içerik']);
    // The very file that was here, not a copy of it.
    expect((await stat(abs('yeni ad.txt'))).ino).toBe(before.ino);
    expect(base.get('yeni ad.txt')?.nodeId).toBe(id);
    expect(base.has('rapor.txt')).toBe(false);
    expect((await pass()).stats).toMatchObject({ movedLocal: 0, moved: 0, uploaded: 0 });
    expect(drive.find('yeni ad.txt')!.id).toBe(id);
  });

  it('follows a move into a folder that is new here', async () => {
    drive.put('rapor.txt', 'içerik');
    await sync();
    drive.relocate('rapor.txt', 'arşiv/2026/rapor.txt');
    drive.calls.length = 0;
    const result = await pass();
    expect(result.errors).toEqual([]);
    expect(result.stats).toMatchObject({ movedLocal: 1, downloaded: 0 });
    noTransfers();
    expect(await localTree()).toEqual(['arşiv/', 'arşiv/2026/', 'arşiv/2026/rapor.txt=içerik']);
    await sync();
  });

  it('renames a folder as one move, however much is under it', async () => {
    for (let i = 0; i < 60; i++) drive.put(`eski/alt/${i}.txt`, `${i}`);
    await sync();
    drive.relocate('eski', 'yeni');
    drive.calls.length = 0;
    // A delete of 60 files would stop at the mass delete check.
    const result = await pass();
    expect(result.errors).toEqual([]);
    expect(result.stats).toMatchObject({ movedLocal: 1, downloaded: 0, deletedLocal: 0 });
    noTransfers();
    expect(await readFile(abs('yeni/alt/7.txt'), 'utf8')).toBe('7');
    expect(await readdir(root)).toEqual(['yeni']);
    await sync();
  });

  it('downloads only the new version when the file was also edited there', async () => {
    drive.put('rapor.txt', 'ilk');
    drive.put('diğer.txt', 'aynı');
    await sync();
    drive.relocate('rapor.txt', 'yeni.txt');
    drive.put('yeni.txt', 'ikinci');
    drive.calls.length = 0;
    const result = await pass();
    expect(result.stats).toMatchObject({ movedLocal: 1, downloaded: 1, conflicts: 0 });
    expect(drive.calls.filter((c) => c.startsWith('download'))).toEqual(['download yeni.txt']);
    expect(await localTree()).toEqual(['diğer.txt=aynı', 'yeni.txt=ikinci']);
  });

  it('sends an edit made here as a new version of the same node', async () => {
    await writeLocal('rapor.txt', 'ilk');
    await pass();
    const { id } = drive.find('rapor.txt')!;
    await writeLocal('rapor.txt', 'buradaki düzenleme');
    drive.relocate('rapor.txt', 'yeni.txt');
    const result = await pass();
    expect(result.errors).toEqual([]);
    expect(result.stats).toMatchObject({ movedLocal: 1, uploaded: 1, conflicts: 0 });
    const node = drive.find('yeni.txt')!;
    expect(node.id).toBe(id);
    expect(node.version).toBe(2);
    expect(node.content.toString()).toBe('buradaki düzenleme');
    expect(await localTree()).toEqual(['yeni.txt=buradaki düzenleme']);
  });

  it('keeps both when the file was edited on both sides', async () => {
    await writeLocal('rapor.txt', 'ilk');
    await pass();
    await writeLocal('rapor.txt', 'buradaki');
    drive.relocate('rapor.txt', 'yeni.txt');
    drive.put('yeni.txt', 'sunucudaki uzun metin');
    await sync();
    const tree = await localTree();
    expect(tree).toContain('yeni.txt=sunucudaki uzun metin');
    expect(tree.some((l) => l.includes('çakışan kopya') && l.endsWith('=buradaki'))).toBe(true);
    expect(tree).toHaveLength(2);
  });

  it('has nothing to do when both sides gave it the same new name', async () => {
    await writeLocal('rapor.txt', 'içerik');
    await pass();
    await rename(abs('rapor.txt'), abs('yeni.txt'));
    drive.relocate('rapor.txt', 'yeni.txt');
    drive.calls.length = 0;
    const result = await pass();
    expect(result.errors).toEqual([]);
    expect(result.stats).toMatchObject({ movedLocal: 0, moved: 0, downloaded: 0, conflicts: 0 });
    noTransfers();
    expect(base.get('yeni.txt')?.nodeId).toBe(drive.find('yeni.txt')!.id);
  });

  it("takes the server's name when both sides renamed it differently, without a copy", async () => {
    await writeLocal('rapor.txt', 'içerik');
    await pass();
    const { id } = drive.find('rapor.txt')!;
    await rename(abs('rapor.txt'), abs('benim adım.txt'));
    drive.relocate('rapor.txt', 'sunucunun adı.txt');
    const result = await sync();
    expect(result.stats).toMatchObject({ movedLocal: 1, uploaded: 0, downloaded: 0 });
    expect(await localTree()).toEqual(['sunucunun adı.txt=içerik']);
    expect(drive.tree()).toEqual(['sunucunun adı.txt=içerik']);
    expect(drive.find('sunucunun adı.txt')!.id).toBe(id);
  });

  it('carries a local rename inside a folder the server renamed', async () => {
    drive.put('eski/a.txt', 'içerik');
    await sync();
    const { id } = drive.find('eski/a.txt')!;
    await rename(abs('eski/a.txt'), abs('eski/b.txt'));
    drive.relocate('eski', 'yeni');
    const result = await sync();
    expect(result.stats).toMatchObject({ movedLocal: 1, moved: 1, uploaded: 0, downloaded: 0 });
    expect(await localTree()).toEqual(['yeni/', 'yeni/b.txt=içerik']);
    expect(drive.find('yeni/b.txt')!.id).toBe(id);
  });

  it('follows a chain: the name one left is the name the other took', async () => {
    drive.put('a.txt', 'birinci');
    drive.put('b.txt', 'ikinci');
    await sync();
    drive.relocate('b.txt', 'c.txt');
    drive.relocate('a.txt', 'b.txt');
    drive.calls.length = 0;
    const result = await pass();
    expect(result.stats).toMatchObject({ movedLocal: 2, downloaded: 0 });
    noTransfers();
    expect(await localTree()).toEqual(['b.txt=birinci', 'c.txt=ikinci']);
  });

  it('gets two swapped names right by downloading them', async () => {
    drive.put('a.txt', 'birinci');
    drive.put('b.txt', 'ikinci');
    await sync();
    drive.relocate('a.txt', 'gecici.txt');
    drive.relocate('b.txt', 'a.txt');
    drive.relocate('gecici.txt', 'b.txt');
    await sync();
    expect(await localTree()).toEqual(['a.txt=ikinci', 'b.txt=birinci']);
  });

  it('loses nothing when the new name is taken here by another file', async () => {
    drive.put('rapor.txt', 'sunucudaki');
    await sync();
    await writeLocal('yeni.txt', 'başka bir dosya');
    drive.relocate('rapor.txt', 'yeni.txt');
    await sync();
    const tree = await localTree();
    expect(tree).toContain('yeni.txt=sunucudaki');
    expect(tree.some((l) => l.includes('çakışan kopya') && l.endsWith('=başka bir dosya'))).toBe(
      true,
    );
  });

  it('brings it back when it was deleted here and renamed there', async () => {
    drive.put('rapor.txt', 'içerik');
    await sync();
    await rm(abs('rapor.txt'));
    const { id } = drive.relocate('rapor.txt', 'yeni.txt');
    await sync();
    expect(await localTree()).toEqual(['yeni.txt=içerik']);
    expect(drive.find('yeni.txt')!.id).toBe(id);
  });

  it('keeps a file moved out of a folder the server then deleted', async () => {
    drive.put('eski/kalan.txt', 'kalan');
    drive.put('eski/gider.txt', 'gider');
    await sync();
    drive.relocate('eski/kalan.txt', 'kalan.txt');
    drive.remove('eski');
    drive.calls.length = 0;
    const result = await pass();
    expect(result.errors).toEqual([]);
    expect(result.stats).toMatchObject({ movedLocal: 1, downloaded: 0, deletedLocal: 1 });
    expect(await localTree()).toEqual(['kalan.txt=kalan']);
  });

  it('never deletes the file when the move fails here, and tries again', async () => {
    drive.put('rapor.txt', 'içerik');
    await sync();
    const { id } = drive.find('rapor.txt')!;
    // A local file sits where the new folder must go, so the move cannot be made this pass.
    await writeLocal('arşiv', 'bir dosya');
    drive.relocate('rapor.txt', 'arşiv/rapor.txt');
    const failed = await pass();
    expect(failed.errors.map((e) => e.action)).toEqual(['moveLocal']);
    expect(failed.stats).toMatchObject({ movedLocal: 0, deletedLocal: 0, deletedRemote: 0 });
    expect(await readFile(abs('rapor.txt'), 'utf8')).toBe('içerik');
    expect(drive.find('arşiv/rapor.txt')!.id).toBe(id);
    expect(base.get('rapor.txt')?.nodeId).toBe(id);
    // The conflict moved the file aside: now it goes through.
    const again = await sync();
    expect(again.stats).toMatchObject({ movedLocal: 1, downloaded: 0 });
    const tree = await localTree();
    expect(tree).toContain('arşiv/rapor.txt=içerik');
    expect(tree).not.toContain('rapor.txt=içerik');
    expect(tree.some((l) => l.includes('çakışan kopya') && l.endsWith('=bir dosya'))).toBe(true);
  });

  it('holds on to a folder holding a file whose move failed', async () => {
    drive.put('eski/kalan.txt', 'kalan');
    await sync();
    await writeLocal('arşiv', 'bir dosya');
    drive.relocate('eski/kalan.txt', 'arşiv/kalan.txt');
    drive.remove('eski');
    const failed = await pass();
    expect(failed.errors.map((e) => e.action)).toEqual(['moveLocal']);
    expect(await readFile(abs('eski/kalan.txt'), 'utf8')).toBe('kalan');
    await sync();
    const tree = await localTree();
    expect(tree).toContain('arşiv/kalan.txt=kalan');
    expect(tree.some((l) => l.startsWith('eski'))).toBe(false);
  });

  it('follows a change of case only', async () => {
    drive.put('rapor.txt', 'içerik');
    drive.put('klasör/a.txt', 'alt');
    await sync();
    drive.relocate('rapor.txt', 'Rapor.txt');
    drive.relocate('klasör', 'Klasör');
    drive.calls.length = 0;
    const result = await pass();
    expect(result.errors).toEqual([]);
    expect(result.stats).toMatchObject({ movedLocal: 2, downloaded: 0, deletedLocal: 0 });
    noTransfers();
    expect(await localTree()).toEqual(['Klasör/', 'Klasör/a.txt=alt', 'Rapor.txt=içerik']);
    await sync();
  });

  it('works from a base written before file ids existed', async () => {
    drive.put('rapor.txt', 'içerik');
    await sync();
    for (const [path, b] of base) {
      const { localId: _old, ...rest } = b;
      base.set(path, rest);
    }
    drive.relocate('rapor.txt', 'yeni.txt');
    drive.calls.length = 0;
    const result = await pass();
    expect(result.stats).toMatchObject({ movedLocal: 1, downloaded: 0 });
    noTransfers();
  });
});

describe('local renames keep the node', () => {
  const abs = (p: string) => join(root, ...p.split('/'));

  it('renames on the server: same id, same version, nothing sent again', async () => {
    await writeLocal('rapor.txt', 'içerik');
    await pass();
    const { id } = drive.find('rapor.txt')!;
    drive.calls.length = 0;
    await rename(abs('rapor.txt'), abs('yeni ad.txt'));
    const result = await pass();
    expect(result.errors).toEqual([]);
    expect(result.stats).toMatchObject({ moved: 1, uploaded: 0, deletedRemote: 0 });
    const node = drive.find('yeni ad.txt')!;
    expect(node.id).toBe(id);
    expect(node.version).toBe(1);
    expect(drive.find('rapor.txt')).toBeUndefined();
    expect(drive.calls.filter((c) => /upload|trash/.test(c))).toEqual([]);
    expect((await pass()).stats).toMatchObject({ moved: 0, uploaded: 0, downloaded: 0 });
  });

  it('keeps the node when the file was also edited before the sync: a new version of it', async () => {
    await writeLocal('rapor.txt', 'ilk');
    await pass();
    const { id } = drive.find('rapor.txt')!;
    await rename(abs('rapor.txt'), abs('yeni ad.txt'));
    await writeLocal('yeni ad.txt', 'ikinci, daha uzun');
    const result = await pass();
    expect(result.errors).toEqual([]);
    expect(result.stats).toMatchObject({ moved: 1, uploaded: 1, deletedRemote: 0 });
    const node = drive.find('yeni ad.txt')!;
    expect(node.id).toBe(id);
    expect(node.version).toBe(2);
    expect(node.content.toString()).toBe('ikinci, daha uzun');
    expect(drive.find('rapor.txt')).toBeUndefined();
  });

  it('follows a move to another folder, a new one included', async () => {
    await writeLocal('rapor.txt', 'içerik');
    await pass();
    const { id } = drive.find('rapor.txt')!;
    await mkdir(abs('arşiv'));
    await rename(abs('rapor.txt'), abs('arşiv/rapor.txt'));
    const result = await pass();
    expect(result.errors).toEqual([]);
    expect(drive.find('arşiv/rapor.txt')?.id).toBe(id);
    expect(drive.calls).toContain('mkdir arşiv');
    expect(drive.calls.filter((c) => c.startsWith('upload rapor')).length).toBe(1);
  });

  it('renames a folder as one move: everything under it keeps its id', async () => {
    await writeLocal('eski/a.txt', 'a');
    await writeLocal('eski/alt/b.txt', 'b');
    await pass();
    const ids = [
      drive.find('eski')!.id,
      drive.find('eski/a.txt')!.id,
      drive.find('eski/alt/b.txt')!.id,
    ];
    drive.calls.length = 0;
    await rename(abs('eski'), abs('yeni'));
    const result = await pass();
    expect(result.errors).toEqual([]);
    expect(result.stats).toMatchObject({ moved: 1, uploaded: 0, deletedRemote: 0 });
    expect([
      drive.find('yeni')!.id,
      drive.find('yeni/a.txt')!.id,
      drive.find('yeni/alt/b.txt')!.id,
    ]).toEqual(ids);
    expect(drive.calls.filter((c) => c.startsWith('move'))).toEqual(['move eski -> yeni']);
    expect((await pass()).stats).toMatchObject({ moved: 0, uploaded: 0, downloaded: 0 });
  });

  it('handles a rename inside a renamed folder', async () => {
    await writeLocal('eski/a.txt', 'a');
    await pass();
    const { id } = drive.find('eski/a.txt')!;
    await rename(abs('eski/a.txt'), abs('eski/b.txt'));
    await rename(abs('eski'), abs('yeni'));
    expect((await pass()).errors).toEqual([]);
    expect(drive.find('yeni/b.txt')?.id).toBe(id);
  });

  it('downloads a server edit after moving the node', async () => {
    await writeLocal('rapor.txt', 'ilk');
    await pass();
    const { id } = drive.find('rapor.txt')!;
    drive.put('rapor.txt', 'sunucuda değişti');
    await rename(abs('rapor.txt'), abs('yeni ad.txt'));
    expect((await pass()).errors).toEqual([]);
    expect(drive.find('yeni ad.txt')?.id).toBe(id);
    expect(await readFile(abs('yeni ad.txt'), 'utf8')).toBe('sunucuda değişti');
  });

  it('keeps both sides when the file was edited on both and renamed here', async () => {
    await writeLocal('rapor.txt', 'ilk');
    await pass();
    drive.put('rapor.txt', 'sunucuda değişti');
    await rename(abs('rapor.txt'), abs('yeni ad.txt'));
    await writeLocal('yeni ad.txt', 'burada da değişti, daha uzun');
    const result = await pass();
    expect(result.stats.conflicts).toBe(1);
    const contents = (await localTree()).join('|');
    expect(contents).toContain('sunucuda değişti');
    expect(contents).toContain('burada da değişti, daha uzun');
  });

  it('does not take a copy for a rename', async () => {
    await writeLocal('rapor.txt', 'içerik');
    await pass();
    const { id } = drive.find('rapor.txt')!;
    await copyFile(abs('rapor.txt'), abs('kopya.txt'));
    const result = await pass();
    expect(result.stats).toMatchObject({ moved: 0, uploaded: 1 });
    expect(drive.find('rapor.txt')?.id).toBe(id);
    expect(drive.find('kopya.txt')?.id).not.toBe(id);
  });

  it('does not take an unrelated new file for a deleted one, even with the same size and time', async () => {
    await writeLocal('rapor.txt', 'içerik');
    await pass();
    const { id } = drive.find('rapor.txt')!;
    const when = mtime;
    await rm(abs('rapor.txt'));
    await writeFile(abs('başka.txt'), 'içerik');
    await utimes(abs('başka.txt'), new Date(when), new Date(when));
    const result = await pass();
    expect(result.stats).toMatchObject({ moved: 0, uploaded: 1, deletedRemote: 1 });
    expect(drive.find('başka.txt')?.id).not.toBe(id);
  });

  it('uploads as new when the node was deleted on the server meanwhile', async () => {
    await writeLocal('rapor.txt', 'içerik');
    await pass();
    drive.remove('rapor.txt');
    await rename(abs('rapor.txt'), abs('yeni ad.txt'));
    const result = await pass();
    expect(result.errors).toEqual([]);
    expect(result.stats).toMatchObject({ moved: 0, uploaded: 1 });
    expect(drive.read('yeni ad.txt')).toBe('içerik');
  });

  it('never deletes the file when the server refuses the move, and tries again', async () => {
    await writeLocal('rapor.txt', 'içerik');
    await pass();
    const { id } = drive.find('rapor.txt')!;
    drive.failMoves.add('rapor.txt');
    await rename(abs('rapor.txt'), abs('yeni ad.txt'));
    const failed = await pass();
    expect(failed.errors.map((e) => e.action)).toEqual(['moveRemote']);
    expect(failed.stats).toMatchObject({
      moved: 0,
      uploaded: 0,
      deletedRemote: 0,
      deletedLocal: 0,
    });
    expect(await readFile(abs('yeni ad.txt'), 'utf8')).toBe('içerik');
    expect(drive.find('rapor.txt')?.id).toBe(id);
    // Still refused: nothing changes, however many passes run.
    expect((await pass()).stats).toMatchObject({ deletedRemote: 0, deletedLocal: 0 });
    expect(await readFile(abs('yeni ad.txt'), 'utf8')).toBe('içerik');
    drive.failMoves.clear();
    expect((await pass()).errors).toEqual([]);
    expect(drive.find('yeni ad.txt')?.id).toBe(id);
  });

  it('holds back what is under a folder whose move failed', async () => {
    await writeLocal('eski/a.txt', 'a');
    await pass();
    drive.failMoves.add('eski');
    await rename(abs('eski'), abs('yeni'));
    await writeLocal('yeni/a.txt', 'değişti ve daha uzun');
    await writeLocal('yeni/b.txt', 'yeni dosya');
    const failed = await pass();
    expect(failed.errors.map((e) => e.action)).toEqual(['moveRemote']);
    expect(failed.stats).toMatchObject({ uploaded: 0, deletedRemote: 0, deletedLocal: 0 });
    expect(await readFile(abs('yeni/a.txt'), 'utf8')).toBe('değişti ve daha uzun');
    drive.failMoves.clear();
    expect((await pass()).errors).toEqual([]);
    expect(drive.read('yeni/a.txt')).toBe('değişti ve daha uzun');
    expect(drive.read('yeni/b.txt')).toBe('yeni dosya');
    expect(drive.find('eski')).toBeUndefined();
  });

  it('works from a base written before file ids existed', async () => {
    await writeLocal('rapor.txt', 'içerik');
    await pass();
    const { id } = drive.find('rapor.txt')!;
    base = new Map(
      [...base].map(([p, b]) => {
        const { localId: _dropped, ...old } = b;
        return [p, old];
      }),
    );
    await rename(abs('rapor.txt'), abs('yeni ad.txt'));
    const result = await pass();
    expect(result.stats).toMatchObject({ moved: 1, uploaded: 0 });
    expect(drive.find('yeni ad.txt')?.id).toBe(id);
  });

  it('learns the ids of an old base on the next pass', async () => {
    await writeLocal('rapor.txt', 'içerik');
    await pass();
    base = new Map(
      [...base].map(([p, b]) => {
        const { localId: _dropped, ...old } = b;
        return [p, old];
      }),
    );
    const result = await pass();
    expect(result.base.get('rapor.txt')?.localId).toBeTruthy();
  });
});

describe('runPass', () => {
  it('downloads the Drive folder into an empty local folder', async () => {
    drive.put('docs/plan.txt', 'plan');
    drive.put('readme.md', 'hi');
    drive.mkdir('empty');
    await sync();
    expect(await localTree()).toEqual(['docs/', 'docs/plan.txt=plan', 'empty/', 'readme.md=hi']);
  });

  it('uploads local files and folders', async () => {
    await writeLocal('a.txt', 'A');
    await writeLocal('sub/deep/b.txt', 'B');
    await sync();
    expect(drive.tree()).toEqual(['a.txt=A', 'sub/', 'sub/deep/', 'sub/deep/b.txt=B']);
  });

  it('uploads a local edit as a new version and downloads a remote one', async () => {
    await writeLocal('mine.txt', 'v1');
    drive.put('theirs.txt', 'v1');
    await sync();

    await writeLocal('mine.txt', 'v2 local');
    drive.put('theirs.txt', 'v2 remote');
    await sync();

    expect(drive.find('mine.txt')).toMatchObject({ version: 2 });
    expect(drive.read('mine.txt')).toBe('v2 local');
    expect(await readFile(join(root, 'theirs.txt'), 'utf8')).toBe('v2 remote');
  });

  it('carries deletes across in both directions', async () => {
    await writeLocal('keep.txt', 'k');
    await writeLocal('drop-here.txt', 'x');
    await writeLocal('folder/inner.txt', 'i');
    drive.put('drop-there.txt', 'y');
    await sync();

    await rm(join(root, 'drop-here.txt'));
    await rm(join(root, 'folder'), { recursive: true });
    drive.remove('drop-there.txt');
    const result = await sync();

    expect(result.stats).toMatchObject({ deletedLocal: 1, deletedRemote: 2 });
    expect(drive.tree()).toEqual(['keep.txt=k']);
    expect(await localTree()).toEqual(['keep.txt=k']);
  });

  it('keeps both copies when a file changed on both sides', async () => {
    await writeLocal('report.txt', 'base');
    await sync();

    await writeLocal('report.txt', 'local edit');
    drive.put('report.txt', 'remote edit!');
    const first = await pass();
    expect(first.stats.conflicts).toBe(1);
    await sync();

    const copy = 'report (çakışan kopya LAPTOP 2026-10-22 1405).txt';
    expect(await localTree()).toEqual([`${copy}=local edit`, 'report.txt=remote edit!']);
    expect(drive.tree()).toEqual([`${copy}=local edit`, 'report.txt=remote edit!']);
  });

  it('pairs files created on both sides with the same content without a conflict copy', async () => {
    await writeLocal('same.txt', 'equal');
    drive.put('same.txt', 'equal');
    await writeLocal('differ.txt', 'aaaa');
    drive.put('differ.txt', 'bbbb');
    await sync();

    expect(await localTree()).toEqual([
      'differ (çakışan kopya LAPTOP 2026-10-22 1405).txt=aaaa',
      'differ.txt=bbbb',
      'same.txt=equal',
    ]);
  });

  it('matches names that differ only in case on Windows', async () => {
    drive.put('Docs/Rapor.txt', 'same');
    await writeLocal('docs/rapor.txt', 'same');
    await writeLocal('docs/new.txt', 'n');
    await sync();
    expect(drive.tree()).toEqual(['Docs/', 'Docs/Rapor.txt=same', 'Docs/new.txt=n']);
  });

  it('skips names Windows cannot hold and reports them', async () => {
    drive.put('ok.txt', 'ok');
    drive.put('a:b.txt', 'bad');
    drive.put('CON.txt', 'reserved');
    const result = await sync();
    expect(await localTree()).toEqual(['ok.txt=ok']);
    expect(result.skipped.map((s) => [s.path, s.reason]).sort()).toEqual([
      ['CON.txt', 'reserved_name'],
      ['a:b.txt', 'invalid_name'],
    ]);
  });

  it('ignores editor lock files and OS metadata', async () => {
    await writeLocal('~$report.docx', 'lock');
    await writeLocal('Thumbs.db', 'x');
    await writeLocal('real.docx', 'doc');
    await sync();
    expect(drive.tree()).toEqual(['real.docx=doc']);
  });

  it('syncs only below the chosen Drive folder', async () => {
    const folder = drive.mkdir('Projeler/2026');
    drive.put('Projeler/2026/plan.txt', 'p');
    drive.put('outside.txt', 'o');
    await writeLocal('local.txt', 'l');
    await sync({ folderId: folder.id });
    expect(await localTree()).toEqual(['local.txt=l', 'plan.txt=p']);
    expect(drive.read('Projeler/2026/local.txt')).toBe('l');
  });

  it('stops before deleting a lot at once until it is confirmed', async () => {
    for (let i = 0; i < 60; i++) await writeLocal(`f${i}.txt`, String(i));
    await sync();
    for (let i = 0; i < 60; i++) await rm(join(root, `f${i}.txt`));

    await expect(pass()).rejects.toMatchObject({ code: 'mass_delete', details: { count: 60 } });
    expect(drive.tree()).toHaveLength(60);

    await pass({ allowMassDelete: true });
    expect(drive.tree()).toEqual([]);
  });

  it('refuses to run when either root is gone', async () => {
    const folder = drive.mkdir('x');
    drive.remove('x');
    await expect(pass({ folderId: folder.id })).rejects.toBeInstanceOf(SyncError);
    await expect(pass({ root: join(root, 'missing') })).rejects.toMatchObject({
      code: 'local_root_missing',
    });
  });
});
