import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { idempotencyKeys, users } from '@crewhall/db';
import {
  endpoints,
  type EndpointDef,
  type EndpointName,
  type PathParams,
  type ResponseOf,
} from '@crewhall/shared';
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Deps } from '../deps';
import {
  activeMemberships,
  needsTwoFactorEnrolment,
  resolveActiveOrg,
  toActor,
} from '../services/membership';
import { boundState, HANDOFF_COOKIE, type BoundState } from '../services/oauth-handoff';
import {
  checkIpAllowlist,
  checkOrgRequest,
  checkPublicRequest,
  checkUserRequest,
} from '../services/identity/guard';
import { auditVia } from '../services/audit';
import { recordActivity } from '../services/stats/activity';
import {
  authenticateToken,
  checkTokenSpaces,
  filterTokenItems,
  isTokenRequest,
  tokenModuleCheck,
} from '../services/mcp/rest';
import { deprecationHeaders } from '../services/compat';
import { authenticateIntegration, isIntegrationRequest } from '../services/microsoft/token-auth';
import { clientIp } from './client-ip';
import { AppError, validationError } from './errors';
import type {
  AppEnv,
  AuthSession,
  AuthUser,
  BodyOut,
  OrgCtx,
  PublicCtx,
  QueryOut,
  RequestInfo,
  UserCtx,
} from './types';
import { authenticatePluginToken, isPluginTokenRequest } from '../services/plugins/rest';

/**
 * Binds handlers to the contract table in @crewhall/shared: method, path, body/query
 * validation and response shape all come from `endpoints`, so the server cannot drift
 * from what web and mobile were built against.
 *
 * Three scopes:
 * - public: no session (bootstrap, setup, invitation preview)
 * - user:   a session, no org needed (me, sessions, accepting an invitation)
 * - org:    a session plus an active org membership; the 2FA policy applies here
 */

type Scope = 'public' | 'user' | 'org';
type Handler<C> = (ctx: C) => Promise<unknown>;

interface Mounted {
  scope: Scope;
  status: number;
}

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export function requestInfo(c: Context<AppEnv>): RequestInfo {
  return {
    ip: clientIp(c),
    userAgent: c.req.header('user-agent') ?? null,
    locale: c.req.header('accept-language') ?? null,
  };
}

async function parseInput(c: Context<AppEnv>, def: EndpointDef) {
  let body: unknown = undefined;
  let rawBody = '';
  if (def.body) {
    rawBody = await c.req.text();
    let json: unknown = {};
    if (rawBody) {
      try {
        json = JSON.parse(rawBody);
      } catch {
        throw new AppError('bad_request', { reason: 'invalid_json' });
      }
    }
    const parsed = def.body.safeParse(json);
    if (!parsed.success) throw validationError(parsed.error, 'body');
    body = parsed.data;
  }
  let query: unknown = undefined;
  if (def.query) {
    const parsed = def.query.safeParse(c.req.query());
    if (!parsed.success) throw validationError(parsed.error, 'query');
    query = parsed.data;
  }
  const params = c.req.param() as Record<string, string>;
  for (const [k, v] of Object.entries(params)) {
    if (k.endsWith('Id') && !z.uuid().safeParse(v).success) throw new AppError('not_found');
  }
  return { body, query, params, rawBody };
}

async function getAuth(deps: Deps, c: Context<AppEnv>) {
  const result = await deps.auth.api.getSession({ headers: c.req.raw.headers });
  return result ? { user: result.user as AuthUser, session: result.session as AuthSession } : null;
}

function serialize(deps: Deps, def: EndpointDef, name: string, value: unknown) {
  const parsed = def.response.safeParse(value);
  if (!parsed.success) {
    deps.logger.error({ endpoint: name, issues: parsed.error.issues }, 'response breaks contract');
    throw new AppError('internal');
  }
  return parsed.data;
}

async function withIdempotency(
  deps: Deps,
  c: Context<AppEnv>,
  userId: string,
  rawBody: string,
  run: () => Promise<{ status: number; data: unknown }>,
) {
  const key = c.req.header('idempotency-key');
  if (!key || !WRITE_METHODS.has(c.req.method)) return run();
  if (key.length > 200) throw new AppError('bad_request', { reason: 'idempotency_key_too_long' });

  const path = new URL(c.req.url).pathname;
  const requestHash = createHash('sha256')
    .update(`${c.req.method}\n${path}\n${rawBody}`)
    .digest('hex');
  const where = and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key));

  const [existing] = await deps.db.select().from(idempotencyKeys).where(where);
  if (existing && Date.now() - existing.createdAt.getTime() > IDEMPOTENCY_TTL_MS) {
    await deps.db.delete(idempotencyKeys).where(where);
  } else if (existing) {
    if (existing.requestHash !== requestHash) throw new AppError('idempotency_key_reused');
    // First request still running: the client should retry later.
    if (existing.status === null) throw new AppError('conflict', { reason: 'in_progress' });
    c.header('Idempotent-Replayed', 'true');
    return { status: existing.status, data: existing.response };
  }

  const inserted = await deps.db
    .insert(idempotencyKeys)
    .values({ userId, key, method: c.req.method, path, requestHash })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });
  if (inserted.length === 0) throw new AppError('conflict', { reason: 'in_progress' });

  try {
    const result = await run();
    await deps.db
      .update(idempotencyKeys)
      .set({ status: result.status, response: result.data ?? {} })
      .where(where);
    return result;
  } catch (err) {
    // Failed requests changed nothing; let the retry run for real.
    await deps.db.delete(idempotencyKeys).where(where);
    throw err;
  }
}

export class Router {
  private readonly mounted = new Map<EndpointName, Mounted>();

  constructor(
    private readonly app: Hono<AppEnv>,
    private readonly deps: Deps,
  ) {}

  public<N extends EndpointName>(
    name: N,
    handler: (ctx: PublicCtx<N>) => Promise<ResponseOf<N>>,
    opts: { status?: number } = {},
  ) {
    this.mount(name, 'public', opts.status ?? 200, handler);
  }

  user<N extends EndpointName>(
    name: N,
    handler: (ctx: UserCtx<N>) => Promise<ResponseOf<N>>,
    opts: { status?: number } = {},
  ) {
    this.mount(name, 'user', opts.status ?? 200, handler as Handler<PublicCtx<N>>);
  }

  org<N extends EndpointName>(
    name: N,
    handler: (ctx: OrgCtx<N>) => Promise<ResponseOf<N>>,
    opts: { status?: number } = {},
  ) {
    this.mount(name, 'org', opts.status ?? 200, handler as Handler<PublicCtx<N>>);
  }

  /**
   * Non-JSON route outside the contract table (RAW_PATHS: 302 redirects for browsers)
   * with the same session, org and 2FA checks as org endpoints.
   * `handoff`: an OAuth callback that a link from the app started in the system browser
   * (services/oauth-handoff) runs as that link's person without a session; `handoff` in the
   * handler's context then says where the browser returns.
   */
  rawOrg(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    handler: (ctx: {
      c: Context<AppEnv>;
      deps: Deps;
      org: OrgCtx<never>['org'];
      actor: OrgCtx<never>['actor'];
      user: AuthUser;
      handoff: BoundState | null;
    }) => Promise<Response>,
    opts: { handoff?: 'mail' | 'calendar' } = {},
  ) {
    const deps = this.deps;
    this.app.on(method, path, async (c) => {
      if (opts.handoff) {
        const bound = await boundState(
          deps.db,
          opts.handoff,
          c.req.query('state'),
          getCookie(c, HANDOFF_COOKIE),
        );
        if (bound) {
          // The app's session passed sign-in and 2FA when it asked for the link.
          const active = (await activeMemberships(deps.db, bound.userId)).find(
            (m) => m.org.id === bound.orgId,
          );
          const [user] = await deps.db.select().from(users).where(eq(users.id, bound.userId));
          if (!active || !user) throw new AppError('forbidden');
          await checkIpAllowlist(
            deps.db,
            active.org.id,
            method,
            new URL(c.req.url).pathname,
            clientIp(c),
          );
          deleteCookie(c, HANDOFF_COOKIE, { path: '/api' });
          return handler({
            c,
            deps,
            org: active.org,
            actor: toActor(active.member),
            user,
            handoff: bound,
          });
        }
      }
      const auth = await getAuth(deps, c);
      if (!auth) throw new AppError('unauthenticated');
      const active = await resolveActiveOrg(deps.db, auth.user.id, auth.session);
      if (!active) throw new AppError('forbidden', { reason: 'no_active_org' });
      if (
        await needsTwoFactorEnrolment(
          deps.db,
          active.org,
          active.member,
          auth.user,
          auth.session.id,
        )
      ) {
        throw new AppError('two_factor_required');
      }
      await checkIpAllowlist(
        deps.db,
        active.org.id,
        method,
        new URL(c.req.url).pathname,
        clientIp(c),
      );
      return handler({
        c,
        deps,
        org: active.org,
        actor: toActor(active.member),
        user: auth.user,
        handoff: null,
      });
    });
  }

  rawPublic(
    method:
      | 'GET'
      | 'POST'
      | 'PUT'
      | 'DELETE'
      | 'PATCH'
      | 'OPTIONS'
      // WebDAV (calendar: CalDAV)
      | 'HEAD'
      | 'PROPFIND'
      | 'PROPPATCH'
      | 'REPORT'
      | 'MKCALENDAR'
      | 'MKCOL',
    path: string,
    handler: (ctx: { c: Context<AppEnv>; deps: Deps }) => Promise<Response>,
  ) {
    const deps = this.deps;
    this.app.on(method, path, (c) => handler({ c, deps }));
  }

  /** Answers 501 not_implemented on every contract endpoint without a handler; returns their names. */
  stubMissing(): EndpointName[] {
    const names = this.missing();
    for (const name of names) {
      const def: EndpointDef = endpoints[name];
      this.app.on(def.method, def.path, () => {
        throw new AppError('not_implemented', { endpoint: name });
      });
    }
    return names;
  }

  /** Endpoints of the contract table that have no handler. */
  missing(): EndpointName[] {
    return (Object.keys(endpoints) as EndpointName[]).filter((n) => !this.mounted.has(n));
  }

  private mount<N extends EndpointName>(
    name: N,
    scope: Scope,
    status: number,
    handler: Handler<PublicCtx<N>>,
  ) {
    const def: EndpointDef = endpoints[name];
    if (this.mounted.has(name)) throw new Error(`endpoint ${name} mounted twice`);
    if (def.auth === 'public' && scope !== 'public') throw new Error(`${name} is public`);
    if (def.auth === 'session' && scope === 'public') throw new Error(`${name} needs a session`);
    this.mounted.set(name, { scope, status });
    const deps = this.deps;
    const sunset = def.deprecated ? deprecationHeaders(def.deprecated) : null;

    this.app.on(def.method, def.path, async (c) => {
      if (sunset) for (const [k, v] of Object.entries(sunset)) c.header(k, v);
      const { body, query, params, rawBody } = await parseInput(c, def);
      const base: PublicCtx<N> = {
        deps,
        c,
        req: requestInfo(c),
        params: params as PathParams<N>,
        body: body as BodyOut<N>,
        query: query as QueryOut<N>,
      };

      if (scope === 'public') {
        await checkPublicRequest(deps.db, name);
        const data = serialize(deps, def, name, await handler(base));
        return c.json(data as object, status as 200);
      }

      // Personal access tokens (mhp_…) act as their owner within the token's scopes and
      // spaces (services/mcp/rest.ts); everything else is a better-auth session.
      // Plugin session tokens (EdDSA JWT, our `typ`) act like personal tokens within the
      // installation's permissions (services/plugins/rest.ts); checked before other JWTs.
      const pluginToken = isPluginTokenRequest(c);
      const token = isTokenRequest(c)
        ? await authenticateToken(deps, c, name)
        : pluginToken
          ? await authenticatePluginToken(deps, c, name)
          : null;
      // The Outlook add-in and the Teams app: Crewhall OIDC access tokens (services/microsoft).
      const integration =
        !token && isIntegrationRequest(c) ? await authenticateIntegration(deps, c, name) : null;
      const auth = token
        ? { user: token.user, session: token.session }
        : integration
          ? { user: integration.user, session: integration.session }
          : await getAuth(deps, c);
      if (!auth) throw new AppError('unauthenticated');
      let ctx: UserCtx<N> | OrgCtx<N> = { ...base, ...auth };

      if (scope === 'org') {
        const active = await resolveActiveOrg(deps.db, auth.user.id, auth.session);
        if (!active) throw new AppError('forbidden', { reason: 'no_active_org' });
        if (
          await needsTwoFactorEnrolment(
            deps.db,
            active.org,
            active.member,
            auth.user,
            auth.session.id,
          )
        ) {
          throw new AppError('two_factor_required');
        }
        await checkOrgRequest(deps.db, {
          endpoint: name,
          method: def.method,
          path: def.path,
          org: active.org,
          member: active.member,
          ip: clientIp(c),
        });
        if (token && !pluginToken) tokenModuleCheck(active.org);
        ctx = { ...ctx, org: active.org, member: active.member, actor: toActor(active.member) };
        // Admin statistics (roadmap 21): counted in memory, written in batches.
        recordActivity(deps, {
          orgId: active.org.id,
          userId: auth.user.id,
          endpoint: name,
          method: def.method,
          path: def.path,
          body,
        });
      } else {
        await checkUserRequest(deps.db, {
          endpoint: name,
          method: def.method,
          path: def.path,
          userId: auth.user.id,
          session: auth.session,
          ip: clientIp(c),
        });
      }

      if (token) await checkTokenSpaces(deps.db, token.principal, def, params, body);
      const run = async () => {
        const out = await handler(ctx as PublicCtx<N>);
        return token ? filterTokenItems(deps.db, token.principal, name, out) : out;
      };
      const result = await withIdempotency(deps, c, auth.user.id, rawBody, async () => ({
        status,
        // Audit rows (and chat messages) written for a token say so: via { kind: 'api' }.
        data: serialize(
          deps,
          def,
          name,
          await (token
            ? auditVia.run(token.via, run)
            : integration
              ? auditVia.run(integration.via, run)
              : run()),
        ),
      }));
      return c.json(result.data as object, result.status as 200);
    });
  }
}
