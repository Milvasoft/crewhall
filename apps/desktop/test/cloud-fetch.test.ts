import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiClient } from '@crewhall/api-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FetchServer,
  FetchStatus,
  TRANSFER_ALIGN,
  alignedPieces,
  type ContentSource,
  type FetchProgress,
} from '../src/cloud/fetch-server';
import { loadCloudFiles, type CloudFetchEvent } from '../src/cloud/native';
import { createChangeFeed, createContentSource } from '../src/sync/remote';

async function* chunks(...parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield part;
  await Promise.resolve();
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

const until = async (what: string, check: () => boolean): Promise<void> => {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
};

describe('alignedPieces', () => {
  it('keeps every piece aligned but the last, however the stream is cut', async () => {
    const content = randomBytes(TRANSFER_ALIGN * 7 + 123);
    const cuts = [1, 4095, 4097, 10_000, 3, content.length];
    const parts: Uint8Array[] = [];
    let at = 0;
    for (const cut of cuts) {
      parts.push(content.subarray(at, at + cut));
      at += cut;
    }
    const pieces = await collect(alignedPieces(chunks(...parts), TRANSFER_ALIGN * 2));
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces.slice(0, -1)) expect(piece.length % TRANSFER_ALIGN).toBe(0);
    expect(Buffer.concat(pieces).equals(content)).toBe(true);
  });

  it('gives one short piece for a small file and nothing for no bytes', async () => {
    expect((await collect(alignedPieces(chunks(Buffer.alloc(10))))).map((p) => p.length)).toEqual([
      10,
    ]);
    expect(await collect(alignedPieces(chunks()))).toEqual([]);
  });

  it('holds no piece back when the data ends exactly on a boundary', async () => {
    const pieces = await collect(
      alignedPieces(chunks(Buffer.alloc(TRANSFER_ALIGN)), TRANSFER_ALIGN),
    );
    expect(pieces.map((p) => p.length)).toEqual([TRANSFER_ALIGN]);
  });
});

describe('FetchServer', () => {
  let sent: Array<{ key: string; offset: number; length: number; data: Buffer }>;
  let failed: Array<{ key: string; status: number; offset: number; length: number }>;
  let progress: FetchProgress[];
  let source: ContentSource;
  let server: FetchServer;
  let transferError: Error | null;

  const fetchEvent = (key: string, fileSize: number, offset = 0): CloudFetchEvent => ({
    type: 'fetch',
    path: `C:\\kok\\${key}`,
    identity: `node-${key}`,
    transferKey: key,
    offset,
    length: fileSize - offset,
    fileSize,
    process: 'test.exe',
  });

  const make = (options: { stallMs?: number; maxRunning?: number } = {}): void => {
    server = new FetchServer({
      native: {
        transfer: (_c, key, data, offset) => {
          if (transferError) return Promise.reject(transferError);
          sent.push({ key, offset, length: data.length, data });
          return Promise.resolve();
        },
        transferFail: (_c, key, offset, length, status) => {
          failed.push({ key, status, offset, length });
          return Promise.resolve();
        },
      },
      connection: () => 'c1',
      source: { read: (...args) => source.read(...args) },
      onProgress: (p) => progress.push(p),
      pieceBytes: TRANSFER_ALIGN * 4,
      ...options,
    });
  };

  beforeEach(() => {
    sent = [];
    failed = [];
    progress = [];
    transferError = null;
    make();
  });

  it('sends the file in order and reports how far it got', async () => {
    const content = randomBytes(TRANSFER_ALIGN * 10 + 7);
    source = { read: () => Promise.resolve(chunks(content)) };
    server.handle(fetchEvent('a', content.length));
    await until('the end', () => progress.at(-1)?.state === 'done');
    expect(Buffer.concat(sent.map((s) => s.data)).equals(content)).toBe(true);
    let at = 0;
    for (const s of sent) {
      expect(s.offset).toBe(at);
      at += s.length;
    }
    expect(failed).toEqual([]);
    expect(progress.at(-1)).toEqual({
      path: 'C:\\kok\\a',
      done: content.length,
      total: content.length,
      state: 'done',
    });
    expect(progress.length).toBeGreaterThan(1);
  });

  it('continues from where Windows says a file stopped', async () => {
    const asked: Array<[string, number]> = [];
    const rest = randomBytes(TRANSFER_ALIGN + 5);
    const offset = TRANSFER_ALIGN * 3;
    source = {
      read: (nodeId, from) => {
        asked.push([nodeId, from]);
        return Promise.resolve(chunks(rest));
      },
    };
    server.handle(fetchEvent('a', offset + rest.length, offset));
    await until('the end', () => progress.at(-1)?.state === 'done');
    expect(asked).toEqual([['node-a', offset]]);
    expect(sent[0]!.offset).toBe(offset);
  });

  it.each([
    ['shorter', 100, 200],
    ['longer', TRANSFER_ALIGN * 8, 100],
  ])(
    'fails when the server has a %s file than the placeholder says',
    async (_n, real, promised) => {
      source = { read: () => Promise.resolve(chunks(Buffer.alloc(real))) };
      server.handle(fetchEvent('a', promised));
      await until('the failure', () => failed.length > 0);
      expect(failed).toEqual([
        { key: 'a', status: FetchStatus.unsuccessful, offset: 0, length: promised },
      ]);
      expect(sent.reduce((n, s) => n + s.length, 0)).toBeLessThanOrEqual(promised);
      expect(progress.at(-1)?.state).toBe('failed');
    },
  );

  it.each([
    ['no network', new TypeError('fetch failed'), FetchStatus.networkUnavailable],
    ['no permission', Object.assign(new Error('x'), { status: 403 }), FetchStatus.accessDenied],
    ['signed out', Object.assign(new Error('x'), { status: 401 }), FetchStatus.accessDenied],
    ['gone', Object.assign(new Error('x'), { status: 404 }), FetchStatus.unsuccessful],
    ['server error', Object.assign(new Error('x'), { status: 500 }), FetchStatus.unsuccessful],
  ])('tells the program why: %s', async (_n, err, status) => {
    source = { read: () => Promise.reject(err) };
    server.handle(fetchEvent('a', 100));
    await until('the failure', () => failed.length > 0);
    expect(failed[0]!.status).toBe(status);
  });

  it('fails a stream that breaks half way, at the offset it was asked for', async () => {
    source = {
      read: () =>
        Promise.resolve(
          (async function* () {
            yield Buffer.alloc(TRANSFER_ALIGN * 4);
            await Promise.resolve();
            throw new TypeError('connection reset');
          })(),
        ),
    };
    server.handle(fetchEvent('a', TRANSFER_ALIGN * 8));
    await until('the failure', () => failed.length > 0);
    expect(sent).toHaveLength(1);
    expect(failed).toEqual([
      {
        key: 'a',
        status: FetchStatus.networkUnavailable,
        offset: 0,
        length: TRANSFER_ALIGN * 8,
      },
    ]);
  });

  it('gives up on a server that stays silent and aborts the request', async () => {
    make({ stallMs: 20 });
    let signal: AbortSignal | undefined;
    source = {
      read: (_n, _f, s) => {
        signal = s;
        return new Promise(() => undefined);
      },
    };
    server.handle(fetchEvent('a', 100));
    await until('the failure', () => failed.length > 0);
    expect(failed[0]!.status).toBe(FetchStatus.networkUnavailable);
    expect(signal?.aborted).toBe(true);
  });

  it('gives up on a stream that stops sending', async () => {
    make({ stallMs: 20 });
    source = {
      read: () =>
        Promise.resolve(
          (async function* () {
            yield Buffer.alloc(TRANSFER_ALIGN * 4);
            await new Promise(() => undefined);
          })(),
        ),
    };
    server.handle(fetchEvent('a', TRANSFER_ALIGN * 8));
    await until('the failure', () => failed.length > 0);
    expect(failed[0]!.status).toBe(FetchStatus.networkUnavailable);
  });

  it('stops without a read error when Windows cancels', async () => {
    let signal: AbortSignal | undefined;
    source = {
      read: (_n, _f, s) => {
        signal = s;
        return new Promise(() => undefined);
      },
    };
    const event = fetchEvent('a', 100);
    server.handle(event);
    await until('the request', () => signal !== undefined);
    server.handle({ ...event, type: 'cancel' });
    expect(signal?.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(failed).toEqual([]);
  });

  it('starts over when Windows asks again under the same key', async () => {
    const signals: AbortSignal[] = [];
    const content = Buffer.alloc(100, 1);
    source = {
      read: (_n, _f, s) => {
        signals.push(s);
        return signals.length === 1
          ? new Promise(() => undefined)
          : Promise.resolve(chunks(content));
      },
    };
    server.handle(fetchEvent('a', 100));
    await until('the first request', () => signals.length === 1);
    server.handle(fetchEvent('a', 100));
    await until('the end', () => progress.at(-1)?.state === 'done');
    expect(signals[0]!.aborted).toBe(true);
    expect(sent).toHaveLength(1);
    expect(failed).toEqual([]);
  });

  it('runs a few at a time and starts the next as one ends', async () => {
    make({ maxRunning: 2 });
    const release = new Map<string, () => void>();
    source = {
      read: (nodeId) =>
        new Promise((resolve) => {
          release.set(nodeId, () => resolve(chunks(Buffer.alloc(10))));
        }),
    };
    for (const key of ['a', 'b', 'c', 'd']) server.handle(fetchEvent(key, 10));
    await until('two running', () => release.size === 2);
    await new Promise((r) => setTimeout(r, 10));
    expect([...release.keys()]).toEqual(['node-a', 'node-b']);
    // A waiting one that is cancelled never starts.
    server.handle({ ...fetchEvent('c', 10), type: 'cancel' });
    release.get('node-a')!();
    await until('the next', () => release.has('node-d'));
    expect(release.has('node-c')).toBe(false);
    release.get('node-b')!();
    release.get('node-d')!();
    await until('all done', () => progress.filter((p) => p.state === 'done').length === 3);
  });

  it('fails what is waiting and running when it stops', async () => {
    make({ maxRunning: 1 });
    source = { read: () => new Promise(() => undefined) };
    server.handle(fetchEvent('a', 100));
    server.handle(fetchEvent('b', 100));
    await until('a running', () => true);
    server.stop();
    await until('both failed', () => failed.length === 2);
    expect(failed.map((f) => f.key).sort()).toEqual(['a', 'b']);
  });

  it('survives a transfer Windows refuses and a failure it cannot report', async () => {
    source = { read: () => Promise.resolve(chunks(Buffer.alloc(100))) };
    transferError = new Error('connection gone');
    server.handle(fetchEvent('a', 100));
    await until('the failure', () => failed.length > 0);
    transferError = null;
    const quiet = new FetchServer({
      native: {
        transfer: () => Promise.reject(new Error('gone')),
        transferFail: () => Promise.reject(new Error('gone too')),
      },
      connection: () => 'c1',
      source,
    });
    quiet.handle(fetchEvent('b', 100));
    await new Promise((r) => setTimeout(r, 20));
  });
});

describe('createChangeFeed', () => {
  it('asks for files and folders from the cursor it is given', async () => {
    const calls: unknown[] = [];
    const api = {
      call: (name: string, input: unknown) => {
        calls.push([name, input]);
        return Promise.resolve({ items: [], nextCursor: 'c2', hasMore: false });
      },
    } as unknown as ApiClient;
    const page = await createChangeFeed(api).page('c1');
    expect(page.nextCursor).toBe('c2');
    expect(calls).toEqual([
      ['listDriveChanges', { query: { cursor: 'c1', limit: 200, types: 'folder,file' } }],
    ]);
  });
});

describe('createContentSource', () => {
  const api = {
    call: () => Promise.resolve({ url: 'https://s3.test/x' }),
  } as unknown as ApiClient;
  const signal = new AbortController().signal;

  it('asks for the rest with a range and reads the answer', async () => {
    const seen: Array<RequestInit | undefined> = [];
    const source = createContentSource(api, (_u, init) => {
      seen.push(init);
      return Promise.resolve(new Response('dünya', { status: 206 }));
    });
    const body = await collect(await source.read('n', 4096, signal));
    expect(Buffer.concat(body).toString()).toBe('dünya');
    expect(seen[0]?.headers).toEqual({ Range: 'bytes=4096-' });
    expect(seen[0]?.signal).toBe(signal);
  });

  it('sends no range from the start', async () => {
    const seen: Array<RequestInit | undefined> = [];
    const source = createContentSource(api, (_u, init) => {
      seen.push(init);
      return Promise.resolve(new Response('merhaba'));
    });
    expect(Buffer.concat(await collect(await source.read('n', 0, signal))).toString()).toBe(
      'merhaba',
    );
    expect(seen[0]?.headers).toBeUndefined();
  });

  it('skips the start itself when the server ignores the range', async () => {
    const source = createContentSource(api, () => Promise.resolve(new Response('0123456789')));
    expect(Buffer.concat(await collect(await source.read('n', 4, signal))).toString()).toBe(
      '456789',
    );
  });

  it('gives the status of a refused download', async () => {
    const source = createContentSource(api, () =>
      Promise.resolve(new Response('yok', { status: 404 })),
    );
    await expect(source.read('n', 0, signal)).rejects.toMatchObject({ status: 404 });
  });
});

const native = loadCloudFiles(
  join(import.meta.dirname, '../native/cloudfiles/build/Release/cloudfiles.node'),
);

describe.skipIf(!native)('FetchServer against the real Cloud Files API', () => {
  const cf = native!;
  const options = { provider: 'CrewhallDevTest', account: 'fetch' };
  let base: string;
  let root: string;
  let key: string;
  let server: FetchServer;
  let contents: Map<string, Buffer>;
  let broken: Error | null = null;

  const read = (path: string): Promise<{ code: number | null; data: Buffer }> =>
    new Promise((resolve) => {
      const script =
        "try{process.stdout.write(require('fs').readFileSync(process.argv[1]))}" +
        'catch(e){process.exit(3)}';
      const child = spawn(process.execPath, ['-e', script, path], { windowsHide: true });
      const out: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.on('close', (code) => resolve({ code, data: Buffer.concat(out) }));
    });

  const place = async (name: string, content: Buffer): Promise<string> => {
    contents.set(name, content);
    await cf.createPlaceholders(root, [
      { name, identity: name, size: content.length, mtimeMs: Date.now() },
    ]);
    return join(root, name);
  };

  beforeAll(async () => {
    base = mkdtempSync(join(realpathSync.native(tmpdir()), 'crewhall-cf-fetch-'));
    root = join(base, 'kok');
    mkdirSync(root);
    contents = new Map();
    await cf.registerRoot({ root, ...options, version: '1.0' });
    server = new FetchServer({
      native: cf,
      connection: () => key,
      source: {
        read: (nodeId, from) => {
          if (broken) return Promise.reject(broken);
          const content = contents.get(nodeId)!;
          return Promise.resolve(
            chunks(content.subarray(from, from + 70_000), content.subarray(from + 70_000)),
          );
        },
      },
    });
    key = await cf.connect(root, (e) => server.handle(e));
  });

  afterAll(async () => {
    server.stop();
    await cf.disconnect(key).catch(() => undefined);
    await cf.unregisterRoot({ root, ...options }).catch(() => undefined);
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('a program reads a large file that was not here', async () => {
    const content = randomBytes(3 * 1024 * 1024 + 11);
    const path = await place('buyuk.bin', content);
    const result = await read(path);
    expect(result.code).toBe(0);
    expect(result.data.equals(content)).toBe(true);
    expect((await cf.info(path)).onDisk).toBeGreaterThanOrEqual(content.length);
  });

  it('a program gets a read error, then succeeds once the network is back', async () => {
    const content = randomBytes(20_000);
    const path = await place('ag.bin', content);
    broken = new TypeError('fetch failed');
    expect((await read(path)).code).toBe(3);
    broken = null;
    const result = await read(path);
    expect(result.code).toBe(0);
    expect(result.data.equals(content)).toBe(true);
  });

  it('a file shorter on the server than promised gives a read error, not a wrong file', async () => {
    const path = await place('kisa.bin', randomBytes(20_000));
    contents.set('kisa.bin', randomBytes(19_000));
    expect((await read(path)).code).toBe(3);
  });
});
