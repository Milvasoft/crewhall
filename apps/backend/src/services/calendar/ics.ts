import {
  civilFromDay,
  dateToDay,
  dayNumber,
  daysInMonthOf,
  dayToDate,
  isValidTimeZone,
  occurrenceKey,
  parseRRule,
  weekdayOfDay,
  zonedParts,
  zonedToUtc,
  zoneOffsetMs,
} from '@crewhall/shared';

/**
 * iCalendar (RFC 5545) reading and writing for the calendar module: .ics import/export and
 * CalDAV resources. Only VEVENT is read; VTIMEZONE blocks are ignored because TZIDs are
 * resolved as IANA names (with the usual Windows and Mozilla spellings), and written ones are
 * derived from the runtime's own zone data so clients without that zone still agree.
 */

// ---- text ---------------------------------------------------------------------------------------

export const escapeText = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

export const unescapeText = (s: string) =>
  s.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));

/** Lines longer than 75 octets continue on the next line after CRLF + space. */
export function fold(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const len = Buffer.byteLength(ch, 'utf8');
    const limit = parts.length === 0 ? 75 : 74;
    if (size + len > limit) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += len;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface IcsComponent {
  name: string;
  props: IcsProperty[];
  children: IcsComponent[];
}

function parseLine(line: string): IcsProperty | null {
  // name *(";" param) ":" value — params may be quoted and hold ':' or ';'.
  let i = 0;
  let inQuote = false;
  let colon = -1;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ':' && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts: string[] = [];
  let cur = '';
  inQuote = false;
  for (const ch of head) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === ';' && !inQuote) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  const name = (parts.shift() ?? '').toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 1) continue;
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

/** Parses the component tree; returns null when the text is not iCalendar. */
export function parseIcsTree(text: string): IcsComponent | null {
  const lines = text
    .replace(/\r\n[ \t]/g, '')
    .replace(/\n[ \t]/g, '')
    .split(/\r?\n/);
  const root: IcsComponent = { name: 'ROOT', props: [], children: [] };
  const stack: IcsComponent[] = [root];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const prop = parseLine(raw);
    if (!prop) continue;
    const top = stack[stack.length - 1]!;
    if (prop.name === 'BEGIN') {
      const c: IcsComponent = { name: prop.value.trim().toUpperCase(), props: [], children: [] };
      top.children.push(c);
      stack.push(c);
    } else if (prop.name === 'END') {
      if (stack.length > 1) stack.pop();
    } else top.props.push(prop);
  }
  const cal = root.children.find((c) => c.name === 'VCALENDAR');
  return cal ?? null;
}

// ---- zones ----------------------------------------------------------------------------------------

/** Windows zone names Outlook and Exchange send, to IANA. */
const WINDOWS_ZONES: Record<string, string> = {
  'Turkey Standard Time': 'Europe/Istanbul',
  'GTB Standard Time': 'Europe/Bucharest',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'GMT Standard Time': 'Europe/London',
  'FLE Standard Time': 'Europe/Kiev',
  'Russian Standard Time': 'Europe/Moscow',
  'Arab Standard Time': 'Asia/Riyadh',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  UTC: 'UTC',
  'Coordinated Universal Time': 'UTC',
};

/** The Windows name of an IANA zone, for servers that only take those; UTC when it has none. */
export function windowsZoneOf(iana: string): string {
  for (const [windows, zone] of Object.entries(WINDOWS_ZONES)) {
    if (zone === iana) return windows;
  }
  return 'UTC';
}

/** An IANA zone for a TZID, or null when it cannot be resolved. */
export function resolveTzid(tzid: string | undefined): string | null {
  if (!tzid) return null;
  const t = tzid.trim();
  if (isValidTimeZone(t)) return t;
  if (WINDOWS_ZONES[t]) return WINDOWS_ZONES[t]!;
  // Mozilla style "/mozilla.org/20070129_1/Europe/Istanbul" and similar prefixes.
  const parts = t.split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    const tail = parts.slice(i).join('/');
    if (isValidTimeZone(tail)) return tail;
  }
  return null;
}

// ---- values ---------------------------------------------------------------------------------------

/** A DATE or DATE-TIME property: all-day date or instant (+ the zone it was written in). */
export type IcsTime = { allDay: true; date: string } | { allDay: false; at: Date; tz: string };

export function parseIcsTime(p: IcsProperty, fallbackTz: string): IcsTime | null {
  const v = p.value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (date || p.params.VALUE === 'DATE') {
    const m = date ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    return { allDay: true, date: `${m[1]}-${m[2]}-${m[3]}` };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) {
    return {
      allDay: false,
      at: new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!)),
      tz: resolveTzid(p.params.TZID) ?? fallbackTz,
    };
  }
  const tz = resolveTzid(p.params.TZID) ?? fallbackTz;
  return {
    allDay: false,
    at: zonedToUtc({ year: +y!, month: +mo!, day: +d!, hour: +h!, minute: +mi!, second: +s! }, tz),
    tz,
  };
}

/** ISO 8601 duration (P1DT2H30M, -PT15M) in seconds. */
export function parseIcsDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    v.trim(),
  );
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  const secs =
    (+(w ?? 0) * 7 + +(d ?? 0)) * 86_400 + +(h ?? 0) * 3600 + +(mi ?? 0) * 60 + +(s ?? 0);
  return sign === '-' ? -secs : secs;
}

const stampUtc = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

const two = (n: number) => String(n).padStart(2, '0');

function localStamp(at: Date, tz: string) {
  const p = zonedParts(at, tz);
  return `${p.year}${two(p.month)}${two(p.day)}T${two(p.hour)}${two(p.minute)}${two(p.second)}`;
}

const dateValue = (date: string) => date.replace(/-/g, '');

// ---- reading events ---------------------------------------------------------------------------

export interface IcsAttendee {
  email: string;
  name: string | null;
  partstat: 'needs_action' | 'accepted' | 'declined' | 'tentative';
  optional: boolean;
}

export interface ParsedEvent {
  uid: string;
  /** Key of the original occurrence for an overriding VEVENT. */
  recurrenceId: string | null;
  title: string;
  description: string | null;
  location: string | null;
  allDay: boolean;
  start: string | Date;
  end: string | Date;
  timeZone: string;
  rrule: string | null;
  exdates: string[];
  status: 'confirmed' | 'tentative' | 'cancelled';
  busy: boolean;
  visibility: 'default' | 'private';
  sequence: number;
  reminders: number[] | null;
  organizerEmail: string | null;
  attendees: IcsAttendee[];
  extra: Record<string, string>;
}

export interface ParseResult {
  events: ParsedEvent[];
  errors: { uid: string | null; reason: string }[];
  calendarName: string | null;
}

const prop = (c: IcsComponent, name: string) => c.props.find((p) => p.name === name);
const mailto = (v: string) =>
  v
    .replace(/^mailto:/i, '')
    .trim()
    .toLowerCase();

const PARTSTAT: Record<string, IcsAttendee['partstat']> = {
  'NEEDS-ACTION': 'needs_action',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  TENTATIVE: 'tentative',
};

/** Properties kept verbatim for round trips; everything else we model or drop. */
const KEPT = ['CATEGORIES', 'URL', 'COLOR', 'PRIORITY'];

export function parseIcs(text: string, fallbackTz: string): ParseResult | null {
  const cal = parseIcsTree(text);
  if (!cal) return null;
  const out: ParseResult = {
    events: [],
    errors: [],
    calendarName: prop(cal, 'X-WR-CALNAME')?.value ?? null,
  };
  for (const ve of cal.children.filter((c) => c.name === 'VEVENT')) {
    const uid = prop(ve, 'UID')?.value.trim() || null;
    const fail = (reason: string) => out.errors.push({ uid, reason });
    if (!uid) {
      fail('missing_uid');
      continue;
    }
    const dtstart = prop(ve, 'DTSTART');
    const start = dtstart ? parseIcsTime(dtstart, fallbackTz) : null;
    if (!start) {
      fail('missing_start');
      continue;
    }
    let end: IcsTime | null = null;
    const dtend = prop(ve, 'DTEND');
    if (dtend) end = parseIcsTime(dtend, fallbackTz);
    if (!end) {
      const dur = prop(ve, 'DURATION');
      const secs = dur ? parseIcsDuration(dur.value) : null;
      if (start.allDay) {
        const days = secs !== null ? Math.max(1, Math.round(secs / 86_400)) : 1;
        end = { allDay: true, date: dayToDate(dateToDay(start.date) + days) };
      } else {
        end = {
          allDay: false,
          at: new Date(start.at.getTime() + (secs ?? 0) * 1000),
          tz: start.tz,
        };
      }
    }
    if (end.allDay !== start.allDay) {
      // Mixed DATE / DATE-TIME: follow DTSTART.
      end = start.allDay
        ? { allDay: true, date: dayToDate(dateToDay(start.date) + 1) }
        : { allDay: false, at: new Date(start.at.getTime() + 3_600_000), tz: start.tz };
    }
    if (start.allDay && end.allDay && end.date <= start.date) {
      end = { allDay: true, date: dayToDate(dateToDay(start.date) + 1) };
    }
    if (!start.allDay && !end.allDay && end.at < start.at) end = { ...end, at: start.at };

    let rrule: string | null = null;
    const rr = prop(ve, 'RRULE');
    if (rr) {
      const parsed = parseRRule(rr.value);
      if (!parsed) {
        fail('unsupported_rrule');
        continue;
      }
      rrule = rr.value.trim().toUpperCase();
    }
    const exdates: string[] = [];
    for (const ex of ve.props.filter((p) => p.name === 'EXDATE')) {
      for (const v of ex.value.split(',')) {
        const t = parseIcsTime({ ...ex, value: v }, start.allDay ? 'UTC' : start.tz);
        if (t) exdates.push(t.allDay ? t.date : occurrenceKey(t.at, false));
      }
    }
    let recurrenceId: string | null = null;
    const rid = prop(ve, 'RECURRENCE-ID');
    if (rid) {
      const t = parseIcsTime(rid, start.allDay ? 'UTC' : start.tz);
      if (t) recurrenceId = t.allDay ? t.date : occurrenceKey(t.at, false);
    }

    const reminders: number[] = [];
    for (const alarm of ve.children.filter((c) => c.name === 'VALARM')) {
      const trigger = prop(alarm, 'TRIGGER');
      if (!trigger || trigger.params.VALUE === 'DATE-TIME') continue;
      if (trigger.params.RELATED === 'END') continue;
      const secs = parseIcsDuration(trigger.value);
      if (secs === null || secs > 0) continue;
      const min = Math.round(-secs / 60);
      if (min <= 40_320 && !reminders.includes(min)) reminders.push(min);
    }

    const attendees: IcsAttendee[] = [];
    for (const a of ve.props.filter((p) => p.name === 'ATTENDEE')) {
      const email = mailto(a.value);
      if (!email.includes('@')) continue;
      attendees.push({
        email,
        name: a.params.CN ?? null,
        partstat: PARTSTAT[(a.params.PARTSTAT ?? '').toUpperCase()] ?? 'needs_action',
        optional: (a.params.ROLE ?? '').toUpperCase() === 'OPT-PARTICIPANT',
      });
    }
    const status = (prop(ve, 'STATUS')?.value ?? '').toUpperCase();
    const extra: Record<string, string> = {};
    for (const k of KEPT) {
      const p = prop(ve, k);
      if (p) extra[k] = p.value;
    }
    const text = (name: string) => {
      const p = prop(ve, name);
      return p ? unescapeText(p.value).slice(0, name === 'DESCRIPTION' ? 10_000 : 500) : null;
    };
    out.events.push({
      uid: uid.slice(0, 255),
      recurrenceId,
      title: (text('SUMMARY') ?? '').trim().slice(0, 200) || '—',
      description: text('DESCRIPTION'),
      location: text('LOCATION'),
      allDay: start.allDay,
      start: start.allDay ? start.date : start.at,
      end: end.allDay ? end.date : end.at,
      timeZone: start.allDay ? fallbackTz : start.tz,
      rrule,
      exdates,
      status:
        status === 'CANCELLED' ? 'cancelled' : status === 'TENTATIVE' ? 'tentative' : 'confirmed',
      busy: (prop(ve, 'TRANSP')?.value ?? '').toUpperCase() !== 'TRANSPARENT',
      visibility: ['PRIVATE', 'CONFIDENTIAL'].includes(
        (prop(ve, 'CLASS')?.value ?? '').toUpperCase(),
      )
        ? 'private'
        : 'default',
      sequence: Number(prop(ve, 'SEQUENCE')?.value ?? 0) || 0,
      reminders: ve.children.some((c) => c.name === 'VALARM') ? reminders : null,
      organizerEmail: prop(ve, 'ORGANIZER') ? mailto(prop(ve, 'ORGANIZER')!.value) : null,
      attendees,
      extra,
    });
  }
  return out;
}

// ---- writing --------------------------------------------------------------------------------------

const offsetText = (ms: number) => {
  const sign = ms < 0 ? '-' : '+';
  const abs = Math.abs(Math.round(ms / 60_000));
  return `${sign}${two(Math.floor(abs / 60))}${two(abs % 60)}`;
};

/** Finds the instant in (lo, hi] where the zone's offset changes (hi has the new offset). */
function findTransition(lo: number, hi: number, tz: string): number {
  const target = zoneOffsetMs(hi, tz);
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (zoneOffsetMs(mid, tz) === target) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * VTIMEZONE for an IANA zone from the runtime's data: the transitions of `year` as yearly
 * rules (nth or last weekday of the month), or a single STANDARD block without DST.
 */
export function buildVtimezone(tz: string, year: number): string[] {
  if (tz === 'UTC') return [];
  const transitions: { at: number; from: number; to: number }[] = [];
  let prev = Date.UTC(year, 0, 1);
  let prevOffset = zoneOffsetMs(prev, tz);
  for (let m = 1; m <= 12; m++) {
    const next = Date.UTC(m === 12 ? year + 1 : year, m % 12, 1);
    const off = zoneOffsetMs(next, tz);
    if (off !== prevOffset) {
      // Days are enough resolution for the search start, minutes for the result.
      transitions.push({ at: findTransition(prev, next, tz), from: prevOffset, to: off });
      prevOffset = off;
    }
    prev = next;
  }
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tz}`];
  if (transitions.length === 0) {
    const off = offsetText(zoneOffsetMs(Date.UTC(year, 0, 1), tz));
    lines.push(
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      `TZOFFSETFROM:${off}`,
      `TZOFFSETTO:${off}`,
      'END:STANDARD',
    );
  } else {
    for (const t of transitions) {
      // Local wall time just before the change, in the old offset.
      const local = new Date(t.at + t.from);
      const y = local.getUTCFullYear();
      const month = local.getUTCMonth() + 1;
      const day = local.getUTCDate();
      const dn = dayNumber(y, month, day);
      const nth = day + 7 > daysInMonthOf(y, month) ? -1 : Math.ceil(day / 7);
      const wd = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][weekdayOfDay(dn)];
      const kind = t.to > t.from ? 'DAYLIGHT' : 'STANDARD';
      lines.push(
        `BEGIN:${kind}`,
        `DTSTART:1970${two(month)}${two(Math.min(day, 28))}T${two(local.getUTCHours())}${two(local.getUTCMinutes())}00`,
        `RRULE:FREQ=YEARLY;BYMONTH=${month};BYDAY=${nth}${wd}`,
        `TZOFFSETFROM:${offsetText(t.from)}`,
        `TZOFFSETTO:${offsetText(t.to)}`,
        `END:${kind}`,
      );
    }
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

export interface IcsOutEvent {
  uid: string;
  recurrenceId: string | null;
  title: string;
  description: string | null;
  location: string | null;
  allDay: boolean;
  start: string | Date;
  end: string | Date;
  timeZone: string;
  rrule: string | null;
  exdates: string[];
  status: 'confirmed' | 'tentative' | 'cancelled';
  busy: boolean;
  visibility: 'default' | 'private';
  sequence: number;
  reminders: number[];
  organizer: { name: string | null; email: string } | null;
  attendees: (IcsAttendee & { name: string | null })[];
  created: Date;
  updated: Date;
  url?: string | null;
  extra?: Record<string, string> | null;
}

const PARTSTAT_OUT: Record<IcsAttendee['partstat'], string> = {
  needs_action: 'NEEDS-ACTION',
  accepted: 'ACCEPTED',
  declined: 'DECLINED',
  tentative: 'TENTATIVE',
};

const quote = (s: string) => `"${s.replace(/"/g, "'")}"`;

function timeLine(name: string, value: string | Date, allDay: boolean, tz: string) {
  if (allDay) return `${name};VALUE=DATE:${dateValue(value as string)}`;
  if (tz === 'UTC') return `${name}:${stampUtc(value as Date)}`;
  return `${name};TZID=${tz}:${localStamp(value as Date, tz)}`;
}

function recurrenceLine(name: string, key: string, allDay: boolean, tz: string) {
  if (allDay) return `${name};VALUE=DATE:${dateValue(key)}`;
  return timeLine(name, new Date(key), false, tz);
}

function eventLines(e: IcsOutEvent, now: Date): string[] {
  const tz = e.allDay ? 'UTC' : e.timeZone;
  const lines = [
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${stampUtc(now)}`,
    `CREATED:${stampUtc(e.created)}`,
    `LAST-MODIFIED:${stampUtc(e.updated)}`,
    `SEQUENCE:${e.sequence}`,
  ];
  if (e.recurrenceId) lines.push(recurrenceLine('RECURRENCE-ID', e.recurrenceId, e.allDay, tz));
  lines.push(timeLine('DTSTART', e.start, e.allDay, tz), timeLine('DTEND', e.end, e.allDay, tz));
  if (e.rrule) lines.push(`RRULE:${e.rrule}`);
  for (const ex of e.exdates) lines.push(recurrenceLine('EXDATE', ex, e.allDay, tz));
  lines.push(`SUMMARY:${escapeText(e.title)}`);
  if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
  if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
  if (e.url) lines.push(`URL:${e.url}`);
  lines.push(`STATUS:${e.status.toUpperCase()}`);
  lines.push(`TRANSP:${e.busy ? 'OPAQUE' : 'TRANSPARENT'}`);
  if (e.visibility === 'private') lines.push('CLASS:PRIVATE');
  if (e.organizer) {
    const cn = e.organizer.name ? `;CN=${quote(e.organizer.name)}` : '';
    lines.push(`ORGANIZER${cn}:mailto:${e.organizer.email}`);
  }
  for (const a of e.attendees) {
    const cn = a.name ? `;CN=${quote(a.name)}` : '';
    const role = a.optional ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT';
    lines.push(
      `ATTENDEE${cn};ROLE=${role};PARTSTAT=${PARTSTAT_OUT[a.partstat]};RSVP=TRUE:mailto:${a.email}`,
    );
  }
  for (const [k, v] of Object.entries(e.extra ?? {})) {
    if (KEPT.includes(k) && !(k === 'URL' && e.url)) lines.push(`${k}:${v}`);
  }
  for (const m of e.reminders) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(e.title)}`,
      `TRIGGER:-PT${m}M`,
      'END:VALARM',
    );
  }
  lines.push('END:VEVENT');
  return lines;
}

/** A VCALENDAR with the events (a series and its overrides share a UID) and their zones. */
export function buildIcs(input: {
  events: IcsOutEvent[];
  method?: 'REQUEST' | 'CANCEL' | 'PUBLISH';
  name?: string | null;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Crewhall//Calendar//EN',
    'CALSCALE:GREGORIAN',
  ];
  if (input.method) lines.push(`METHOD:${input.method}`);
  if (input.name) lines.push(`X-WR-CALNAME:${escapeText(input.name)}`);
  const zones = new Map<string, number>();
  for (const e of input.events) {
    if (e.allDay || e.timeZone === 'UTC') continue;
    const y = civilFromDay(Math.floor((e.start as Date).getTime() / 86_400_000)).year;
    if (!zones.has(e.timeZone)) zones.set(e.timeZone, y);
  }
  for (const [tz, year] of zones) lines.push(...buildVtimezone(tz, year));
  for (const e of input.events) lines.push(...eventLines(e, now));
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
