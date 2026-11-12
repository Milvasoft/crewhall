import { and, eq, or, sql } from 'drizzle-orm';
import { chatGifSettings, type DbOrTx } from '@crewhall/db';
import {
  GIF_BUDGET,
  isGiphyMediaUrl,
  type GifPage,
  type GifResult,
  type GifSettings,
  type GifTestResult,
  type MessageGif,
  type UpdateGifSettings,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { outboundFetch } from '../../net/outbound';
import { decryptApiKey, encryptApiKey, keyHint } from '../ai/crypto';
import { audit } from '../audit';
import { take } from '../mcp/rate-limit';

/**
 * GIFs in chat through GIPHY, with the org's own key (Yönetim › Entegrasyonlar › GIF).
 * Browsers never call GIPHY: the server asks api.giphy.com with the key, the rating and the
 * language and returns a small list. Images then load from GIPHY's CDN (media*.giphy.com);
 * nothing is downloaded or stored. Calls are kept few (beta keys allow ~100 an hour):
 * - results (only them, no media) are shared per org: trending 12 minutes, searches an hour;
 * - identical requests arriving together share one GIPHY call;
 * - a beta key has an hourly budget per org; when it is spent the answer is 429 gif_busy
 *   without calling GIPHY. Cache hits cost nothing.
 */

type Row = typeof chatGifSettings.$inferSelect;

/** Searches and trending per person per minute (the picker scrolls in pages). */
const REQUESTS_PER_MINUTE = 60;
const CACHE_MS = { trending: 12 * 60_000, search: 60 * 60_000 } as const;
const CACHE_MAX = 1000;

async function load(db: DbOrTx, orgId: string): Promise<Row | null> {
  const [row] = await db.select().from(chatGifSettings).where(eq(chatGifSettings.orgId, orgId));
  return row ?? null;
}

const apiKeyOf = (env: Env, row: Row | null) =>
  row?.apiKeyEnc ? decryptApiKey(env.AUTH_SECRET, row.orgId, row.apiKeyEnc) : null;

const isActive = (row: Row | null) => Boolean(row?.enabled && row.apiKeyEnc);

/** Bootstrap: list the chat.gif capability only for an org with GIFs on. */
export async function gifActive(db: DbOrTx, orgId: string) {
  return isActive(await load(db, orgId));
}

function toSettings(row: Row | null): GifSettings {
  return {
    enabled: row?.enabled ?? false,
    apiKey: {
      set: Boolean(row?.apiKeyEnc),
      hint: row?.apiKeyHint ?? null,
      updatedAt: row?.apiKeyUpdatedAt?.toISOString() ?? null,
    },
    rating: row?.rating ?? 'g',
    lang: row?.lang ?? 'tr',
    active: isActive(row),
    keyTier: row?.keyTier ?? 'beta',
    usage: {
      used:
        row?.usageHour && row.usageHour.getTime() === hourStart().getTime() ? row.usageCount : 0,
      limit: budgetOf(row),
      resetsAt: new Date(hourStart().getTime() + 3_600_000).toISOString(),
    },
  };
}

const hourStart = (now = new Date()) => new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);

/** GIPHY calls per hour for the org; null: no limit (production key). */
const budgetOf = (row: Row | null) =>
  (row?.keyTier ?? 'beta') === 'beta' ? GIF_BUDGET.beta : null;

/**
 * Counts one GIPHY call against the org's hourly budget (one statement, so concurrent calls
 * cannot overspend). Throws 429 gif_busy when the budget is spent.
 */
async function spend(db: DbOrTx, row: Row) {
  const budget = budgetOf(row);
  const hour = sql`date_trunc('hour', now())`;
  const done = await db
    .update(chatGifSettings)
    .set({
      usageHour: sql`${hour}`,
      usageCount: sql`case when ${chatGifSettings.usageHour} = ${hour} then ${chatGifSettings.usageCount} + 1 else 1 end`,
    })
    .where(
      and(
        eq(chatGifSettings.orgId, row.orgId),
        budget === null
          ? undefined
          : or(
              sql`${chatGifSettings.usageHour} is distinct from ${hour}`,
              sql`${chatGifSettings.usageCount} < ${budget}`,
            ),
      ),
    )
    .returning({ count: chatGifSettings.usageCount });
  if (done.length === 0) {
    const retryAfter = Math.max(
      1,
      Math.ceil((hourStart().getTime() + 3_600_000 - Date.now()) / 1000),
    );
    throw new AppError('gif_busy', { retryAfter });
  }
}

export async function getGifSettings(db: DbOrTx, orgId: string) {
  return toSettings(await load(db, orgId));
}

export async function updateGifSettings(
  deps: Pick<Deps, 'db' | 'env'>,
  a: { orgId: string; userId: string },
  input: UpdateGifSettings,
  req?: Pick<RequestInfo, 'ip' | 'userAgent'>,
) {
  const { db, env } = deps;
  const now = new Date();
  const patch: Partial<typeof chatGifSettings.$inferInsert> = {};
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.rating !== undefined) patch.rating = input.rating;
  if (input.lang !== undefined) patch.lang = input.lang;
  if (input.apiKey !== undefined) {
    patch.apiKeyEnc = input.apiKey ? encryptApiKey(env.AUTH_SECRET, a.orgId, input.apiKey) : null;
    patch.apiKeyHint = input.apiKey ? keyHint(input.apiKey) : null;
    patch.apiKeyUpdatedAt = input.apiKey ? now : null;
  }
  if (input.keyTier !== undefined) patch.keyTier = input.keyTier;
  const changed = Object.keys(input);
  if (changed.length) {
    await db
      .insert(chatGifSettings)
      .values({ orgId: a.orgId, ...patch, updatedBy: a.userId })
      .onConflictDoUpdate({
        target: chatGifSettings.orgId,
        set: { ...patch, updatedBy: a.userId, updatedAt: now },
      });
    cache.clear();
    await audit(
      db,
      {
        orgId: a.orgId,
        actorId: a.userId,
        action: 'org.gif.update',
        targetType: 'org',
        targetId: a.orgId,
        // Field names only; the key never reaches the log.
        meta: { changed },
      },
      req,
    );
  }
  return getGifSettings(db, a.orgId);
}

// ---- GIPHY --------------------------------------------------------------------------

interface GiphyImage {
  url?: string;
  width?: string;
  height?: string;
}
interface GiphyItem {
  id?: string;
  title?: string;
  images?: Record<string, GiphyImage | undefined>;
}
interface GiphyResponse {
  data?: GiphyItem[];
  pagination?: { total_count?: number; count?: number; offset?: number };
}

const num = (v: string | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/** GIPHY's item → what clients need; anything not on GIPHY's media CDN is dropped. */
function toResult(item: GiphyItem): GifResult | null {
  const img = item.images ?? {};
  const preview = img.fixed_width ?? img.fixed_width_downsampled ?? img.preview_gif;
  const full = img.downsized ?? img.original;
  const still = img.fixed_width_still ?? img.original_still;
  if (!item.id || !preview?.url || !full?.url) return null;
  if (!isGiphyMediaUrl(preview.url) || !isGiphyMediaUrl(full.url)) return null;
  const width = num(full.width);
  const height = num(full.height);
  if (!width || !height) return null;
  return {
    id: item.id,
    title: (item.title ?? '').slice(0, 200),
    previewUrl: preview.url,
    previewWidth: num(preview.width) || width,
    previewHeight: num(preview.height) || height,
    url: full.url,
    width,
    height,
    stillUrl: still?.url && isGiphyMediaUrl(still.url) ? still.url : null,
  };
}

/** Shared results per org (search results only, never media). */
const cache = new Map<string, { at: number; page: GifPage }>();
/** GIPHY calls in progress: identical requests arriving together share one. */
const inflight = new Map<string, Promise<GifPage>>();

async function giphy(
  deps: Pick<Deps, 'db' | 'env'>,
  row: Row,
  path: 'trending' | 'search',
  params: Record<string, string | number>,
  opts: { fresh?: boolean } = {},
): Promise<GifPage> {
  const cacheKey = `${row.orgId}:${path}:${row.rating}:${row.lang}:${JSON.stringify(params)}`;
  if (!opts.fresh) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS[path]) return hit.page;
    const running = inflight.get(cacheKey);
    if (running) return running;
  }
  const call = fetchGiphy(deps, row, path, params).then((page) => {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, { at: Date.now(), page });
    return page;
  });
  if (!opts.fresh) {
    inflight.set(cacheKey, call);
    void call.catch(() => undefined).finally(() => inflight.delete(cacheKey));
  }
  return call;
}

async function fetchGiphy(
  deps: Pick<Deps, 'db' | 'env'>,
  row: Row,
  path: 'trending' | 'search',
  params: Record<string, string | number>,
): Promise<GifPage> {
  const key = apiKeyOf(deps.env, row);
  if (!key) throw new AppError('gif_disabled');
  await spend(deps.db, row);
  const url = new URL(`/v1/gifs/${path}`, deps.env.GIPHY_API_URL);
  url.searchParams.set('api_key', key);
  url.searchParams.set('rating', row.rating);
  if (path === 'search') url.searchParams.set('lang', row.lang);
  url.searchParams.set('bundle', 'messaging_non_clips');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await outboundFetch(url, { timeoutMs: 8000, maxBytes: 2 * 1024 * 1024 });
  } catch {
    throw new AppError('gif_provider_error', { reason: 'network' });
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    // GIPHY's own quota: the same "busy" answer as our budget.
    if (res.status === 429) throw new AppError('gif_busy', { reason: 'provider' });
    throw new AppError('gif_provider_error', { status: res.status });
  }
  const body = (await res.json().catch(() => ({}))) as GiphyResponse;
  const items = (body.data ?? []).map(toResult).filter((x): x is GifResult => x !== null);
  const offset = Number(params.offset ?? 0);
  const limit = Number(params.limit ?? items.length);
  const total = body.pagination?.total_count ?? 0;
  const got = body.data?.length ?? 0;
  const next = offset + got;
  return { items, nextOffset: got >= limit && next < total ? next : null };
}

async function activeRow(db: DbOrTx, orgId: string) {
  const row = await load(db, orgId);
  if (!row || !isActive(row)) throw new AppError('gif_disabled');
  return row;
}

async function limit(db: DbOrTx, orgId: string, userId: string) {
  const r = await take(
    db,
    `user:${userId}`,
    { kind: 'gif', perMinute: REQUESTS_PER_MINUTE },
    orgId,
  );
  if (!r.allowed) throw new AppError('rate_limited', { retryAfter: r.retryAfter });
}

export async function trendingGifs(
  deps: Pick<Deps, 'db' | 'env'>,
  a: { orgId: string; userId: string },
  q: { offset: number; limit: number },
) {
  const row = await activeRow(deps.db, a.orgId);
  await limit(deps.db, a.orgId, a.userId);
  return giphy(deps, row, 'trending', { offset: q.offset, limit: q.limit });
}

export async function searchGifs(
  deps: Pick<Deps, 'db' | 'env'>,
  a: { orgId: string; userId: string },
  q: { q: string; offset: number; limit: number },
) {
  const row = await activeRow(deps.db, a.orgId);
  await limit(deps.db, a.orgId, a.userId);
  // Case does not change GIPHY's answer: one cache entry for "Kedi" and "kedi".
  const term = q.q.toLocaleLowerCase('tr');
  return giphy(deps, row, 'search', { q: term, offset: q.offset, limit: q.limit });
}

/** "Test" on the settings card: one trending request with the stored key. */
export async function testGifSettings(
  deps: Pick<Deps, 'db' | 'env'>,
  orgId: string,
): Promise<GifTestResult> {
  const row = await load(deps.db, orgId);
  if (!row?.apiKeyEnc) return { ok: false, count: 0, error: 'no_key' };
  try {
    // Always a real call (it checks the key), counted against the budget like any other.
    const page = await giphy(deps, row, 'trending', { offset: 0, limit: 5 }, { fresh: true });
    return { ok: true, count: page.items.length, error: null };
  } catch (err) {
    const details =
      err instanceof AppError ? (err.details as { status?: number; reason?: string }) : {};
    const code = err instanceof AppError ? err.code : 'error';
    const error = details?.status
      ? String(details.status)
      : code === 'gif_busy'
        ? code
        : (details?.reason ?? 'error');
    return { ok: false, count: 0, error };
  }
}

/** A GIF in a message: GIFs on for the org and the image on GIPHY's media CDN. */
export async function checkMessageGif(db: DbOrTx, orgId: string, gif: MessageGif) {
  if (!(await gifActive(db, orgId))) throw new AppError('gif_disabled');
  if (!isGiphyMediaUrl(gif.url) || (gif.previewUrl && !isGiphyMediaUrl(gif.previewUrl))) {
    throw new AppError('invalid_target', { reason: 'gif_url' });
  }
}

/** Tests: forget cached results between cases. */
export function clearGifCache() {
  cache.clear();
  inflight.clear();
}
