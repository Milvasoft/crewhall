import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PinKeeper, wantOf, type PinKeeperOptions } from '../src/cloud/pins';

const DIRECTORY = 0x10;
const PINNED = 0x80000;
const UNPINNED = 0x100000;
const NOT_HERE = 0x400000;

describe('wantOf', () => {
  it.each([
    ['a file nobody asked about', 0, null],
    ['one not here, nobody asked', NOT_HERE, null],
    ['kept, and not here yet', PINNED | NOT_HERE, 'hydrate'],
    ['kept, and here', PINNED, null],
    ['freed, and still here', UNPINNED, 'free'],
    ['freed, and gone', UNPINNED | NOT_HERE, null],
    ['a folder, whatever its mark', DIRECTORY | PINNED | NOT_HERE, null],
    ['a folder to free', DIRECTORY | UNPINNED, null],
  ])('%s', (_name, attributes, want) => {
    expect(wantOf(attributes)).toBe(want);
  });
});

describe('PinKeeper', () => {
  let root: string;
  let attributes: Map<string, number>;
  let hydrated: string[];
  let freed: string[];
  let hydrate: (path: string) => Promise<void>;
  let dehydrate: (path: string) => Promise<void>;
  let canFree: (path: string) => Promise<boolean>;
  let changeOf: ((name: string) => void) | null;
  let goneOf: (() => void) | null;
  let watches: number;
  let clock: number;
  let keeper: PinKeeper;

  const make = (extra: Partial<PinKeeperOptions> = {}) =>
    new PinKeeper({
      native: {
        attributes: (p) => {
          const a = attributes.get(p);
          return a === undefined ? Promise.reject(new Error('gone')) : Promise.resolve(a);
        },
        hydrate: (p) => hydrate(p),
        dehydrate: (p) => dehydrate(p),
      },
      root,
      canFree: (p) => canFree(p),
      watchRoot: (_root, onChange, onGone) => {
        watches++;
        changeOf = onChange;
        goneOf = onGone;
        return () => {
          changeOf = null;
        };
      },
      now: () => clock,
      debounceMs: 1,
      retryMs: 1000,
      ...extra,
    });

  const p = (name: string) => join(root, name);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'crewhall-pins-'));
    attributes = new Map();
    hydrated = [];
    freed = [];
    hydrate = (path) => {
      hydrated.push(path);
      attributes.set(path, PINNED);
      return Promise.resolve();
    };
    dehydrate = (path) => {
      freed.push(path);
      attributes.set(path, UNPINNED | NOT_HERE);
      return Promise.resolve();
    };
    canFree = () => Promise.resolve(true);
    changeOf = null;
    goneOf = null;
    watches = 0;
    clock = 1_000_000;
    keeper = make();
  });

  afterEach(async () => {
    keeper.stop();
    await rm(root, { recursive: true, force: true });
  });

  const change = async (name: string, value?: number): Promise<void> => {
    if (value === undefined) attributes.delete(p(name));
    else attributes.set(p(name), value);
    changeOf!(name);
    await new Promise((r) => setTimeout(r, 5));
    await keeper.idle();
  };

  it('brings down a file marked to stay', async () => {
    keeper.start();
    await change('a.txt', PINNED | NOT_HERE);
    expect(hydrated).toEqual([p('a.txt')]);
    expect(freed).toEqual([]);
  });

  it('drops the bytes of a file marked to be freed', async () => {
    keeper.start();
    await change('a.txt', UNPINNED);
    expect(freed).toEqual([p('a.txt')]);
    expect(hydrated).toEqual([]);
  });

  it('never drops what is not on the server, and frees it once a pass has uploaded it', async () => {
    let uploaded = false;
    canFree = () => Promise.resolve(uploaded);
    keeper.start();
    await change('a.txt', UNPINNED);
    expect(freed).toEqual([]);

    uploaded = true;
    keeper.afterPass();
    await new Promise((r) => setTimeout(r, 5));
    await keeper.idle();
    expect(freed).toEqual([p('a.txt')]);
  });

  it('tries a file in use again, later', async () => {
    let inUse = true;
    dehydrate = (path) => {
      if (inUse) return Promise.reject(new Error('in use'));
      freed.push(path);
      attributes.set(path, UNPINNED | NOT_HERE);
      return Promise.resolve();
    };
    keeper.start();
    await change('a.txt', UNPINNED);
    expect(freed).toEqual([]);

    inUse = false;
    // Not yet its time.
    keeper.tick();
    await new Promise((r) => setTimeout(r, 5));
    await keeper.idle();
    expect(freed).toEqual([]);

    clock += 1000;
    keeper.tick();
    await new Promise((r) => setTimeout(r, 5));
    await keeper.idle();
    expect(freed).toEqual([p('a.txt')]);
  });

  it('waits longer each time a download fails, and a change does not hurry it', async () => {
    let tries = 0;
    hydrate = () => {
      tries++;
      return Promise.reject(new Error('no network'));
    };
    keeper.start();
    await change('a.txt', PINNED | NOT_HERE);
    expect(tries).toBe(1);

    // A failed try may look like a change, and that must not become a loop.
    await change('a.txt', PINNED | NOT_HERE);
    expect(tries).toBe(1);

    const tick = async () => {
      keeper.tick();
      await new Promise((r) => setTimeout(r, 5));
      await keeper.idle();
    };
    clock += 1000;
    await tick();
    expect(tries).toBe(2);

    clock += 1000;
    await tick();
    expect(tries).toBe(2);

    clock += 1000;
    await tick();
    expect(tries).toBe(3);
  });

  it('being asked for the other thing does not wait for the failed try', async () => {
    hydrate = () => Promise.reject(new Error('no network'));
    keeper.start();
    await change('a.txt', PINNED | NOT_HERE);
    await change('a.txt', UNPINNED);
    expect(freed).toEqual([p('a.txt')]);
  });

  it('forgets a file that went away', async () => {
    let tries = 0;
    hydrate = () => {
      tries++;
      return Promise.reject(new Error('no network'));
    };
    keeper.start();
    await change('a.txt', PINNED | NOT_HERE);
    await change('a.txt', undefined);
    clock += 100_000;
    keeper.tick();
    await new Promise((r) => setTimeout(r, 5));
    await keeper.idle();
    expect(tries).toBe(1);
  });

  it('brings down only two at a time, so downloads keep a thread to arrive on', async () => {
    const release: Array<() => void> = [];
    let running = 0;
    let most = 0;
    hydrate = (path) => {
      running++;
      most = Math.max(most, running);
      return new Promise((resolve) => {
        release.push(() => {
          running--;
          attributes.set(path, PINNED);
          resolve();
        });
      });
    };
    keeper.start();
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      attributes.set(p(name), PINNED | NOT_HERE);
      changeOf!(name);
    }
    while (release.length < 2) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20));
    expect(running).toBe(2);
    for (let done = 0; done < 5; done++) {
      while (release.length === 0) await new Promise((r) => setTimeout(r, 5));
      release.shift()!();
      await new Promise((r) => setTimeout(r, 5));
    }
    await keeper.idle();
    expect(most).toBe(2);
    expect(running).toBe(0);
  });

  it('catches up on what was marked while it was off, through folders', async () => {
    await mkdir(join(root, 'klasör'));
    await writeFile(join(root, 'klasör', 'iç.txt'), 'x');
    await writeFile(join(root, 'dış.txt'), 'x');
    attributes.set(p('klasör'), DIRECTORY | PINNED);
    attributes.set(join(root, 'klasör', 'iç.txt'), PINNED | NOT_HERE);
    attributes.set(p('dış.txt'), UNPINNED);
    keeper.start();
    await keeper.idle();
    expect(hydrated).toEqual([join(root, 'klasör', 'iç.txt')]);
    expect(freed).toEqual([p('dış.txt')]);
  });

  it('starts nothing after it stops', async () => {
    keeper.start();
    attributes.set(p('a.txt'), PINNED | NOT_HERE);
    changeOf!('a.txt');
    keeper.stop();
    await new Promise((r) => setTimeout(r, 10));
    await keeper.idle();
    expect(hydrated).toEqual([]);
  });

  it('follows changes again after the folder went away', async () => {
    keeper.start();
    expect(watches).toBe(1);
    goneOf!();
    keeper.tick();
    expect(watches).toBe(2);
    await change('a.txt', PINNED | NOT_HERE);
    expect(hydrated).toEqual([p('a.txt')]);
  });
});
