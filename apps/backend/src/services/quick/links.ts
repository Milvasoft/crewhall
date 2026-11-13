import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { linkChecks, linkOpens, links, surfaceCards, type DbOrTx } from '@crewhall/db';
import type { Link, LinkInput } from '@crewhall/shared';
import { outboundFetch } from '../../net/outbound';
import { AppError } from '../../http/errors';
import { normalizeUrl, toLinkHealth, urlHash, type LinkRow } from './link-check';
import { surfaceAccess } from './surfaces';

const META_TIMEOUT_MS = 5000;
const META_MAX_BYTES = 512 * 1024;

export interface SiteMeta {
  title: string | null;
  faviconUrl: string | null;
}

/** SiteMeta plus what a page bookmark shows (wiki): the page's summary and preview image. */
export interface PageMeta extends SiteMeta {
  description: string | null;
  imageUrl: string | null;
}

const TITLE_SEPARATOR = /\s+([·|—–-])\s+/;

/**
 * Site titles often repeat themselves ("GitHub · Change is constant. … · GitHub · GitHub").
 * Split on the usual separators, drop repeated parts and join with the first separator.
 */
export function cleanTitle(raw: string): string | null {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const sep = TITLE_SEPARATOR.exec(text)?.[1];
  if (!sep) return text.slice(0, 200);
  const seen = new Set<string>();
  const parts: string[] = [];
  // split() with a capture group interleaves the separators: keep the even items.
  for (const [i, part] of text.split(TITLE_SEPARATOR).entries()) {
    const p = part.trim();
    const key = p.toLocaleLowerCase('tr');
    if (i % 2 === 1 || !p || seen.has(key)) continue;
    seen.add(key);
    parts.push(p);
  }
  return parts.join(` ${sep} `).slice(0, 200) || null;
}

const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));

async function readText(res: Response) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < META_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => undefined);
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function imageExists(url: string) {
  try {
    const res = await outboundFetch(url, { timeoutMs: 3000, maxBytes: 1024 * 1024 });
    await res.body?.cancel().catch(() => undefined);
    return res.ok && (res.headers.get('content-type') ?? '').startsWith('image/');
  } catch {
    return false;
  }
}

const ATTRIBUTE = /([a-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/** `content` of the first `<meta property|name="…">` among `keys`, in the order of `keys`. */
function metaContent(head: string, keys: string[]): string | null {
  const found = new Map<string, string>();
  for (const tag of head.match(/<meta\s[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    for (const m of tag.matchAll(ATTRIBUTE)) attrs.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? '');
    const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase();
    const content = attrs.get('content');
    if (key && content?.trim() && !found.has(key)) found.set(key, content);
  }
  for (const key of keys) {
    const value = found.get(key);
    if (value) return decodeEntities(value).replace(/\s+/g, ' ').trim();
  }
  return null;
}

/** An http(s) address from a page, resolved against `base`; null for anything else. */
function absoluteHttp(href: string | null, base: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href.slice(0, 2048) : null;
  } catch {
    return null;
  }
}

/** Summary and preview image from a page's `<head>` (Open Graph, Twitter, plain meta). */
export function readPageExtras(html: string, base: string) {
  const head = html.split(/<\/head>/i)[0] ?? html;
  const description = metaContent(head, ['og:description', 'twitter:description', 'description']);
  const image = metaContent(head, [
    'og:image:secure_url',
    'og:image',
    'og:image:url',
    'twitter:image',
  ]);
  return {
    description: description ? description.slice(0, 300) : null,
    imageUrl: absoluteHttp(image, base),
  };
}

/**
 * Title, favicon, summary and preview image of a page, fetched once (design 2.4); nulls when the
 * site does not answer.
 */
export async function fetchSiteMeta(url: string): Promise<PageMeta> {
  let html = '';
  let base: string;
  try {
    // Checked and pinned like every request for a typed address (net/outbound).
    const res = await outboundFetch(url, {
      timeoutMs: META_TIMEOUT_MS,
      headers: { 'user-agent': 'Crewhall/1.0', accept: 'text/html,*/*' },
    });
    base = res.url || url;
    if ((res.headers.get('content-type') ?? '').includes('html')) html = await readText(res);
    else await res.body?.cancel().catch(() => undefined);
  } catch {
    return { title: null, faviconUrl: null, description: null, imageUrl: null };
  }
  const head = html.split(/<\/head>/i)[0] ?? html;
  const ogTitle = /<meta[^>]+property\s*=\s*["']og:title["'][^>]*>/i
    .exec(head)?.[0]
    .match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
  const title = ogTitle || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  let favicon: string | null = null;
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /rel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (href && rel.split(/\s+/).includes('icon')) {
      favicon = new URL(decodeEntities(href), base).href;
      break;
    }
  }
  if (!favicon) {
    const fallback = new URL('/favicon.ico', base).href;
    if (await imageExists(fallback)) favicon = fallback;
  }
  return {
    title: title ? cleanTitle(decodeEntities(title)) : null,
    faviconUrl: favicon && /^https?:/.test(favicon) ? favicon : null,
    ...readPageExtras(html, base),
  };
}

export interface PagePreview {
  /** The address after redirects. */
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  /** https only (clients load it straight from the site). */
  imageUrl: string | null;
}

const ATTR_RE = /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** `<meta property|name="key" content="…">` values of a page head, by lower-cased key. */
function metaTags(head: string) {
  const out = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    for (const m of tag.matchAll(ATTR_RE)) attrs.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? '');
    const key = (attrs.get('property') ?? attrs.get('name'))?.toLowerCase();
    const content = attrs.get('content');
    if (key && content?.trim() && !out.has(key)) out.set(key, content);
  }
  return out;
}

const clip = (s: string | undefined, max: number) => {
  const text = s ? decodeEntities(s).replace(/\s+/g, ' ').trim() : '';
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

/**
 * Open Graph card of a page for chat link previews: the same guarded request as fetchSiteMeta
 * (net/outbound: no private addresses unless PRIVATE_FETCH_ALLOWLIST, time and size limits).
 * Null when the site does not answer with an HTML page.
 */
export async function fetchPagePreview(url: string): Promise<PagePreview | null> {
  let html: string;
  let base: string;
  try {
    const res = await outboundFetch(url, {
      timeoutMs: META_TIMEOUT_MS,
      headers: { 'user-agent': 'Crewhall/1.0 (link preview)', accept: 'text/html,*/*' },
    });
    base = res.url || url;
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('html')) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    html = await readText(res);
  } catch {
    return null;
  }
  const head = html.split(/<\/head>/i)[0] ?? html;
  const meta = metaTags(head);
  const rawTitle =
    meta.get('og:title') ??
    meta.get('twitter:title') ??
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  let imageUrl: string | null = null;
  const image =
    meta.get('og:image:secure_url') ?? meta.get('og:image') ?? meta.get('twitter:image');
  if (image) {
    try {
      const abs = new URL(decodeEntities(image.trim()), base);
      if (abs.protocol === 'https:' && abs.href.length <= 2000) imageUrl = abs.href;
    } catch {
      imageUrl = null;
    }
  }
  return {
    url: base.length <= 2000 ? base : url,
    title: rawTitle ? cleanTitle(decodeEntities(rawTitle)) : null,
    description: clip(meta.get('og:description') ?? meta.get('description'), 400),
    siteName: clip(meta.get('og:site_name'), 100) ?? new URL(base).host.replace(/^www\./, ''),
    imageUrl,
  };
}

/**
 * A card's own icon (LinkItem.iconUrl) must be an https image or a file of this server: plain
 * http only on the server's own origin (Drive files in development). Checks every `iconUrl` in
 * a card body or config.
 */
export function assertIconUrls(hubUrl: string, body: unknown) {
  const own = new URL(hubUrl).origin;
  const walk = (value: unknown, path: (string | number)[]) => {
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...path, i]));
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (k === 'iconUrl' && typeof v === 'string') {
          let url: URL | null;
          try {
            url = new URL(v);
          } catch {
            url = null;
          }
          if (!url || (url.protocol !== 'https:' && url.origin !== own)) {
            throw new AppError('validation_failed', {
              in: 'body',
              issues: [
                { path: [...path, k], code: 'icon_url', message: 'https or this server only' },
              ],
            });
          }
        } else walk(v, [...path, k]);
      }
    }
  };
  walk(body, []);
}

/** The org-wide Link for a URL, created on first use (doc 17 §4: (org_id, url_hash) unique). */
export async function upsertLink(db: DbOrTx, orgId: string, input: LinkInput, meta?: SiteMeta) {
  let url: string;
  try {
    url = normalizeUrl(input.url);
  } catch {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: [{ path: ['url'], code: 'invalid_url', message: 'invalid URL' }],
    });
  }
  const hash = urlHash(url);
  const [existing] = await db
    .select()
    .from(links)
    .where(and(eq(links.orgId, orgId), eq(links.urlHash, hash)));
  if (existing) return existing;
  const site = meta ?? (await fetchSiteMeta(url));
  const [row] = await db
    .insert(links)
    .values({
      orgId,
      url,
      urlHash: hash,
      host: new URL(url).host,
      siteTitle: site.title,
      faviconUrl: site.faviconUrl,
      checkEnabled: input.checkEnabled,
      intervalSeconds: input.intervalSeconds,
      nextCheckAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [raced] = await db
    .select()
    .from(links)
    .where(and(eq(links.orgId, orgId), eq(links.urlHash, hash)));
  return raced!;
}

export async function opensFor(db: DbOrTx, ids: string[]) {
  if (ids.length === 0) return new Map<string, number>();
  const rows = await db
    .select({ linkId: linkOpens.linkId, n: sql<number>`count(*)::int` })
    .from(linkOpens)
    .where(and(inArray(linkOpens.linkId, ids), gt(linkOpens.at, sql`now() - interval '30 days'`)))
    .groupBy(linkOpens.linkId);
  return new Map(rows.map((r) => [r.linkId, r.n]));
}

export function toLink(row: LinkRow, opens30d: number): Link {
  return {
    id: row.id,
    url: row.url,
    host: row.host,
    siteTitle: row.siteTitle,
    faviconUrl: row.faviconUrl,
    checkEnabled: row.checkEnabled,
    intervalSeconds: row.intervalSeconds as 60 | 300 | 900,
    health: toLinkHealth(row),
    opens30d,
  };
}

export async function linksByIds(db: DbOrTx, orgId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, Link>();
  const rows = await db
    .select()
    .from(links)
    .where(and(eq(links.orgId, orgId), inArray(links.id, ids)));
  const opens = await opensFor(db, ids);
  return new Map(rows.map((r) => [r.id, toLink(r, opens.get(r.id) ?? 0)]));
}

export async function linkRow(db: DbOrTx, orgId: string, linkId: string) {
  const [row] = await db
    .select()
    .from(links)
    .where(and(eq(links.orgId, orgId), eq(links.id, linkId)));
  if (!row) throw new AppError('not_found');
  return row;
}

export async function linkHistory(db: DbOrTx, linkId: string, hours: number) {
  const rows = await db
    .select()
    .from(linkChecks)
    .where(
      and(
        eq(linkChecks.linkId, linkId),
        gt(linkChecks.at, sql`now() - make_interval(hours => ${hours})`),
      ),
    )
    .orderBy(linkChecks.at);
  const reachable = rows.filter((r) => r.status !== 'down').length;
  return {
    items: rows.map((r) => ({
      at: r.at.toISOString(),
      status: r.status,
      httpStatus: r.httpStatus,
      latencyMs: r.latencyMs,
      error: r.error,
    })),
    availability: rows.length ? reachable / rows.length : null,
  };
}

export async function updateLinkSettings(
  db: DbOrTx,
  orgId: string,
  linkId: string,
  input: { checkEnabled?: boolean | undefined; intervalSeconds?: 60 | 300 | 900 | undefined },
) {
  const patch: Partial<LinkRow> = {};
  if (input.checkEnabled !== undefined) patch.checkEnabled = input.checkEnabled;
  if (input.intervalSeconds !== undefined) patch.intervalSeconds = input.intervalSeconds;
  if (input.checkEnabled) patch.nextCheckAt = new Date();
  if (Object.keys(patch).length) {
    await db
      .update(links)
      .set(patch)
      .where(and(eq(links.id, linkId), eq(links.orgId, orgId)));
  }
}

/** Cards the caller can see that already show this URL (design 02: duplicate warning). */
export async function existingCardIds(
  db: DbOrTx,
  a: { org: { id: string }; userId: string } & Parameters<typeof surfaceAccess>[1],
  url: string,
) {
  const [link] = await db
    .select({ id: links.id })
    .from(links)
    .where(and(eq(links.orgId, a.org.id), eq(links.urlHash, urlHash(normalizeUrl(url)))));
  if (!link) return [];
  const cards = await db
    .select({ id: surfaceCards.id, surfaceId: surfaceCards.surfaceId })
    .from(surfaceCards)
    .where(
      and(
        eq(surfaceCards.orgId, a.org.id),
        isNull(surfaceCards.deletedAt),
        sql`jsonb_path_exists(${surfaceCards.config}, '$.**.linkId ? (@ == $id)', jsonb_build_object('id', ${link.id}::text))`,
      ),
    );
  const out: string[] = [];
  for (const c of cards) {
    if (await surfaceAccess(db, a, c.surfaceId).catch(() => null)) out.push(c.id);
  }
  return out;
}
