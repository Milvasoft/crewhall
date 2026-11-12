/**
 * Phase 1 acceptance against a running stack (docs/contracts/faz-1.md "Bitti"):
 *   a) a 5 GB file uploads in 16 MiB parts, is cut off half way and resumes with getUpload;
 *   b) the same content uploaded twice is stored as one blob with ref_count 2;
 *   c) a link whose server dies turns `down` within 4 minutes;
 *   d) quota numbers move by the logical sizes and come back after cleanup.
 * Everything the run creates is removed at the end (nodes, blobs and objects, uploads,
 * the link and its checks).
 *
 *   pnpm --filter @crewhall/backend accept:phase1 -- --env-file=<api .env>
 *   ACCEPT_API=http://localhost:4100 ACCEPT_EMAIL=… ACCEPT_PASSWORD=… ACCEPT_TOTP=<secret|otpauth>
 *   ACCEPT_SIZE_GB=5 (smaller for a quick run)
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApiClient, type ApiClient } from '@crewhall/api-client';
import {
  blobDerivatives,
  blobs,
  createDb,
  links,
  nodes,
  nodeVersions,
  uploads,
} from '@crewhall/db';
import { UPLOAD_PART_SIZE } from '@crewhall/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { loadEnv } from '../env';
import { createStorage } from '../storage/s3';
import { SEED_PASSWORD, SEED_TOTP_SECRET, SEED_USERS } from './seed-data';
import { totpCode } from './totp';

const API = process.env.ACCEPT_API ?? 'http://localhost:4100';
const EMAIL = process.env.ACCEPT_EMAIL ?? SEED_USERS[0]!.email;
const PASSWORD = process.env.ACCEPT_PASSWORD ?? SEED_PASSWORD;
const TOTP = process.env.ACCEPT_TOTP ?? SEED_TOTP_SECRET;
const SIZE = Math.round(Number(process.env.ACCEPT_SIZE_GB ?? '5') * 1024 ** 3);
const PARALLEL = 4;
const LINK_DEADLINE_MS = 4 * 60_000;

const env = loadEnv();
const { db, close } = createDb(env.DATABASE_URL, { max: 3 });
const storage = createStorage(env);
const results: { name: string; ok: boolean; detail: string }[] = [];
const t0 = Date.now();
const log = (msg: string) =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);
const gib = (n: number) => `${(n / 1024 ** 3).toFixed(3)} GiB`;

function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
}

/** Deterministic content of one part: no 5 GB file on disk, the bytes are made on the fly. */
function partBytes(partNumber: number, total: number) {
  const start = (partNumber - 1) * UPLOAD_PART_SIZE;
  const length = Math.min(UPLOAD_PART_SIZE, total - start);
  const buf = Buffer.alloc(length);
  const seed = createHash('sha256').update(`crewhall-accept-${partNumber}`).digest();
  for (let i = 0; i < length; i += seed.length)
    seed.copy(buf, i, 0, Math.min(seed.length, length - i));
  return buf;
}

async function signIn(): Promise<ApiClient> {
  const origin = env.HUB_URL;
  const res = await fetch(`${API}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = (await res.json()) as { twoFactorRedirect?: boolean };
  let token = res.headers.get('set-auth-token');
  if (body.twoFactorRedirect) {
    const cookies = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const verify = await fetch(`${API}/api/auth/two-factor/verify-totp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie: cookies },
      body: JSON.stringify({ code: await totpCode(TOTP) }),
    });
    if (!verify.ok) throw new Error(`2FA failed: ${verify.status} ${await verify.text()}`);
    token = verify.headers.get('set-auth-token');
  }
  if (!token) throw new Error(`sign-in failed: ${res.status} ${JSON.stringify(body)}`);
  return createApiClient({ baseUrl: API, getToken: () => token, validateResponses: true });
}

async function putParts(
  urls: { partNumber: number; url: string }[],
  total: number,
  signal?: AbortSignal,
) {
  const done: { partNumber: number; etag: string }[] = [];
  const queue = [...urls];
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const res = await fetch(next.url, {
          method: 'PUT',
          body: partBytes(next.partNumber, total),
          signal,
        });
        if (!res.ok) throw new Error(`part ${next.partNumber}: ${res.status}`);
        done.push({ partNumber: next.partNumber, etag: res.headers.get('etag') ?? '' });
      }
    }),
  );
  return done;
}

async function partUrls(api: ApiClient, uploadId: string, numbers: number[]) {
  const out: { partNumber: number; url: string }[] = [];
  for (let i = 0; i < numbers.length; i += 100) {
    const { parts } = await api.call('getUploadPartUrls', {
      params: { uploadId },
      body: { partNumbers: numbers.slice(i, i + 100) },
    });
    out.push(...parts);
  }
  return out;
}

async function waitForBlob(nodeId: string, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await db
      .select({ blob: blobs })
      .from(nodes)
      .innerJoin(nodeVersions, eq(nodeVersions.id, nodes.currentVersionId))
      .innerJoin(blobs, eq(blobs.id, nodeVersions.blobId))
      .where(eq(nodes.id, nodeId));
    if (row && row.blob.status !== 'pending') return row.blob;
    if (Date.now() > until) throw new Error(`blob of ${nodeId} still pending`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const createdNodes: string[] = [];
const blobIds = new Set<string>();
let linkId: string | null = null;
let cardId: string | null = null;

async function main() {
  const api = await signIn();
  const me = await api.call('me');
  if (!me.personalSpaceId) throw new Error('the account has no personal space');
  const spaceId = me.personalSpaceId;
  log(`signed in as ${EMAIL}; personal space ${spaceId}; file size ${gib(SIZE)}`);
  const quota0 = await api.call('getQuota');
  const space0 = await api.call('getSpace', { params: { spaceId } });
  log(`quota before: org used ${gib(quota0.usedBytes)}, space used ${gib(space0.usedBytes)}`);

  const folder = await api.call('createFolder', {
    params: { spaceId },
    body: { name: `Kabul testi ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}` },
  });
  createdNodes.push(folder.id);

  // ---- a) 5 GB, cut off half way, resume ----
  const upload = await api.call('createUpload', {
    body: {
      spaceId,
      parentId: folder.id,
      name: 'büyük-5gb.bin',
      sizeBytes: SIZE,
      mime: 'application/octet-stream',
    },
  });
  log(`upload ${upload.id}: ${upload.partCount} parts of ${upload.partSize / 1024 ** 2} MiB`);
  const all = Array.from({ length: upload.partCount }, (_, i) => i + 1);
  const half = all.slice(0, Math.floor(all.length / 2));
  const stop = new AbortController();
  const firstHalf = putParts(await partUrls(api, upload.id, half), SIZE, stop.signal).catch(
    () => 'cut',
  );
  // Cut the connection somewhere in the first half, with parts in flight.
  const cutAfter = Math.max(1, Math.floor(half.length * 0.8));
  for (;;) {
    const state = await api.call('getUpload', { params: { uploadId: upload.id } });
    if (state.uploadedParts.length >= cutAfter) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop.abort();
  await firstHalf;
  const resumed = await api.call('getUpload', { params: { uploadId: upload.id } });
  const have = new Set(resumed.uploadedParts.map((p) => p.partNumber));
  log(`cut off: the store has ${have.size}/${upload.partCount} parts; resuming the rest`);
  const missing = all.filter((n) => !have.has(n));
  const rest = await putParts(await partUrls(api, upload.id, missing), SIZE);
  const parts = [
    ...resumed.uploadedParts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
    ...rest,
  ];
  const completed = await api.call('completeUpload', {
    params: { uploadId: upload.id },
    body: { parts },
  });
  createdNodes.push(completed.node.id);
  const expected = createHash('sha256');
  for (const n of all) expected.update(partBytes(n, SIZE));
  const expectedSha = expected.digest('hex');
  log('completed; waiting for blob.process to hash it');
  const big = await waitForBlob(completed.node.id, 20 * 60_000);
  blobIds.add(big.id);
  record(
    'a) 5 GB resumable upload',
    completed.node.sizeBytes === SIZE &&
      big.sha256 === expectedSha &&
      have.size > 0 &&
      have.size < upload.partCount,
    `size ${completed.node.sizeBytes}, resumed after ${have.size}/${upload.partCount} parts, sha256 ${big.sha256 === expectedSha ? 'matches' : `differs (${big.sha256})`}`,
  );
  const dl = await api.call('getDownloadUrl', { params: { nodeId: completed.node.id } });
  const tail = await fetch(dl.url, { headers: { range: `bytes=${SIZE - 32}-${SIZE - 1}` } });
  const tailBytes = Buffer.from(await tail.arrayBuffer());
  const lastPart = partBytes(upload.partCount, SIZE);
  record(
    'a) download of the last bytes',
    tailBytes.equals(lastPart.subarray(lastPart.length - 32)),
    `HTTP ${tail.status}, ${tailBytes.length} bytes`,
  );

  // ---- b) dedup ----
  const same = Buffer.alloc(3 * 1024 * 1024, `kabul-${Date.now()}`);
  const dupes = [];
  for (const name of ['aynı-1.bin', 'aynı-2.bin']) {
    const u = await api.call('createUpload', {
      body: { spaceId, parentId: folder.id, name, sizeBytes: same.length },
    });
    const done = await putPartsFrom(api, u.id, same);
    const c = await api.call('completeUpload', {
      params: { uploadId: u.id },
      body: { parts: done },
    });
    createdNodes.push(c.node.id);
    dupes.push(c.node.id);
  }
  for (const id of dupes) blobIds.add((await waitForBlob(id, 120_000)).id);
  const sha = createHash('sha256').update(same).digest('hex');
  const rows = await db.select().from(blobs).where(eq(blobs.sha256, sha));
  record(
    'b) same content stored once',
    rows.length === 1 && rows[0]!.refCount === 2,
    `${rows.length} blob(s) with this sha256, ref_count ${rows.map((r) => r.refCount).join(',')}`,
  );
  for (const r of rows) blobIds.add(r.id);

  // ---- d) quota ----
  const quota1 = await api.call('getQuota');
  const space1 = await api.call('getSpace', { params: { spaceId } });
  const expectedDelta = SIZE + 2 * same.length;
  record(
    'd) quota counts logical bytes',
    space1.usedBytes - space0.usedBytes === expectedDelta &&
      quota1.usedBytes - quota0.usedBytes === expectedDelta,
    `space +${space1.usedBytes - space0.usedBytes}, org +${quota1.usedBytes - quota0.usedBytes} (expected +${expectedDelta}); org used ${gib(quota1.usedBytes)}, quota ${quota1.quotaBytes ?? 'unlimited'}, warning ${quota1.warning}, full ${quota1.full}`,
  );

  // ---- c) link goes down ----
  const server = createServer((_req, res) => res.writeHead(200).end('ok'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
  const surfaces = await api.call('listSurfaces');
  const card = await api.call('createCard', {
    params: { surfaceId: surfaces.items[0]!.id },
    body: { type: 'link', link: { url, title: 'Kabul testi linki', intervalSeconds: 60 } },
  });
  if (card.type !== 'link') throw new Error('unexpected card type');
  cardId = card.id;
  linkId = card.config.item.linkId;
  log(`link ${url}: waiting for the worker to see it up`);
  const upUntil = Date.now() + 3 * 60_000;
  for (;;) {
    const l = await api.call('getLink', { params: { linkId } });
    if (l.health.status === 'up') break;
    if (Date.now() > upUntil) throw new Error('the link never came up; is the worker running?');
    await new Promise((r) => setTimeout(r, 5000));
  }
  server.close();
  server.closeAllConnections();
  const downAt = Date.now();
  log('server stopped; waiting for down');
  let down = false;
  while (Date.now() - downAt < LINK_DEADLINE_MS + 30_000) {
    const l = await api.call('getLink', { params: { linkId } });
    if (l.health.status === 'down') {
      down = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  const took = Date.now() - downAt;
  record(
    'c) dead link turns down within 4 minutes',
    down && took <= LINK_DEADLINE_MS,
    down ? `down after ${(took / 1000).toFixed(0)} s` : 'never went down',
  );
}

async function putPartsFrom(api: ApiClient, uploadId: string, content: Buffer) {
  const [p] = await partUrls(api, uploadId, [1]);
  const res = await fetch(p!.url, { method: 'PUT', body: content });
  return [{ partNumber: 1, etag: res.headers.get('etag') ?? '' }];
}

async function cleanup() {
  log('cleaning up');
  try {
    const api = await signIn();
    if (cardId) await api.call('deleteCard', { params: { cardId } }).catch(() => undefined);
    const roots = createdNodes.slice(0, 1);
    if (roots.length) {
      await api.call('trashNodes', { body: { nodeIds: roots } }).catch(() => undefined);
      await api.call('purgeNodes', { body: { nodeIds: roots } }).catch(() => undefined);
    }
  } catch (err) {
    log(`api cleanup failed: ${(err as Error).message}`);
  }
  if (linkId) await db.delete(links).where(eq(links.id, linkId));
  // Unreferenced blobs would wait a day for trash.purge; remove the test's at once.
  const ids = [...blobIds];
  if (ids.length) {
    const orphaned = await db.select().from(blobs).where(inArray(blobs.id, ids));
    for (const b of orphaned.filter((x) => x.refCount <= 0)) {
      const derivs = await db
        .select()
        .from(blobDerivatives)
        .where(eq(blobDerivatives.blobId, b.id));
      for (const d of derivs) await storage?.delete(d.storageKey).catch(() => undefined);
      await storage?.delete(b.storageKey).catch(() => undefined);
      await db.delete(blobs).where(eq(blobs.id, b.id));
    }
  }
  await db
    .delete(uploads)
    .where(
      sql`${uploads.name} in ('büyük-5gb.bin', 'aynı-1.bin', 'aynı-2.bin') and ${uploads.status} <> 'uploading'`,
    );
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  log(`ERROR ${(err as Error).stack ?? String(err)}`);
} finally {
  await cleanup();
  const quotaAfter = await signIn()
    .then((api) => api.call('getQuota'))
    .catch(() => null);
  if (quotaAfter) log(`quota after cleanup: org used ${gib(quotaAfter.usedBytes)}`);
  await close();
}
console.log('\nSummary');
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name} — ${r.detail}`);
process.exit(failed || results.some((r) => !r.ok) ? 1 : 0);
