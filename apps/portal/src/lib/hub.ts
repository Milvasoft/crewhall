import { ApiErrorBody, endpoints, type Endpoints } from '@crewhall/shared';
import type { z } from 'zod';
import {
  TAG_ALL,
  TAG_BLOG,
  TAG_MEDIA,
  TAG_PATHS,
  TAG_REDIRECTS,
  TAG_SITE,
  pageTag,
  postTag,
  sidebarTag,
} from '@/lib/tags';

/**
 * Typed client for the Hub's public portal content API (`/api/v1/public/portal/*`).
 * Responses are validated with the contract's zod schemas. Every cached fetch is tagged so a
 * publish revalidates only what changed; preview requests bypass the cache.
 */

type PublicName =
  | 'portalPublicSite'
  | 'portalPublicSidebar'
  | 'portalPublicPage'
  | 'portalPublicPaths'
  | 'portalPublicPosts'
  | 'portalPublicPost'
  | 'portalPublicTags'
  | 'portalPublicAuthors'
  | 'portalPublicRedirect'
  | 'portalPublicSearch';

type QueryOf<N extends PublicName> = Endpoints[N] extends { query: infer Q extends z.ZodType }
  ? z.input<Q>
  : undefined;
export type HubResponse<N extends PublicName> = z.infer<Endpoints[N]['response']>;

export type PortalSiteData = HubResponse<'portalPublicSite'>;
export type PortalPageData = HubResponse<'portalPublicPage'>;
export type PortalSidebarData = HubResponse<'portalPublicSidebar'>;
export type PortalPostsData = HubResponse<'portalPublicPosts'>;
export type PortalPostData = HubResponse<'portalPublicPost'>;
export type PortalPathsData = HubResponse<'portalPublicPaths'>;

/** fetch init with Next.js' cache extension (typed here so the client stays framework-light). */
export type HubFetchInit = RequestInit & {
  next?: { tags?: string[]; revalidate?: number | false };
};
export type FetchLike = (input: string, init: HubFetchInit) => Promise<Response>;

export class HubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'HubError';
  }
}

export interface HubClientOptions {
  baseUrl: string;
  token?: string | undefined;
  /** Signed preview token (draft mode): drafts included, nothing cached. */
  previewToken?: string | null | undefined;
  fetch?: FetchLike;
}

export const PREVIEW_HEADER = 'X-Portal-Preview';

/** Stable query string: sorted keys, undefined values left out. */
export function toQueryString(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export function createHubClient(options: HubClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const preview = !!options.previewToken;

  function headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' };
    if (options.token) h.Authorization = `Bearer ${options.token}`;
    if (options.previewToken) h[PREVIEW_HEADER] = options.previewToken;
    return h;
  }

  function init(tags: string[] | null): HubFetchInit {
    if (preview || tags === null) return { headers: headers(), cache: 'no-store' };
    return { headers: headers(), cache: 'force-cache', next: { tags: [TAG_ALL, ...tags] } };
  }

  async function get<N extends PublicName>(
    name: N,
    query: QueryOf<N>,
    tags: string[] | null,
  ): Promise<HubResponse<N> | null> {
    const def = endpoints[name];
    const url = `${baseUrl}${def.path}${toQueryString(query as Record<string, unknown> | undefined)}`;
    let res: Response;
    try {
      res = await doFetch(url, init(tags));
    } catch (err) {
      throw new HubError(`Hub unreachable: ${(err as Error).message}`, 503, 'hub_unreachable');
    }
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      const parsed = ApiErrorBody.safeParse(body);
      const code = parsed.success ? parsed.data.code : `http_${res.status}`;
      if (res.status === 404 && (code === 'not_found' || !parsed.success)) return null;
      throw new HubError(
        parsed.success ? parsed.data.message : `Hub ${name} answered ${res.status}`,
        res.status,
        code,
      );
    }
    const json: unknown = await res.json();
    const result = def.response.safeParse(json);
    if (!result.success) {
      throw new HubError(
        `Hub ${name} response does not match the contract: ${result.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
        502,
        'invalid_response',
      );
    }
    return result.data as HubResponse<N>;
  }

  async function required<N extends PublicName>(
    name: N,
    query: QueryOf<N>,
    tags: string[] | null,
  ): Promise<HubResponse<N>> {
    const data = await get(name, query, tags);
    if (data === null) throw new HubError(`Hub ${name} returned 404`, 404, 'not_found');
    return data;
  }

  return {
    preview,
    site: () => required('portalPublicSite', undefined, [TAG_SITE]),
    sidebar: (version: string, locale: string) =>
      get('portalPublicSidebar', { version, locale }, [sidebarTag(version, locale)]),
    page: (version: string, locale: string, slug: string) =>
      get('portalPublicPage', { version, locale, slug }, [pageTag(version, locale, slug)]),
    paths: () => required('portalPublicPaths', undefined, [TAG_PATHS]),
    posts: (query: QueryOf<'portalPublicPosts'>) =>
      required('portalPublicPosts', query, [TAG_BLOG]),
    post: (locale: string, slug: string) =>
      get('portalPublicPost', { locale, slug }, [TAG_BLOG, postTag(locale, slug)]),
    tags: (locale: string) => required('portalPublicTags', { locale }, [TAG_BLOG]),
    authors: () => required('portalPublicAuthors', undefined, [TAG_BLOG]),
    redirect: (path: string) => get('portalPublicRedirect', { path }, [TAG_REDIRECTS]),
    /** Live query: never cached. */
    search: (query: QueryOf<'portalPublicSearch'>) => required('portalPublicSearch', query, null),
    /** Raw media bytes below /media/ (path without the /media/ prefix). */
    media: (path: string) =>
      doFetch(
        `${baseUrl}/api/v1/public/portal/media/${path
          .split('/')
          .map((p) => encodeURIComponent(p))
          .join('/')}`,
        {
          headers: { ...headers(), Accept: '*/*' },
          ...(preview
            ? { cache: 'no-store' as const }
            : { cache: 'force-cache' as const, next: { tags: [TAG_ALL, TAG_MEDIA] } }),
        },
      ),
  };
}

export type HubClient = ReturnType<typeof createHubClient>;
