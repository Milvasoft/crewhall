import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

type Handler = (event: {
  request: FakeRequest;
  respondWith: (r: Promise<Response>) => void;
}) => void;

interface FakeRequest {
  url: string;
  method: string;
  mode: string;
  headers: Headers;
}

const ORIGIN = 'https://hub.example.com';

function loadWorker() {
  const handlers = new Map<string, Handler>();
  const store = new Map<string, Response>();
  const keyOf = (k: string | FakeRequest) => (typeof k === 'string' ? k : k.url);
  const cache = {
    match: vi.fn(async (k: string | FakeRequest) => store.get(keyOf(k))?.clone()),
    put: vi.fn(async (k: string | FakeRequest, r: Response) => void store.set(keyOf(k), r)),
    keys: vi.fn(async () => [...store.keys()]),
    delete: vi.fn(async (k: string) => store.delete(k)),
  };
  const fetchMock = vi.fn<(r: FakeRequest) => Promise<Response>>();
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (name: string, h: Handler) => handlers.set(name, h),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
  };
  const code = readFileSync(resolve(__dirname, '../public/sw.js'), 'utf8');
  new Function('self', 'caches', 'fetch', code)(
    self,
    { open: async () => cache, keys: async () => [], delete: async () => true },
    fetchMock,
  );
  const handle = (path: string, init: Partial<FakeRequest> = {}) => {
    let answer: Promise<Response> | null = null;
    handlers.get('fetch')!({
      request: {
        url: path.startsWith('http') ? path : `${ORIGIN}${path}`,
        method: 'GET',
        mode: 'cors',
        headers: new Headers(),
        ...init,
      },
      respondWith: (r) => {
        answer = r;
      },
    });
    return answer as Promise<Response> | null;
  };
  return { handle, store, fetchMock };
}

/** A response as the browser hands it to a worker: same origin. */
function basic(body: string, type: string): Response {
  const r = new Response(body, { headers: { 'content-type': type } });
  Object.defineProperty(r, 'type', { value: 'basic' });
  return r;
}

describe('service worker', () => {
  it.each([
    '/api/v1/me',
    '/api/v1/vaults/1/items',
    '/api/auth/session',
    '/api/manifest.webmanifest',
    '/ws',
    '/collab/doc',
    '/mcp',
    '/dav/file.txt',
    '/oauth/token',
    '/sw.js',
  ])('leaves %s to the browser, even as a navigation', (path) => {
    const { handle } = loadWorker();
    expect(handle(path)).toBeNull();
    expect(handle(path, { mode: 'navigate' })).toBeNull();
  });

  it('leaves other origins, writes and range requests to the browser', () => {
    const { handle } = loadWorker();
    expect(handle('https://s3.example.com/assets/a.js')).toBeNull();
    expect(handle('/assets/a.js', { method: 'POST' })).toBeNull();
    expect(handle('/assets/a.js', { headers: new Headers({ range: 'bytes=0-1' }) })).toBeNull();
    expect(handle('/emoji/anim/1f600.json')).toBeNull();
  });

  it('keeps hashed build files and answers from the copy afterwards', async () => {
    const { handle, fetchMock } = loadWorker();
    fetchMock.mockResolvedValue(basic('code', 'text/javascript'));
    expect(await (await handle('/assets/a-1.js'))!.text()).toBe('code');
    expect(await (await handle('/assets/a-1.js'))!.text()).toBe('code');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prefers the network for pages and opens the last shell offline', async () => {
    const { handle, fetchMock, store } = loadWorker();
    fetchMock.mockResolvedValueOnce(basic('<html>v1</html>', 'text/html'));
    expect(await (await handle('/vault', { mode: 'navigate' }))!.text()).toBe('<html>v1</html>');
    expect([...store.keys()]).toEqual(['/__shell']);
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    expect(await (await handle('/chat', { mode: 'navigate' }))!.text()).toBe('<html>v1</html>');
  });

  it('does not keep an error page as the shell', async () => {
    const { handle, fetchMock, store } = loadWorker();
    fetchMock.mockResolvedValueOnce(
      Object.defineProperty(new Response('nope', { status: 503 }), 'type', { value: 'basic' }),
    );
    await handle('/chat', { mode: 'navigate' });
    expect(store.size).toBe(0);
  });
});
