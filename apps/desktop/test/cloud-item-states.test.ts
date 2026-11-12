import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItemStates, WARNING_ICON } from '../src/cloud/item-states';

describe('ItemStates', () => {
  let dir: string;
  let file: string;
  let calls: Array<[string, string, string]>;
  let refuse: Set<string>;

  const make = (maxShown?: number) =>
    new ItemStates({
      native: {
        setItemState: (path, text, icon) => {
          calls.push([path, text, icon]);
          return refuse.has(path) ? Promise.reject(new Error('gone')) : Promise.resolve();
        },
      },
      file,
      maxShown,
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crewhall-states-'));
    file = join(dir, 'state', 'items.json');
    calls = [];
    refuse = new Set();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('shows a problem once and takes it off when it is over', async () => {
    const states = make();
    await states.update(new Map([['a', 'Yüklenemedi']]));
    await states.update(new Map([['a', 'Yüklenemedi']]));
    expect(calls).toEqual([['a', 'Yüklenemedi', WARNING_ICON]]);

    calls = [];
    await states.update(new Map());
    expect(calls).toEqual([['a', '', '']]);
  });

  it('follows a new text', async () => {
    const states = make();
    await states.update(new Map([['a', 'bir']]));
    calls = [];
    await states.update(new Map([['a', 'iki']]));
    expect(calls).toEqual([['a', 'iki', WARNING_ICON]]);
  });

  it('knows after a restart what it left on the files', async () => {
    await make().update(new Map([['a', 'Yüklenemedi']]));
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([['a', 'Yüklenemedi']]);

    calls = [];
    const again = make();
    await again.update(new Map());
    expect(calls).toEqual([['a', '', '']]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([]);
  });

  it('a file that went away does not stop the others, and is not remembered', async () => {
    refuse.add('yok');
    const states = make();
    await states.update(
      new Map([
        ['yok', 'x'],
        ['var', 'x'],
      ]),
    );
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([['var', 'x']]);
  });

  it('tells Explorer about a limited number of files', async () => {
    const states = make(2);
    await states.update(
      new Map([
        ['c', 'x'],
        ['a', 'x'],
        ['b', 'x'],
      ]),
    );
    expect(calls.map(([path]) => path)).toEqual(['a', 'b']);
  });

  it('runs one update at a time, in order', async () => {
    const states = make();
    await Promise.all([
      states.update(new Map([['a', 'x']])),
      states.update(new Map()),
      states.update(new Map([['b', 'x']])),
    ]);
    expect(calls.map(([path, text]) => `${path}:${text}`)).toEqual(['a:x', 'a:', 'b:x']);
  });
});
