import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { Deps } from './deps';
import { DEMO_BLOCKED_AUTH_PATHS, isDemoMode } from './services/demo-flag';
import { clientIp } from './http/client-ip';
import { AppError, errorBody } from './http/errors';
import { Router } from './http/route';
import type { AppEnv } from './http/types';
import { registerDrive } from './routes/drive';
import { registerQuick } from './routes/quick';
import { registerPortal } from './routes/portal';
import { registerMcp } from './routes/mcp';
import { registerChat } from './routes/chat';
import { registerAnnouncements } from './routes/announcements';
import { registerVault } from './routes/vault';
import { registerStats } from './routes/stats';
import { registerWiki } from './routes/wiki';
import { registerTemplates } from './routes/templates';
import { pageNotifier, setPageNotifier } from './services/wiki/notify';
import { registerMeet } from './routes/meet';
import { registerBoards } from './routes/boards';
import { registerIdentity } from './routes/identity';
import { registerForms } from './routes/forms';
import { registerCalendar } from './routes/calendar';
import { registerContacts } from './routes/contacts';
import { registerAutomations } from './routes/automations';
import { registerTables } from './routes/tables';
import { registerAi } from './routes/ai';
import { registerDelivery } from './routes/delivery';
import { registerAssets } from './routes/assets';
import { registerMail } from './routes/mail';
import { registerMailInbox } from './routes/mail-inbox';
import { registerDesktop } from './routes/desktop';
import { registerOAuthHandoff } from './routes/oauth-handoff';
import { registerMicrosoft } from './routes/microsoft';
import { registerV1 } from './routes/v1';
import { registerFederation } from './routes/federation';
import { registerPlugins } from './routes/plugins';
import { registerWebdav } from './services/drive/webdav/handler';
import { registerOffice } from './routes/office';
import { registerWopi } from './services/office/wopi';
import { registerOnlyoffice } from './services/office/onlyoffice';
import { primaryOrg } from './services/brand';
import { currentTheme, themeCss } from './services/org';
import { buildWebManifest } from './services/web-manifest';
import {
  BROWSER_EXTENSION_IDS,
  CLIENT_HEADER,
  DEFAULT_THEME,
  endpoints,
  paths,
} from '@crewhall/shared';
import { resolveLocale, type AppLocale } from '@crewhall/i18n';
import { buildOpenApi } from './services/openapi';
import { checkClient } from './services/compat';

/** What an outdated app may still call: bootstrap and getCompat (auth is matched by prefix). */
const COMPAT_EXEMPT = new Set<string>([endpoints.bootstrap.path, endpoints.getCompat.path]);

export function createApp(deps: Deps) {
  const { env, logger } = deps;
  const app = new Hono<AppEnv>();
  const origins = [
    ...[env.HUB_URL, ...env.WEB_ORIGINS].map((o) => new URL(o).origin),
    // The listed browser extension, so it keeps working after its site permissions change.
    ...BROWSER_EXTENSION_IDS.map((id) => `chrome-extension://${id}`),
  ];

  app.use('*', async (c, next) => {
    const traceId = trace.getActiveSpan()?.spanContext().traceId;
    const requestId = c.req.header('x-request-id') ?? traceId ?? randomUUID();
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    const started = performance.now();
    await next();
    const path = new URL(c.req.url).pathname;
    if (path === '/healthz' || path === '/readyz') return;
    logger.info(
      {
        requestId,
        method: c.req.method,
        path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      },
      'request',
    );
  });

  app.use('*', secureHeaders({ crossOriginResourcePolicy: false }));

  // Web in dev runs on another port; in production Caddy serves both on one origin.
  app.use(
    '/api/*',
    cors({
      // The OIDC provider's token, userinfo and JWKS endpoints answer SPA clients on any
      // origin with bearer tokens only (identity module).
      origin: (origin, c) =>
        c.req.path.startsWith('/api/oidc/') ? '*' : origins.includes(origin) ? origin : null,
      credentials: true,
      allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'Authorization',
        'Idempotency-Key',
        'Accept-Language',
        'X-Request-Id',
        'expo-origin',
        'x-skip-oauth-proxy',
        CLIENT_HEADER,
      ],
      exposeHeaders: [
        'set-auth-token',
        'X-Request-Id',
        'Idempotent-Replayed',
        'Deprecation',
        'Sunset',
      ],
      maxAge: 600,
    }),
  );

  // Apps older than this server accepts (X-Crewhall-Client, shared compat.ts) get 426 on
  // everything but the calls they need to show the update prompt and sign in.
  app.use('/api/*', async (c, next) => {
    const path = c.req.path;
    if (!COMPAT_EXEMPT.has(path) && !path.startsWith('/api/auth/')) {
      const check = checkClient(env, c.req.header(CLIENT_HEADER));
      if (check?.status === 'outdated') {
        throw new AppError('client_outdated', {
          platform: check.platform,
          min: check.min,
          current: check.current,
          ...(check.storeUrl ? { storeUrl: check.storeUrl } : {}),
        });
      }
    }
    await next();
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // Invitation links in mail sent before the English paths (docs/contracts/ingilizce-url.md):
  // the proxy's /dav prefix sends /davet/… here; the web app now answers on /invite/….
  app.get('/davet/:token', (c) => {
    const url = new URL(c.req.url);
    return c.redirect(`${paths.invite(c.req.param('token'))}${url.search}`, 301);
  });
  app.get('/readyz', async (c) => {
    try {
      await deps.db.execute(sql`select 1`);
      return c.json({ status: 'ready' });
    } catch (err) {
      logger.warn({ err }, 'readiness check failed');
      return c.json({ status: 'unavailable' }, 503);
    }
  });

  // better-auth: sign-in/up, 2FA, passkey, sessions, password reset, e-mail verification.
  app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
    // Live demo: the shared sample accounts keep their password, e-mail and second factor.
    if (isDemoMode() && DEMO_BLOCKED_AUTH_PATHS.some((p) => c.req.path.startsWith(p))) {
      return c.json({ code: 'forbidden', message: 'Demo hesaplarında bu işlem kapalı.' }, 403);
    }
    // better-auth reads the client IP from headers (lockout, rate limit, session IP);
    // without a proxy in front, pass the socket address the same way.
    const ip = clientIp(c);
    let request = c.req.raw;
    if (ip && !c.req.header('x-forwarded-for')) {
      const headers = new Headers(c.req.raw.headers);
      headers.set('x-forwarded-for', ip);
      const init: RequestInit & { duplex?: 'half' } = { headers, duplex: 'half' };
      request = new Request(c.req.raw, init);
    }
    return withLockStatus(await deps.auth.handler(request));
  });

  app.get('/api/theme.css', async (c) => {
    const org = await primaryOrg(deps.db);
    const theme = org ? await currentTheme(deps.db, org.id) : DEFAULT_THEME;
    const etag = `"theme-${org?.id ?? 'default'}-${theme.version}"`;
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    c.header('ETag', etag);
    c.header('Cache-Control', 'public, max-age=60');
    c.header('Content-Type', 'text/css; charset=utf-8');
    return c.body(themeCss(theme));
  });

  // Installed web app (PWA): the org's name, mark and theme.
  app.get('/api/manifest.webmanifest', async (c) => {
    const org = await primaryOrg(deps.db);
    const theme = org ? await currentTheme(deps.db, org.id) : DEFAULT_THEME;
    c.header('Cache-Control', 'public, max-age=300');
    c.header('Content-Type', 'application/manifest+json; charset=utf-8');
    return c.body(JSON.stringify(buildWebManifest(org?.branding, theme)));
  });

  // Open API document (design 18.4): generated from the contract once per language.
  const openApi = new Map<AppLocale, string>();
  app.get('/api/openapi.json', (c) => {
    const locale = resolveLocale(c.req.query('lang') ?? c.req.header('accept-language'));
    let doc = openApi.get(locale);
    if (!doc) {
      doc = JSON.stringify(buildOpenApi({ serverUrl: new URL(env.API_URL).origin, locale }));
      openApi.set(locale, doc);
    }
    c.header('Cache-Control', 'public, max-age=300');
    c.header('Vary', 'Accept-Language');
    c.header('Content-Type', 'application/json; charset=utf-8');
    return c.body(doc);
  });
  // The reference itself is a web screen (Hesabım › MCP ve API › REST API).
  app.get('/api/docs', (c) =>
    c.redirect(`${new URL(env.HUB_URL).origin}${paths.accountMcpApi()}`, 302),
  );

  const router = new Router(app, deps);
  registerV1(router);
  registerAssets(router);
  registerDrive(router);
  registerQuick(router);
  registerPortal(router);
  registerMcp(router);
  registerChat(router);
  registerAnnouncements(router);
  registerVault(router);
  registerWiki(router);
  registerTemplates(router);
  setPageNotifier(pageNotifier(deps));
  registerMeet(router);
  registerBoards(router);
  registerIdentity(router);
  registerFederation(router);
  registerPlugins(router);
  registerForms(router);
  registerCalendar(router);
  registerContacts(router);
  registerAutomations(router);
  registerTables(router);
  registerAi(router);
  registerOffice(router);
  registerDelivery(router);
  // WebDAV (roadmap 9): Drive in Finder, Windows Explorer and rclone; personal token auth.
  registerWebdav(app, deps);
  // WOPI host (office module): the document server reads and saves files here.
  registerWopi(app, deps);
  registerOnlyoffice(app, deps);
  registerStats(router);
  registerMail(router);
  registerMailInbox(router);
  registerDesktop(router);
  registerOAuthHandoff(router);
  registerMicrosoft(router);
  // Contract entries written ahead of their implementation answer 501 not_implemented,
  // so clients built against a newer contract keep working against this server.
  const missing = router.stubMissing();
  if (missing.length) logger.warn({ endpoints: missing }, 'endpoints not implemented yet');

  app.notFound((c) => {
    const err = new AppError('not_found');
    return c.json(errorBody(err, c.req.header('accept-language')), 404);
  });

  app.onError((err, c) => {
    const lang = c.req.header('accept-language');
    if (err instanceof AppError) {
      if (err.status >= 500) logger.error({ err, requestId: c.get('requestId') }, 'request failed');
      return c.json(errorBody(err, lang), err.status as 400);
    }
    if (err instanceof HTTPException) {
      const code =
        err.status === 401 ? 'unauthenticated' : err.status === 404 ? 'not_found' : 'bad_request';
      return c.json(errorBody(new AppError(code), lang), err.status);
    }
    logger.error({ err, requestId: c.get('requestId') }, 'unhandled error');
    return c.json(
      errorBody(new AppError('internal', { requestId: c.get('requestId') }), lang),
      500,
    );
  });

  return app;
}

export type App = ReturnType<typeof createApp>;

/**
 * A lock that starts on a failed attempt is raised from better-auth's after-hook, which
 * keeps the endpoint's original 401. The contract says 423 for ACCOUNT_LOCKED.
 */
async function withLockStatus(res: Response): Promise<Response> {
  if (res.status !== 401 || !res.headers.get('content-type')?.includes('application/json')) {
    return res;
  }
  const text = await res.text();
  let code: unknown;
  try {
    code = (JSON.parse(text) as { code?: unknown }).code;
  } catch {
    code = undefined;
  }
  return new Response(text, {
    status: code === 'ACCOUNT_LOCKED' ? 423 : res.status,
    headers: res.headers,
  });
}
