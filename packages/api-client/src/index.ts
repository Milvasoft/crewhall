import {
  ApiErrorBody,
  endpoints,
  type BodyOf,
  type EndpointName,
  type ErrorCode,
  type PathParams,
  type QueryOf,
  type ResponseOf,
} from '@crewhall/shared';

/**
 * Typed client for the /api/v1 contract in @crewhall/shared.
 * Web passes `credentials: 'include'` (httpOnly session cookie);
 * mobile passes `getToken` (bearer session token from SecureStore).
 */
export interface ApiClientOptions {
  baseUrl: string;
  getToken?: () => string | null | Promise<string | null>;
  credentials?: RequestInit['credentials'];
  fetch?: typeof fetch;
  /** Validate responses against the schema (enable in dev and tests). */
  validateResponses?: boolean;
  locale?: () => string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Args<N extends EndpointName> = ([keyof PathParams<N>] extends [never]
  ? { params?: undefined }
  : { params: PathParams<N> }) &
  ([BodyOf<N>] extends [never] ? { body?: undefined } : { body: BodyOf<N> }) &
  ([QueryOf<N>] extends [never] ? { query?: undefined } : { query?: QueryOf<N> }) & {
    idempotencyKey?: string;
    signal?: AbortSignal;
  };

export function buildPath(path: string, params?: Record<string, string>): string {
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params?.[name];
    if (value === undefined) throw new Error(`Missing path param "${name}" for ${path}`);
    return encodeURIComponent(value);
  });
}

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetch ?? fetch;

  async function call<N extends EndpointName>(
    name: N,
    ...[args]: OptionalIfEmpty<Args<N>>
  ): Promise<ResponseOf<N>> {
    const def = endpoints[name];
    const a = (args ?? {}) as Args<N>;
    const url = new URL(
      buildPath(def.path, a.params as Record<string, string> | undefined),
      options.baseUrl,
    );
    if (a.query) {
      for (const [k, v] of Object.entries(a.query as Record<string, unknown>)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (a.body !== undefined) headers['Content-Type'] = 'application/json';
    if (a.idempotencyKey) headers['Idempotency-Key'] = a.idempotencyKey;
    const locale = options.locale?.();
    if (locale) headers['Accept-Language'] = locale;
    const token = await options.getToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await doFetch(url, {
      method: def.method,
      headers,
      body: a.body !== undefined ? JSON.stringify(a.body) : undefined,
      credentials: options.credentials,
      signal: a.signal,
    });

    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const parsed = ApiErrorBody.safeParse(json);
      if (parsed.success)
        throw new ApiError(res.status, parsed.data.code, parsed.data.message, parsed.data.details);
      throw new ApiError(res.status, 'internal', `HTTP ${res.status}`);
    }
    return (options.validateResponses ? def.response.parse(json) : json) as ResponseOf<N>;
  }

  return { call };
}

type OptionalIfEmpty<A> = {} extends A ? [args?: A] : [args: A];

export type ApiClient = ReturnType<typeof createApiClient>;

/** TanStack Query keys, shared by web and mobile so invalidation matches. */
export const queryKeys = {
  bootstrap: ['bootstrap'] as const,
  me: ['me'] as const,
  sessions: ['me', 'sessions'] as const,
  org: ['org'] as const,
  theme: ['org', 'theme'] as const,
  members: (filters?: object) => ['org', 'members', filters ?? {}] as const,
  invitations: ['org', 'invitations'] as const,
  spaces: (filters?: object) => ['spaces', filters ?? {}] as const,
  space: (spaceId: string) => ['spaces', spaceId] as const,
  spaceMembers: (spaceId: string) => ['spaces', spaceId, 'members'] as const,
  orgSpaces: (filters?: object) => ['org', 'spaces', filters ?? {}] as const,
  // Phase 1 · Drive
  nodes: (spaceId: string, filters?: object) => ['nodes', spaceId, filters ?? {}] as const,
  node: (nodeId: string) => ['node', nodeId] as const,
  versions: (nodeId: string) => ['node', nodeId, 'versions'] as const,
  shares: (nodeId: string) => ['node', nodeId, 'shares'] as const,
  trash: (spaceId: string) => ['nodes', spaceId, 'trash'] as const,
  upload: (uploadId: string) => ['uploads', uploadId] as const,
  favorites: ['me', 'favorites'] as const,
  recent: ['me', 'recent'] as const,
  searchNodes: (filters: object) => ['search', 'nodes', filters] as const,
  quota: ['org', 'quota'] as const,
  publicShare: (token: string) => ['public', 'shares', token] as const,
  // Phase 1 · Quick access
  surfaces: ['surfaces'] as const,
  surface: (surfaceId: string) => ['surfaces', surfaceId] as const,
  link: (linkId: string) => ['links', linkId] as const,
  linkHistory: (linkId: string) => ['links', linkId, 'checks'] as const,
};
