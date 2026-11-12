import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { calendarEvents, calendars } from '@crewhall/db';
import type { Context } from 'hono';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { AppEnv } from '../../http/types';
import type { McpPrincipal } from '../mcp/principal';
import { personalSpaceId } from '../spaces';
import {
  actorOf,
  answer,
  authenticateDav,
  DAV_NS as NS,
  hrefXml,
  missingXml,
  multistatus,
  preconditionFails,
  PRIVILEGES_READ,
  PRIVILEGES_WRITE,
  propXml,
  requested,
  responseXml,
  type Getter,
  type PropValue,
} from './dav';
import {
  permKind,
  readableCalendars,
  requireManage,
  touchCalendars,
  type CalActor,
  type CalendarAccess,
  type EventRow,
} from './access';
import { canCalendar } from '@crewhall/shared';
import { detachMeeting } from './meeting';
import { announceChange } from './notify';
import { expandSeries } from './occurrences';
import { buildIcs, parseIcs } from './ics';
import { calendarSeries, etagOf, icsEventsFor } from './resources';
import { settingsFor } from './settings';
import { announceInvited, upsertObject } from './transfer';
import { child, childrenOf, escapeXml, parseXml, type XmlElement } from './xml';

/**
 * CalDAV (RFC 4791) for desktop and phone calendars (Apple Calendar, Thunderbird, DAVx5,
 * Outlook plug-ins): `/caldav/` with HTTP Basic, the password being a personal API token
 * (Hesabım › MCP ve API; the user name is ignored). Reads need `hub:read`, writes
 * `calendar:write`. Collections are the person's personal, team and space calendars;
 * linked meetings and card due dates stay in the web views. getctag/ETag based sync
 * (no sync-collection), no scheduling inbox/outbox: invitations go out from the server
 * the same way as from the web.
 */

const ROOT = '/caldav/';
const PRINCIPAL = '/caldav/principals/me/';
const HOME = '/caldav/calendars/';

/** Calendar colours as hex for clients (the 6 space colours of the design system). */
const COLOR_HEX: Record<string, string> = {
  s1: '#3B82F6FF',
  s2: '#10B981FF',
  s3: '#F38424FF',
  s4: '#8B5CF6FF',
  s5: '#EF4444FF',
  s6: '#64748BFF',
};

interface DavCtx {
  deps: Deps;
  c: Context<AppEnv>;
  actor: CalActor;
  principal: McpPrincipal;
  canWrite: boolean;
}

// ---- auth ---------------------------------------------------------------------------------------

async function authenticate(deps: Deps, c: Context<AppEnv>): Promise<DavCtx | Response> {
  const auth = await authenticateDav(deps, c, 'calendar', 'Crewhall CalDAV');
  if (auth instanceof Response) return auth;
  return {
    deps,
    c,
    principal: auth.principal,
    canWrite: auth.scopes.includes('calendar:write'),
    actor: actorOf(auth),
  };
}

/** Calendars the token reaches: space calendars only inside its spaces. */
async function davCalendars(d: DavCtx): Promise<CalendarAccess[]> {
  // Mirrored Google / Microsoft calendars sync with their own provider, not over CalDAV.
  const all = (await readableCalendars(d.deps.db, d.actor)).filter(
    (x) => x.calendar.kind !== 'external',
  );
  if (d.principal.spaceIds === null) return all;
  const allowed = new Set(d.principal.spaceIds);
  const personal = await personalSpaceId(d.deps.db, d.actor.org.id, d.actor.userId);
  return all.filter((x) =>
    x.calendar.kind === 'space'
      ? allowed.has(x.calendar.spaceId!)
      : personal !== null && allowed.has(personal),
  );
}

function commonProps(d: DavCtx): Getter {
  return (ns, name) => {
    if (ns === NS.D && name === 'current-user-principal') return hrefXml(PRINCIPAL);
    if (ns === NS.D && name === 'principal-URL') return hrefXml(PRINCIPAL);
    if (ns === NS.C && name === 'calendar-home-set') return hrefXml(HOME);
    if (ns === NS.C && name === 'calendar-user-address-set') {
      return hrefXml(`mailto:${d.actor.userEmail}`);
    }
    if (ns === NS.D && name === 'owner') return hrefXml(PRINCIPAL);
    if (ns === NS.D && name === 'supported-report-set') {
      return '<D:supported-report><D:report><C:calendar-multiget/></D:report></D:supported-report><D:supported-report><D:report><C:calendar-query/></D:report></D:supported-report>';
    }
    return undefined;
  };
}

// ---- paths --------------------------------------------------------------------------------------

type Target =
  | { kind: 'root' }
  | { kind: 'principal' }
  | { kind: 'home' }
  | { kind: 'calendar'; id: string }
  | { kind: 'object'; id: string; name: string };

function targetOf(path: string): Target | null {
  const p = decodeURIComponent(path).replace(/\/+/g, '/');
  if (p === '/caldav' || p === ROOT) return { kind: 'root' };
  if (p === PRINCIPAL || p === PRINCIPAL.slice(0, -1) || p === '/caldav/principals/') {
    return { kind: 'principal' };
  }
  if (p === HOME || p === HOME.slice(0, -1)) return { kind: 'home' };
  const m = /^\/caldav\/calendars\/([0-9a-f-]{36})\/?(?:([^/]+))?$/i.exec(p);
  if (!m) return null;
  if (!m[2]) return { kind: 'calendar', id: m[1]!.toLowerCase() };
  return { kind: 'object', id: m[1]!.toLowerCase(), name: m[2] };
}

const objectName = (row: Pick<EventRow, 'id' | 'davName'>) => row.davName ?? `${row.id}.ics`;
const calendarHref = (id: string) => `${HOME}${id}/`;
const objectHref = (calId: string, row: Pick<EventRow, 'id' | 'davName'>) =>
  `${calendarHref(calId)}${encodeURIComponent(objectName(row))}`;

async function findObject(d: DavCtx, calendarId: string, name: string) {
  const idPart = /^([0-9a-f-]{36})\.ics$/i.exec(name)?.[1];
  const [row] = await d.deps.db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.calendarId, calendarId),
        isNull(calendarEvents.parentId),
        isNull(calendarEvents.deletedAt),
        or(
          eq(calendarEvents.davName, name),
          idPart
            ? and(
                isNull(calendarEvents.davName),
                sql`${calendarEvents.id}::text = ${idPart.toLowerCase()}`,
              )
            : sql`false`,
        ),
      ),
    );
  return row ?? null;
}

const visibleRow = (cal: CalendarAccess, row: EventRow, userId: string) =>
  row.visibility !== 'private' || cal.role === 'owner' || row.organizerId === userId;

// ---- handlers -----------------------------------------------------------------------------------

const DAV_HEADERS = {
  DAV: '1, 3, calendar-access',
  Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT',
};

export async function handleCaldav(deps: Deps, c: Context<AppEnv>): Promise<Response> {
  for (const [k, v] of Object.entries(DAV_HEADERS)) c.header(k, v);
  if (c.req.method === 'OPTIONS') return c.body(null, 200);
  const auth = await authenticate(deps, c);
  if (auth instanceof Response) return auth;
  const d = auth;
  const path = new URL(c.req.url).pathname;
  const target = targetOf(path);
  if (!target) return c.text('Not Found', 404);
  try {
    switch (c.req.method) {
      case 'PROPFIND':
        return await propfind(d, target);
      case 'REPORT':
        if (target.kind !== 'calendar') return c.text('Not Found', 404);
        return await report(d, target.id);
      case 'PROPPATCH':
        if (target.kind !== 'calendar') return c.text('Forbidden', 403);
        return await proppatch(d, target.id);
      case 'GET':
      case 'HEAD':
        return await get(d, target);
      case 'PUT':
        if (target.kind !== 'object') return c.text('Method Not Allowed', 405);
        return await put(d, target.id, target.name);
      case 'DELETE':
        if (target.kind !== 'object') return c.text('Forbidden', 403);
        return await remove(d, target.id, target.name);
      case 'MKCALENDAR':
      case 'MKCOL':
        return c.text('Forbidden', 403);
      default:
        return c.text('Method Not Allowed', 405);
    }
  } catch (err) {
    if (err instanceof AppError && err.status === 404) return c.text('Not Found', 404);
    if (err instanceof AppError && err.status === 403) return c.text('Forbidden', 403);
    throw err;
  }
}

async function bodyXml(c: Context<AppEnv>) {
  const text = await c.req.text();
  return text.trim() ? parseXml(text) : null;
}

async function calendarOf(d: DavCtx, id: string) {
  const cal = (await davCalendars(d)).find((x) => x.calendar.id === id);
  if (!cal) throw new AppError('not_found');
  return cal;
}

function calendarProps(d: DavCtx, cal: CalendarAccess): Getter {
  const common = commonProps(d);
  const write =
    d.canWrite && canCalendar('write', { role: cal.role, kind: permKind(cal.calendar.kind) });
  return (ns, name) => {
    if (ns === NS.D && name === 'resourcetype') return '<D:collection/><C:calendar/>';
    if (ns === NS.D && name === 'displayname')
      return escapeXml(cal.space?.name ?? cal.calendar.name);
    if (ns === NS.C && name === 'calendar-description') {
      return escapeXml(cal.calendar.description ?? '');
    }
    if (ns === NS.CS && name === 'getctag') return `"${cal.calendar.changeSeq}"`;
    if (ns === NS.D && name === 'getetag') return `"${cal.calendar.changeSeq}"`;
    if (ns === NS.A && name === 'calendar-color') {
      return COLOR_HEX[cal.space?.color ?? cal.calendar.color] ?? COLOR_HEX.s1!;
    }
    if (ns === NS.C && name === 'supported-calendar-component-set')
      return '<C:comp name="VEVENT"/>';
    if (ns === NS.C && name === 'supported-calendar-data') {
      return '<C:calendar-data content-type="text/calendar" version="2.0"/>';
    }
    if (ns === NS.D && name === 'current-user-privilege-set') {
      return write ? PRIVILEGES_WRITE : PRIVILEGES_READ;
    }
    if (ns === NS.D && name === 'getcontenttype') return 'text/calendar; charset=utf-8';
    return common(ns, name);
  };
}

async function propfind(d: DavCtx, t: Target) {
  const { c } = d;
  const body = await bodyXml(c);
  const depth = c.req.header('depth') === '0' ? 0 : 1;
  const common = commonProps(d);
  const out: string[] = [];

  if (t.kind === 'root' || t.kind === 'principal') {
    const props = requested(body, [
      [NS.D, 'resourcetype'],
      [NS.D, 'current-user-principal'],
      [NS.D, 'displayname'],
    ]);
    const get: Getter = (ns, name) => {
      if (ns === NS.D && name === 'resourcetype') {
        return t.kind === 'principal' ? '<D:collection/><D:principal/>' : '<D:collection/>';
      }
      if (ns === NS.D && name === 'displayname') {
        return escapeXml(t.kind === 'principal' ? d.actor.userName : 'Crewhall');
      }
      return common(ns, name);
    };
    out.push(responseXml(t.kind === 'principal' ? PRINCIPAL : ROOT, answer(props, get)));
    return multistatus(c, out);
  }

  const defaults: [string, string][] = [
    [NS.D, 'resourcetype'],
    [NS.D, 'displayname'],
    [NS.D, 'getetag'],
    [NS.CS, 'getctag'],
  ];
  const props = requested(body, defaults);

  if (t.kind === 'home') {
    out.push(
      responseXml(
        HOME,
        answer(props, (ns, name) =>
          ns === NS.D && name === 'resourcetype'
            ? '<D:collection/>'
            : ns === NS.D && name === 'displayname'
              ? escapeXml(d.actor.userName)
              : common(ns, name),
        ),
      ),
    );
    if (depth === 1) {
      for (const cal of await davCalendars(d)) {
        out.push(responseXml(calendarHref(cal.calendar.id), answer(props, calendarProps(d, cal))));
      }
    }
    return multistatus(c, out);
  }

  const cal = await calendarOf(d, t.id);
  if (t.kind === 'calendar') {
    out.push(responseXml(calendarHref(cal.calendar.id), answer(props, calendarProps(d, cal))));
    if (depth === 1) {
      const rows = (await calendarSeries(d.deps.db, cal.calendar.id)).filter((r) =>
        visibleRow(cal, r, d.actor.userId),
      );
      for (const row of rows) {
        out.push(
          responseXml(objectHref(cal.calendar.id, row), answer(props, objectProps(row, null))),
        );
      }
    }
    return multistatus(c, out);
  }
  const row = await findObject(d, cal.calendar.id, t.name);
  if (!row || !visibleRow(cal, row, d.actor.userId)) return c.text('Not Found', 404);
  out.push(responseXml(objectHref(cal.calendar.id, row), answer(props, objectProps(row, null))));
  return multistatus(c, out);
}

function objectProps(row: EventRow, data: string | null): Getter {
  return (ns, name) => {
    if (ns === NS.D && name === 'getetag') return escapeXml(etagOf(row));
    if (ns === NS.D && name === 'resourcetype') return '';
    if (ns === NS.D && name === 'getcontenttype')
      return 'text/calendar; charset=utf-8; component=vevent';
    if (ns === NS.D && name === 'getlastmodified') return row.updatedAt.toUTCString();
    if (ns === NS.D && name === 'displayname') return undefined;
    if (ns === NS.C && name === 'calendar-data') return data === null ? undefined : escapeXml(data);
    if (ns === NS.CS && name === 'getctag') return undefined;
    return undefined;
  };
}

async function objectData(d: DavCtx, rows: EventRow[]) {
  const map = await icsEventsFor(d.deps.db, rows, d.deps.env.HUB_URL);
  return new Map(rows.map((r) => [r.id, buildIcs({ events: map.get(r.id) ?? [] })]));
}

async function report(d: DavCtx, calendarId: string) {
  const { c } = d;
  const cal = await calendarOf(d, calendarId);
  const body = await bodyXml(c);
  if (!body) return c.text('Bad Request', 400);
  const props = requested(body, [
    [NS.D, 'getetag'],
    [NS.C, 'calendar-data'],
  ]);
  const wantsData = props.some(([ns, n]) => ns === NS.C && n === 'calendar-data');
  const all = (await calendarSeries(d.deps.db, cal.calendar.id)).filter((r) =>
    visibleRow(cal, r, d.actor.userId),
  );
  let rows: EventRow[] = [];
  const missing: string[] = [];

  if (body.ns === NS.C && body.name === 'calendar-multiget') {
    for (const h of childrenOf(body, NS.D, 'href')) {
      const href = h.text.trim();
      const name = decodeURIComponent(href.split('/').filter(Boolean).pop() ?? '');
      const row = all.find((r) => objectName(r) === name);
      if (row) rows.push(row);
      else missing.push(href);
    }
  } else if (body.ns === NS.C && body.name === 'calendar-query') {
    const range = findTimeRange(child(body, NS.C, 'filter'));
    if (!range) rows = all;
    else {
      const expanded = await expandSeries(d.deps.db, all, range.start, range.end);
      const ids = new Set(expanded.map((e) => e.series.id));
      rows = all.filter((r) => ids.has(r.id));
    }
  } else {
    return c.body(
      '<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><D:supported-report/></D:error>',
      403,
      { 'Content-Type': 'application/xml; charset=utf-8' },
    );
  }
  const data = wantsData ? await objectData(d, rows) : new Map<string, string>();
  const out = rows.map((row) =>
    responseXml(
      objectHref(cal.calendar.id, row),
      answer(props, objectProps(row, wantsData ? (data.get(row.id) ?? '') : null)),
    ),
  );
  for (const href of missing) {
    out.push(missingXml(href));
  }
  return multistatus(c, out);
}

/** The VEVENT time-range of a calendar-query filter (other filters are not applied). */
function findTimeRange(filter: XmlElement | null): { start: Date; end: Date } | null {
  const stack = filter ? [filter] : [];
  while (stack.length) {
    const el = stack.pop()!;
    if (el.ns === NS.C && el.name === 'time-range') {
      const parse = (v: string | undefined, fallback: number) => {
        const m = v && /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v);
        return m
          ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!))
          : new Date(fallback);
      };
      return {
        start: parse(el.attrs.start, Date.UTC(1900, 0, 1)),
        end: parse(el.attrs.end, Date.UTC(2200, 0, 1)),
      };
    }
    stack.push(...el.children);
  }
  return null;
}

async function proppatch(d: DavCtx, calendarId: string) {
  const { c } = d;
  const cal = await calendarOf(d, calendarId);
  const body = await bodyXml(c);
  const ok: [string, string, PropValue][] = [];
  const denied: [string, string][] = [];
  const set = childrenOf(body, NS.D, 'set').flatMap((s) => child(s, NS.D, 'prop')?.children ?? []);
  const manage = d.canWrite && cal.calendar.kind !== 'space' && cal.role === 'owner';
  const patch: { name?: string } = {};
  for (const p of set) {
    if (manage && p.ns === NS.D && p.name === 'displayname' && p.text.trim()) {
      patch.name = p.text.trim().slice(0, 80);
      ok.push([p.ns, p.name, null]);
    } else denied.push([p.ns, p.name]);
  }
  if (patch.name) {
    requireManage(cal);
    await d.deps.db
      .update(calendars)
      .set({ name: patch.name })
      .where(eq(calendars.id, cal.calendar.id));
    await touchCalendars(d.deps.db, [cal.calendar.id]);
  }
  const parts = [`<D:response><D:href>${escapeXml(calendarHref(cal.calendar.id))}</D:href>`];
  if (ok.length) {
    parts.push(
      `<D:propstat><D:prop>${ok.map(([ns, n], i) => propXml(ns, n, null, i)).join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`,
    );
  }
  if (denied.length) {
    parts.push(
      `<D:propstat><D:prop>${denied.map(([ns, n], i) => propXml(ns, n, null, i + 100)).join('')}</D:prop><D:status>HTTP/1.1 403 Forbidden</D:status></D:propstat>`,
    );
  }
  parts.push('</D:response>');
  return multistatus(c, [parts.join('')]);
}

async function get(d: DavCtx, t: Target) {
  const { c } = d;
  if (t.kind === 'object') {
    const cal = await calendarOf(d, t.id);
    const row = await findObject(d, cal.calendar.id, t.name);
    if (!row || !visibleRow(cal, row, d.actor.userId)) return c.text('Not Found', 404);
    const ics = (await objectData(d, [row])).get(row.id)!;
    c.header('ETag', etagOf(row));
    const headers = { 'Content-Type': 'text/calendar; charset=utf-8' };
    return c.req.method === 'HEAD' ? c.body(null, 200, headers) : c.body(ics, 200, headers);
  }
  if (t.kind === 'calendar') {
    const cal = await calendarOf(d, t.id);
    const rows = (await calendarSeries(d.deps.db, cal.calendar.id)).filter((r) =>
      visibleRow(cal, r, d.actor.userId),
    );
    const map = await icsEventsFor(d.deps.db, rows, d.deps.env.HUB_URL);
    return c.body(
      buildIcs({ events: [...map.values()].flat(), name: cal.space?.name ?? cal.calendar.name }),
      200,
      { 'Content-Type': 'text/calendar; charset=utf-8' },
    );
  }
  return c.text('Crewhall CalDAV', 200);
}

async function put(d: DavCtx, calendarId: string, name: string) {
  const { c, deps } = d;
  if (!d.canWrite) return c.text('Forbidden', 403);
  const cal = await calendarOf(d, calendarId);
  if (!canCalendar('write', { role: cal.role, kind: permKind(cal.calendar.kind) })) {
    return c.text('Forbidden', 403);
  }
  if (name.length > 255 || !name.endsWith('.ics')) return c.text('Bad Request', 400);
  const existing = await findObject(d, cal.calendar.id, name);
  if (preconditionFails(c, existing ? etagOf(existing) : null))
    return c.text('Precondition Failed', 412);
  const text = await c.req.text();
  if (text.length > 1_000_000) return c.text('Payload Too Large', 413);
  const tz = (await settingsFor(deps.db, d.actor.org.id, d.actor.userId)).timeZone;
  const parsed = parseIcs(text, tz);
  if (!parsed || !parsed.events.length) {
    return c.body(
      '<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><C:valid-calendar-data/></D:error>',
      403,
      { 'Content-Type': 'application/xml; charset=utf-8' },
    );
  }
  const uids = new Set(parsed.events.map((e) => e.uid));
  if (uids.size !== 1) return c.text('One UID per resource', 400);
  const result = await deps.db.transaction(async (tx) => {
    const r = await upsertObject(tx, d.actor, cal, parsed.events, { uid: existing?.uid });
    if (!existing && r.series.davName !== name) {
      await tx
        .update(calendarEvents)
        .set({ davName: name })
        .where(eq(calendarEvents.id, r.series.id));
    }
    await touchCalendars(tx, [cal.calendar.id]);
    const [fresh] = await tx
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, r.series.id));
    return { ...r, series: fresh! };
  });
  await announceInvited(deps, d.actor, result);
  if (!result.created) await announceChange(deps, d.actor, result.series, 'updated');
  c.header('ETag', etagOf(result.series));
  return c.body(null, result.created ? 201 : 204);
}

async function remove(d: DavCtx, calendarId: string, name: string) {
  const { c, deps } = d;
  if (!d.canWrite) return c.text('Forbidden', 403);
  const cal = await calendarOf(d, calendarId);
  if (!canCalendar('write', { role: cal.role, kind: permKind(cal.calendar.kind) })) {
    return c.text('Forbidden', 403);
  }
  const row = await findObject(d, cal.calendar.id, name);
  if (!row) return c.text('Not Found', 404);
  if (preconditionFails(c, etagOf(row))) return c.text('Precondition Failed', 412);
  const now = new Date();
  await deps.db.transaction(async (tx) => {
    await tx.update(calendarEvents).set({ deletedAt: now }).where(eq(calendarEvents.id, row.id));
    await tx
      .update(calendarEvents)
      .set({ deletedAt: now })
      .where(and(eq(calendarEvents.parentId, row.id), isNull(calendarEvents.deletedAt)));
    await touchCalendars(tx, [cal.calendar.id]);
  });
  await announceChange(deps, d.actor, row, 'cancelled');
  await detachMeeting(deps, d.actor, row);
  return c.body(null, 204);
}
