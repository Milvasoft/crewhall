import { eq } from 'drizzle-orm';
import { users } from '@crewhall/db';
import { OAUTH_HANDOFF_RAW_PATHS, can, type ModuleKey } from '@crewhall/shared';
import { setCookie } from 'hono/cookie';
import type { Deps } from '../deps';
import { AppError } from '../http/errors';
import { clientIp } from '../http/client-ip';
import { requestInfo, type Router } from '../http/route';
import { audit } from '../services/audit';
import { startUrl as calendarStart } from '../services/calendar/external/oauth';
import { requireModule } from '../services/identity/modules';
import { startUrl as mailStart } from '../services/mail/oauth';
import { requireSettings } from '../services/mail/settings';
import { activeMemberships, orgContext, toActor } from '../services/membership';
import {
  bindState,
  createHandoff,
  HANDOFF_COOKIE,
  useHandoff,
  type Handoff,
} from '../services/oauth-handoff';
import { checkIpAllowlist } from '../services/identity/guard';

/**
 * Connecting mail and calendar accounts from the app (services/oauth-handoff): the app asks for
 * a one-time link, the system browser opens it here, and this starts the provider's flow for
 * the person of the link. The callbacks (routes/mail.ts, routes/calendar.ts) finish it.
 */
export function registerOAuthHandoff(r: Router) {
  r.org('createOAuthHandoff', async (ctx) => {
    // Refused up front, while the app can still show why.
    await mayConnect(ctx.deps, ctx.org, ctx.actor, ctx.body.purpose);
    const out = await createHandoff(
      ctx.deps.db,
      ctx.deps.env,
      { orgId: ctx.org.id, userId: ctx.user.id },
      ctx.body,
    );
    await audit(
      ctx.deps.db,
      {
        orgId: ctx.org.id,
        actorId: ctx.user.id,
        action: 'oauth.handoff.create',
        meta: { purpose: ctx.body.purpose, provider: ctx.body.provider ?? null },
      },
      requestInfo(ctx.c),
    );
    return out;
  });

  r.rawPublic('GET', OAUTH_HANDOFF_RAW_PATHS.open, async ({ c, deps }) => {
    const code = c.req.query('code');
    const h = code ? await useHandoff(deps.db, code) : null;
    if (!h) throw new AppError('oauth_handoff_invalid');
    const active = (await activeMemberships(deps.db, h.userId)).find((m) => m.org.id === h.orgId);
    const [user] = await deps.db.select().from(users).where(eq(users.id, h.userId));
    if (!active || !user) throw new AppError('forbidden');
    await checkIpAllowlist(deps.db, active.org.id, 'GET', new URL(c.req.url).pathname, clientIp(c));
    const actor = toActor(active.member);
    await mayConnect(deps, active.org, actor, h.purpose);
    const url = await providerUrl(deps, active.org.id, user, h);
    const state = new URL(url).searchParams.get('state');
    if (!state) throw new AppError('internal');
    const cookie = await bindState(deps.db, state, h);
    setCookie(c, HANDOFF_COOKIE, cookie, {
      path: '/api',
      httpOnly: true,
      // The provider's redirect back is a top-level GET: Lax sends it.
      sameSite: 'Lax',
      secure: deps.env.API_URL.startsWith('https:'),
      maxAge: 10 * 60,
    });
    await audit(
      deps.db,
      {
        orgId: active.org.id,
        actorId: user.id,
        action: 'oauth.handoff.open',
        meta: { purpose: h.purpose, provider: h.provider },
      },
      requestInfo(c),
    );
    return c.redirect(url, 302);
  });
}

/** The same rules as the web's start routes. */
async function mayConnect(
  deps: Deps,
  org: { id: string; settings: object },
  actor: ReturnType<typeof toActor>,
  purpose: Handoff['purpose'],
) {
  if (actor.orgRole === 'guest') throw new AppError('forbidden');
  const module: ModuleKey = purpose;
  await requireModule(deps.db, org.id, module);
  if (
    purpose === 'mail' &&
    !can(actor, 'org.view_directory', {
      type: 'org',
      org: orgContext(org as Parameters<typeof orgContext>[0]),
    })
  ) {
    throw new AppError('forbidden');
  }
}

async function providerUrl(
  deps: Deps,
  orgId: string,
  user: { id: string; email: string },
  h: Handoff,
) {
  if (h.purpose === 'mail') {
    const settings = await requireSettings(deps.db, orgId);
    return mailStart(deps.db, deps.env, settings, user, { loginHint: user.email });
  }
  if (!h.provider) throw new AppError('oauth_handoff_invalid');
  return calendarStart(deps.db, deps.env, orgId, user, h.provider);
}
