/**
 * End-to-end check of a freshly installed production stack (docker/compose.yml), through the
 * edge proxy exactly as a browser would reach it (docs/kurulum.md "Kurulumu doğrula"):
 *   1. setup wizard with the setup token, owner sign-in and 2FA enrolment
 *   2. a page edited by two collab clients at once (Hocuspocus over /collab)
 *   3. chat: a message sent over HTTP arrives on the WebSocket (/ws)
 *   4. a portal site and its content token (printed for the portal service)
 *
 *   STACK_URL=https://hub.example.com STACK_SETUP_TOKEN=… \
 *     pnpm --filter @crewhall/backend exec tsx src/scripts/accept-stack.ts
 * Optional: STACK_INSECURE=1 accepts Caddy's local certificates (*.localhost test installs);
 * names ending in .localhost resolve to 127.0.0.1 even where the OS does not.
 */
import dns from 'node:dns';
import { randomUUID } from 'node:crypto';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { createApiClient } from '@crewhall/api-client';
import { totpCode } from './totp';

const STACK = (process.env.STACK_URL ?? '').replace(/\/$/, '');
const SETUP_TOKEN = process.env.STACK_SETUP_TOKEN ?? '';
if (!STACK) throw new Error('STACK_URL is required');
if (process.env.STACK_INSECURE === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// *.localhost → loopback (RFC 6761); Windows' resolver does not do it.
const lookup = dns.lookup;
const loopback = ((host: string, options: unknown, callback?: unknown) => {
  const cb = (typeof options === 'function' ? options : callback) as (
    err: Error | null,
    address: string | { address: string; family: number }[],
    family?: number,
  ) => void;
  if (host === 'localhost' || host.endsWith('.localhost')) {
    const all = typeof options === 'object' && options !== null && 'all' in options;
    if (all && (options as { all?: boolean }).all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
    else cb(null, '127.0.0.1', 4);
    return;
  }
  return (lookup as (...a: unknown[]) => void)(host, options, callback);
}) as typeof dns.lookup;
dns.lookup = loopback;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`timed out: ${what}`);
}
const step = (s: string) => console.log(`\n› ${s}`);
const ok = (s: string) => console.log(`  ✓ ${s}`);

const cookies = new Map<string, string>();
async function browserFetch(input: string | URL | Request, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Origin', STACK);
  if (cookies.size) headers.set('Cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '));
  const res = await fetch(input, { ...init, headers });
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair?.indexOf('=') ?? -1;
    if (pair && eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return res;
}
const api = createApiClient({ baseUrl: STACK, fetch: browserFetch, validateResponses: true });
async function auth<T>(path: string, body: unknown): Promise<T> {
  const res = await browserFetch(`${STACK}/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const EMAIL = 'kurulum@example.com';
const PASSWORD = `Kurulum-${randomUUID()}`;

async function main() {
  step('Edge and api');
  await until(
    async () => {
      const r = await fetch(`${STACK}/readyz`).catch(() => null);
      return r?.ok === true;
    },
    'readyz',
    120_000,
  );
  const boot = await api.call('bootstrap');
  if (!boot.needsSetup) throw new Error('the stack is already set up (use a fresh install)');
  ok(`bootstrap: setup needed, server ${boot.server?.version ?? '?'}`);

  step('Setup wizard');
  await api.call('setup', {
    body: {
      setupToken: SETUP_TOKEN,
      org: { name: 'Kurulum Deneme', slug: 'kurulum', defaultLocale: 'tr' },
      owner: { name: 'Kurulum Sahibi', email: EMAIL, password: PASSWORD },
      spaces: [{ name: 'Genel', color: 's1', isDefault: true }],
    },
  });
  ok('org and owner created');
  await auth('/sign-in/email', { email: EMAIL, password: PASSWORD });
  const enabled = await auth<{ totpURI: string }>('/two-factor/enable', { password: PASSWORD });
  await auth('/two-factor/verify-totp', { code: await totpCode(enabled.totpURI) });
  const me = await api.call('me');
  ok(`signed in as ${me.user.email}, TOTP on: ${me.user.twoFactorEnabled}`);
  const space = (await api.call('listSpaces', { query: {} })).items.find((s) => s.name === 'Genel');
  if (!space) throw new Error('default space missing');

  step('Drive upload and download through the S3 domain');
  const content = Buffer.from(`Crewhall kurulum dosyası ${new Date().toISOString()}`);
  const upload = await api.call('createUpload', {
    body: {
      spaceId: space.id,
      parentId: null,
      name: 'kurulum.txt',
      sizeBytes: content.length,
      mime: 'text/plain',
    },
  });
  const { parts } = await api.call('getUploadPartUrls', {
    params: { uploadId: upload.id },
    body: { partNumbers: [1] },
  });
  const put = await fetch(parts[0]!.url, { method: 'PUT', body: content });
  if (!put.ok) throw new Error(`S3 PUT ${put.status}: ${await put.text()}`);
  const done = await api.call('completeUpload', {
    params: { uploadId: upload.id },
    body: { parts: [{ partNumber: 1, etag: put.headers.get('etag') ?? '' }] },
  });
  const link = await api.call('getDownloadUrl', { params: { nodeId: done.node.id }, query: {} });
  const back = await (await fetch(link.url)).text();
  if (back !== content.toString()) throw new Error('downloaded content differs');
  ok(`uploaded and downloaded over ${new URL(parts[0]!.url).host}`);

  step('Page edited by two collab clients (/collab)');
  const page = await api.call('createPage', {
    params: { spaceId: space.id },
    body: { name: 'Kurulum notları' },
  });
  const docs = [new Y.Doc(), new Y.Doc()];
  const providers: HocuspocusProvider[] = [];
  for (const doc of docs) {
    const t = await api.call('createCollabToken', { params: { nodeId: page.id }, body: {} });
    let failed = false;
    const provider = new HocuspocusProvider({
      url: t.url,
      name: t.documentName,
      document: doc,
      token: t.token,
      onAuthenticationFailed: () => {
        failed = true;
      },
    });
    providers.push(provider);
    await until(() => provider.isSynced || failed, 'collab sync');
    if (failed) throw new Error('collab authentication failed');
    ok(`client ${providers.length} synced over ${t.url}`);
  }
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText('İki istemciden yazıldı')]);
  docs[0]!.getXmlFragment('default').insert(0, [paragraph]);
  await until(
    () => docs[1]!.getXmlFragment('default').toString().includes('İki istemciden yazıldı'),
    'the second client sees the edit',
  );
  ok("the second client received the first one's edit");
  await until(async () => {
    const c = await api.call('getPageContent', {
      params: { nodeId: page.id },
      query: { format: 'markdown' },
    });
    return c.markdown.includes('İki istemciden yazıldı');
  }, 'the page is stored');
  ok('collab stored the document (markdown has the text)');
  for (const p of providers) p.destroy();

  step('Chat over the WebSocket (/ws)');
  const conv = await api.call('createConversation', {
    body: { type: 'space', spaceId: space.id, name: 'Kurulum sohbeti' },
  });
  const ticket = await api.call('createWsTicket');
  const wsUrl = `${STACK.replace(/^http/, 'ws')}${ticket.path}?ticket=${encodeURIComponent(ticket.ticket)}`;
  const ws = new WebSocket(wsUrl);
  const events: { type: string; message?: { text: string } }[] = [];
  ws.addEventListener('message', (e) => events.push(JSON.parse(String(e.data))));
  await until(() => events.some((e) => e.type === 'ready'), 'ws ready');
  ok('WebSocket connected');
  const sent = Date.now();
  await api.call('sendMessage', {
    params: { conversationId: conv.id },
    body: { clientMsgId: randomUUID(), text: 'Kurulum tamam' },
  });
  await until(
    () => events.some((e) => e.type === 'message.created' && e.message?.text === 'Kurulum tamam'),
    'message.created',
  );
  ok(`message.created arrived in ${Date.now() - sent} ms`);
  ws.close();

  step('Portal site');
  const site = await api.call('createPortalSite', {
    body: { name: 'Belgeler', slug: 'belgeler', locales: ['tr', 'en'], defaultLocale: 'tr' },
  });
  const token = await api.call('rotatePortalToken', { params: { siteId: site.id } });
  ok(`site ${site.slug} created`);
  console.log(`\nPORTAL_CONTENT_TOKEN=${token.token}`);
  console.log(`OWNER_EMAIL=${EMAIL}`);
  console.log(`OWNER_PASSWORD=${PASSWORD}`);
  console.log('\nAll checks passed.');
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error('\n✗', err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
