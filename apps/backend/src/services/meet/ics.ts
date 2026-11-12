import type { MeetingRecurrence } from '@crewhall/shared';

/**
 * iCalendar invitations (RFC 5545 / iTIP RFC 5546) for scheduled meetings (doc 17 §15
 * item 12: no calendar integration in v1, an .ics goes out by e-mail). The UID stays the
 * same for a meeting; SEQUENCE grows on every change so calendars replace the event.
 */
export interface IcsEvent {
  method: 'REQUEST' | 'CANCEL';
  uid: string;
  sequence: number;
  start: Date;
  durationMinutes: number;
  recurrence: MeetingRecurrence;
  title: string;
  description: string;
  url: string;
  organizer: { name: string; email: string };
  attendees: { name: string | null; email: string }[];
  now?: Date;
}

const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/** TEXT escaping: backslash, semicolon, comma, newline. */
export const escapeText = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

const quoteParam = (s: string) => `"${s.replace(/"/g, "'")}"`;

/** Lines longer than 75 octets continue on the next line after CRLF + space. */
export function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
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

const RRULE: Record<MeetingRecurrence, string | null> = {
  none: null,
  daily: 'FREQ=DAILY',
  weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  weekly: 'FREQ=WEEKLY',
};

export function buildIcs(e: IcsEvent): string {
  const end = new Date(e.start.getTime() + e.durationMinutes * 60_000);
  const rrule = RRULE[e.recurrence];
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Crewhall//Meet//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${e.method}`,
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `SEQUENCE:${e.sequence}`,
    `DTSTAMP:${stamp(e.now ?? new Date())}`,
    `DTSTART:${stamp(e.start)}`,
    `DTEND:${stamp(end)}`,
    ...(rrule ? [`RRULE:${rrule}`] : []),
    `SUMMARY:${escapeText(e.title)}`,
    `DESCRIPTION:${escapeText(e.description)}`,
    `LOCATION:${escapeText(e.url)}`,
    `URL:${e.url}`,
    `ORGANIZER;CN=${quoteParam(e.organizer.name)}:mailto:${e.organizer.email}`,
    ...e.attendees.map(
      (a) =>
        `ATTENDEE;${a.name ? `CN=${quoteParam(a.name)};` : ''}ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.email}`,
    ),
    `STATUS:${e.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}
