import { can, CALENDAR_RAW_PATHS, paths, withQuery } from '@crewhall/shared';
import { z } from 'zod';
import type { Deps } from '../deps';
import { requestInfo, type Router } from '../http/route';
import { appReturn } from '../services/oauth-handoff';
import type { OrgCtx } from '../http/types';
import { moduleOn } from '../services/mcp/policy';
import type { CalActor } from '../services/calendar/access';
import * as cals from '../services/calendar/calendars';
import { handleCaldav } from '../services/calendar/caldav';
import * as events from '../services/calendar/events';
import * as bk from '../services/calendar/bookings';
import { freeBusy, listOccurrences } from '../services/calendar/occurrences';
import { settingsFor, updateSettings } from '../services/calendar/settings';
import { exportIcs, importIcs } from '../services/calendar/transfer';
import { AppError } from '../http/errors';
import { audit } from '../services/audit';
import { orgContext } from '../services/membership';
import {
  accountWithCalendars,
  connectAccount,
  deleteAccount,
  listAccounts,
  loadOwnAccount,
  setBusyOnly,
} from '../services/calendar/external/accounts';
import { provisionDomainWide } from '../services/calendar/external/domain-wide';
import { accountForNotification, PUSH_PATHS } from '../services/calendar/external/push';
import { listVersions } from '../services/calendar/external/versions';
import {
  listIntegrations,
  loadIntegration,
  parseProvider,
  updateIntegration,
} from '../services/calendar/external/integrations';
import { connectExchange } from '../services/calendar/external/ews/connect';
import { finishOauth, startUrl } from '../services/calendar/external/oauth';
import { syncAccount } from '../services/calendar/external/sync';
import { runGoogleDirectorySync } from '../services/contacts/google-directory';

const OauthCallbackQuery = z.object({
  code: z.string().max(4000).optional(),
  state: z.string().max(200).optional(),
  error: z.string().max(200).optional(),
});

function requireAdmin(ctx: Pick<OrgCtx<never>, 'actor' | 'org'>) {
  if (!can(ctx.actor, 'org.update_settings', { type: 'org', org: orgContext(ctx.org) })) {
    throw new AppError('forbidden');
  }
}

const calActor = (ctx: Pick<OrgCtx<never>, 'org' | 'actor' | 'user'>): CalActor => ({
  org: ctx.org,
  actor: ctx.actor,
  userId: ctx.user.id,
  userName: ctx.user.name,
  userEmail: ctx.user.email,
});

const DAV_METHODS = [
  'OPTIONS',
  'GET',
  'HEAD',
  'PUT',
  'DELETE',
  'PROPFIND',
  'PROPPATCH',
  'REPORT',
  'MKCALENDAR',
  'MKCOL',
] as const;

/** Calendar module routes; endpoints come from packages/shared/src/endpoints/calendar.ts. */
export function registerCalendar(r: Router): void {
  r.org('listCalendars', (ctx) => cals.listCalendars(ctx.deps.db, calActor(ctx)));
  r.org('createCalendar', (ctx) => cals.createCalendar(ctx.deps.db, calActor(ctx), ctx.body), {
    status: 201,
  });
  r.org('updateCalendar', (ctx) =>
    cals.updateCalendar(ctx.deps.db, calActor(ctx), ctx.params.calendarId, ctx.body),
  );
  r.org('deleteCalendar', async (ctx) => {
    await cals.deleteCalendar(ctx.deps.db, calActor(ctx), ctx.params.calendarId);
    return {};
  });
  r.org('listCalendarMembers', (ctx) =>
    cals.listMembers(ctx.deps.db, calActor(ctx), ctx.params.calendarId),
  );
  r.org('setCalendarMember', (ctx) =>
    cals.setMember(
      ctx.deps.db,
      calActor(ctx),
      ctx.params.calendarId,
      ctx.params.userId,
      ctx.body.role,
    ),
  );
  r.org('removeCalendarMember', async (ctx) => {
    await cals.removeMember(ctx.deps.db, calActor(ctx), ctx.params.calendarId, ctx.params.userId);
    return {};
  });
  r.org('importCalendarIcs', (ctx) =>
    importIcs(ctx.deps, calActor(ctx), ctx.params.calendarId, ctx.body.ics),
  );

  r.org('listCalendarOccurrences', (ctx) => listOccurrences(ctx.deps.db, calActor(ctx), ctx.query));
  r.org('getCalendarFreeBusy', (ctx) => freeBusy(ctx.deps.db, calActor(ctx), ctx.query));

  r.org('createCalendarEvent', (ctx) => events.createEvent(ctx.deps, calActor(ctx), ctx.body), {
    status: 201,
  });
  r.org('listCalendarEventVersions', async (ctx) => {
    // Whoever may read the event; a private event of someone else is not_found here too.
    const acc = await events.loadEvent(ctx.deps.db, calActor(ctx), ctx.params.eventId);
    return listVersions(ctx.deps.db, acc.row.id);
  });
  r.org('getCalendarEvent', (ctx) =>
    events.getEvent(ctx.deps, calActor(ctx), ctx.params.eventId, ctx.query.recurrenceId),
  );
  r.org('updateCalendarEvent', (ctx) =>
    events.updateEvent(ctx.deps, calActor(ctx), ctx.params.eventId, ctx.body),
  );
  r.org('deleteCalendarEvent', async (ctx) => {
    await events.deleteEvent(ctx.deps, calActor(ctx), ctx.params.eventId, ctx.query);
    return {};
  });
  r.org('respondCalendarEvent', (ctx) =>
    events.respondEvent(ctx.deps, calActor(ctx), ctx.params.eventId, ctx.body.response),
  );

  r.org('getCalendarSettings', (ctx) => settingsFor(ctx.deps.db, ctx.org.id, ctx.user.id));
  r.org('updateCalendarSettings', (ctx) =>
    updateSettings(ctx.deps.db, ctx.org.id, ctx.user.id, ctx.body),
  );
  r.org('getCalDavInfo', async (ctx) => ({
    url: new URL('/caldav/', ctx.deps.env.HUB_URL).toString(),
    username: ctx.user.email,
    tokensAvailable: moduleOn(ctx.org, 'mcp'),
  }));

  // ---- Google / Microsoft accounts -----------------------------------------------------------
  r.org('listCalendarAccounts', (ctx) => listAccounts(ctx.deps.db, ctx.org.id, ctx.user.id));
  r.org('connectExchangeAccount', async (ctx) => {
    const row = await connectExchange(ctx.deps, ctx.org.id, ctx.user.id, ctx.body);
    await audit(
      ctx.deps.db,
      {
        orgId: ctx.org.id,
        actorId: ctx.user.id,
        action: 'calendar.account.connect',
        targetType: 'calendar_account',
        targetId: row.id,
        meta: { provider: row.provider, email: row.email },
      },
      ctx.req,
    );
    await ctx.deps.jobs.send(
      'calendar.external_sync_account',
      { accountId: row.id },
      { singletonKey: `calendar.external_sync:${row.id}` },
    );
    return accountWithCalendars(ctx.deps.db, row);
  });
  r.org('syncCalendarAccount', async (ctx) => {
    const row = await loadOwnAccount(ctx.deps.db, ctx.org.id, ctx.user.id, ctx.params.accountId);
    const fresh = await syncAccount(ctx.deps, row.id);
    return accountWithCalendars(ctx.deps.db, fresh ?? row);
  });
  r.org('deleteCalendarAccount', async (ctx) => {
    const row = await deleteAccount(ctx.deps, ctx.org.id, ctx.user.id, ctx.params.accountId);
    await audit(
      ctx.deps.db,
      {
        orgId: ctx.org.id,
        actorId: ctx.user.id,
        action: 'calendar.account.disconnect',
        targetType: 'calendar_account',
        targetId: row.id,
        meta: { provider: row.provider, email: row.email },
      },
      ctx.req,
    );
    return {};
  });
  r.org('updateCalendarAccount', async (ctx) => {
    const row = await setBusyOnly(
      ctx.deps.db,
      ctx.org.id,
      ctx.user.id,
      ctx.params.accountId,
      ctx.body.busyOnly,
    );
    await ctx.deps.jobs.send(
      'calendar.external_sync_account',
      { accountId: row.id },
      { singletonKey: `calendar.external_sync:${row.id}` },
    );
    return accountWithCalendars(ctx.deps.db, row);
  });
  r.org('getCalendarIntegrations', async (ctx) => {
    requireAdmin(ctx);
    return listIntegrations(ctx.deps.db, ctx.deps.env, ctx.org.id);
  });
  r.org('updateCalendarIntegration', async (ctx) => {
    requireAdmin(ctx);
    const provider = parseProvider(ctx.params.provider);
    const out = await updateIntegration(
      ctx.deps.db,
      ctx.deps.env,
      ctx.org.id,
      ctx.user.id,
      provider,
      ctx.body,
    );
    await audit(
      ctx.deps.db,
      {
        orgId: ctx.org.id,
        actorId: ctx.user.id,
        action: 'calendar.integration.update',
        targetType: 'org',
        targetId: ctx.org.id,
        meta: { provider, enabled: ctx.body.enabled },
      },
      ctx.req,
    );
    // Org-wide access switched on or off: accounts follow now, not at the next hour.
    await provisionDomainWide(ctx.deps, ctx.org.id);
    return out;
  });

  // ---- Room and desk booking ----------------------------------------------------------------
  r.org('listBookingResources', (ctx) => bk.listResources(ctx.deps.db, calActor(ctx), ctx.query));
  r.org('createBookingResource', (ctx) => bk.createResource(ctx.deps.db, calActor(ctx), ctx.body), {
    status: 201,
  });
  r.org('updateBookingResource', (ctx) =>
    bk.updateResource(ctx.deps.db, calActor(ctx), ctx.params.resourceId, ctx.body),
  );
  r.org('deleteBookingResource', async (ctx) => {
    await bk.deleteResource(ctx.deps, calActor(ctx), ctx.params.resourceId);
    return {};
  });
  r.org('listBookings', (ctx) => bk.listBookings(ctx.deps.db, calActor(ctx), ctx.query));
  r.org('getBookingAvailability', (ctx) => bk.availability(ctx.deps.db, calActor(ctx), ctx.query));
  r.org('createBooking', (ctx) => bk.createBooking(ctx.deps, calActor(ctx), ctx.body), {
    status: 201,
  });
  r.org('cancelBooking', async (ctx) => {
    await bk.cancelBooking(ctx.deps, calActor(ctx), ctx.params.bookingId);
    return {};
  });
  r.org('checkInBooking', (ctx) => bk.checkIn(ctx.deps, calActor(ctx), ctx.params.bookingId));

  r.org('syncWorkspaceDirectory', async (ctx) => {
    requireAdmin(ctx);
    const row = await loadIntegration(ctx.deps.db, ctx.org.id, 'google');
    if (!row?.directorySync) throw new AppError('calendar_integration_off');
    await runGoogleDirectorySync(ctx.deps, row);
    const { items } = await listIntegrations(ctx.deps.db, ctx.deps.env, ctx.org.id);
    return items.find((i) => i.provider === 'google')!;
  });

  // Change notifications from Google and Microsoft: the matching account syncs right away.
  const syncSoon = async (deps: Pick<Deps, 'jobs'>, accountId: string) =>
    deps.jobs.send(
      'calendar.external_sync_account',
      { accountId },
      { singletonKey: `calendar.external_sync:${accountId}` },
    );
  r.rawPublic('POST', PUSH_PATHS.google, async ({ c, deps }) => {
    const state = c.req.header('x-goog-resource-state');
    const accountId = await accountForNotification(
      deps.db,
      deps.env,
      c.req.header('x-goog-channel-id') ?? '',
      c.req.header('x-goog-channel-token') ?? '',
    );
    // "sync" is Google's hello when the channel opens; nothing changed yet.
    if (accountId && state !== 'sync') await syncSoon(deps, accountId);
    return c.body(null, 200);
  });
  r.rawPublic('POST', PUSH_PATHS.microsoft, async ({ c, deps }) => {
    // Subscription handshake: Graph wants its token back as plain text.
    const validation = c.req.query('validationToken');
    if (validation) return c.text(validation, 200);
    const body = (await c.req.json().catch(() => null)) as {
      value?: { subscriptionId?: string; clientState?: string }[];
    } | null;
    const ids = new Set<string>();
    for (const n of body?.value?.slice(0, 100) ?? []) {
      const accountId = await accountForNotification(
        deps.db,
        deps.env,
        n.subscriptionId ?? '',
        n.clientState ?? '',
      );
      if (accountId) ids.add(accountId);
    }
    for (const id of ids) await syncSoon(deps, id);
    return c.body(null, 202);
  });

  // Connecting is a browser round trip: start → provider consent → callback → /calendar.
  r.rawOrg('GET', CALENDAR_RAW_PATHS.oauthStart, async ({ c, deps, org, actor, user }) => {
    if (!moduleOn(org, 'calendar')) throw new AppError('module_disabled');
    if (actor.orgRole === 'guest') throw new AppError('forbidden');
    const provider = parseProvider(c.req.param('provider'));
    return c.redirect(await startUrl(deps.db, deps.env, org.id, user, provider), 302);
  });
  r.rawOrg(
    'GET',
    CALENDAR_RAW_PATHS.oauthCallback,
    async ({ c, deps, org, actor, user, handoff }) => {
      const back = (params: Record<string, string>) => {
        const path = withQuery(paths.calendar(), params);
        // Started from the app: the browser hands the page back to it.
        return c.redirect(
          handoff
            ? appReturn(deps.env, handoff.redirectUri, path)
            : `${deps.env.HUB_URL.replace(/\/$/, '')}${path}`,
          302,
        );
      };
      try {
        if (!moduleOn(org, 'calendar')) throw new AppError('module_disabled');
        if (actor.orgRole === 'guest') throw new AppError('forbidden');
        const q = OauthCallbackQuery.parse(c.req.query());
        if (q.error || !q.code || !q.state) {
          throw new AppError('calendar_oauth_failed', { reason: q.error ?? 'missing_code' });
        }
        const { provider, tokens } = await finishOauth(deps.db, deps.env, org.id, user.id, {
          code: q.code,
          state: q.state,
        });
        const account = await connectAccount(deps, org.id, user.id, provider, tokens);
        await audit(
          deps.db,
          {
            orgId: org.id,
            actorId: user.id,
            action: 'calendar.account.connect',
            targetType: 'calendar_account',
            targetId: account.id,
            meta: { provider, email: account.email },
          },
          requestInfo(c),
        );
        await deps.jobs.send(
          'calendar.external_sync_account',
          { accountId: account.id },
          { singletonKey: `calendar.external_sync:${account.id}` },
        );
        return back({ connected: provider });
      } catch (err) {
        deps.logger.warn({ err }, 'calendar oauth callback failed');
        return back({ error: err instanceof AppError ? err.code : 'calendar_oauth_failed' });
      }
    },
    { handoff: 'calendar' },
  );

  // The whole calendar as a file.
  r.rawOrg('GET', CALENDAR_RAW_PATHS.exportIcs, async ({ c, deps, org, actor, user }) => {
    if (!moduleOn(org, 'calendar')) throw new AppError('module_disabled');
    const calendarId = c.req.param('calendarId') ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(calendarId)) throw new AppError('not_found');
    const out = await exportIcs(
      deps,
      { org, actor, userId: user.id, userName: user.name, userEmail: user.email },
      calendarId,
    );
    const file = `${out.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'takvim'}.ics`;
    return c.body(out.ics, 200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="calendar.ics"; filename*=UTF-8''${encodeURIComponent(file)}`,
    });
  });

  // CalDAV: personal API tokens as the password (services/calendar/caldav.ts).
  for (const method of DAV_METHODS) {
    r.rawPublic(method, CALENDAR_RAW_PATHS.caldav, ({ c, deps }) => handleCaldav(deps, c));
    r.rawPublic(method, `${CALENDAR_RAW_PATHS.caldav}/*`, ({ c, deps }) => handleCaldav(deps, c));
  }
  r.rawPublic('GET', '/.well-known/caldav', async ({ c }) => c.redirect('/caldav/', 301));
  r.rawPublic('PROPFIND', '/.well-known/caldav', async ({ c }) => c.redirect('/caldav/', 301));
}
