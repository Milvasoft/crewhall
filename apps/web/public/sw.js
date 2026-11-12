/*
 * Crewhall service worker: makes the web app installable and lets its shell open without a
 * network. It stores two things only: the hashed build files and the HTML shell, neither of which
 * holds a person's data. API answers, realtime, WebDAV, sign-in and vault data never pass through
 * it: the browser handles those requests as if there were no service worker.
 */
/* global self, caches, fetch, URL */
const CACHE = 'crewhall-shell-v1';
const SHELL_KEY = '/__shell';
const MAX_ENTRIES = 200;

/** Paths the worker stays out of, navigations included. */
const NEVER = [
  '/api',
  '/ws',
  '/collab',
  '/mcp',
  '/dav',
  '/caldav',
  '/carddav',
  '/wopi',
  '/oauth',
  '/sso',
  '/.well-known',
  '/healthz',
  '/readyz',
  '/office',
  '/teams',
  '/mockServiceWorker.js',
  '/sw.js',
];

const isUnder = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

/** 'asset', 'shell', or null when the browser should handle the request alone. */
function kindOf(request, origin) {
  if (request.method !== 'GET' || request.headers.get('range')) return null;
  const url = new URL(request.url);
  if (url.origin !== origin || NEVER.some((p) => isUnder(url.pathname, p))) return null;
  if (url.pathname.startsWith('/assets/')) return 'asset';
  return request.mode === 'navigate' ? 'shell' : null;
}

async function store(cache, key, response) {
  await cache.put(key, response);
  const keys = await cache.keys();
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await cache.delete(old);
}

/** Hashed names never change: the stored copy is always right. */
async function asset(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') await store(cache, request, response.clone());
  return response;
}

/** The network first, so a new release shows at once; the last shell when there is none. */
async function shell(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    const html = (response.headers.get('content-type') ?? '').includes('text/html');
    if (response.ok && response.type === 'basic' && html) {
      await store(cache, SHELL_KEY, response.clone());
    }
    return response;
  } catch (error) {
    const hit = await cache.match(SHELL_KEY);
    if (hit) return hit;
    throw error;
  }
}

self.addEventListener('install', () => void self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith('crewhall-shell-') && n !== CACHE).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const kind = kindOf(event.request, self.location.origin);
  if (kind === 'asset') event.respondWith(asset(event.request));
  else if (kind === 'shell') event.respondWith(shell(event.request));
});
