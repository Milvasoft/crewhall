import type { ContactEmailData, ContactPhoneData } from '@crewhall/db';
import { escapeText, fold, parseIcsTree, unescapeText, type IcsComponent } from '../calendar/ics';

/**
 * vCard reading (3.0 and 4.0) and writing (3.0, what Apple, Google and Outlook all read) for
 * contact import/export and CardDAV. The line format is iCalendar's (RFC 6350 shares RFC 5545's
 * folding and escaping), so the iCalendar line parser is reused with a VCARD root.
 */

export interface CardData {
  uid: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  company: string | null;
  jobTitle: string | null;
  emails: ContactEmailData[];
  phones: ContactPhoneData[];
  address: string | null;
  website: string | null;
  birthday: string | null;
  notes: string | null;
  tags: string[];
  /** KIND:org cards are companies (vCard 4.0). */
  isCompany: boolean;
}

const splitStructured = (v: string) => v.split(/(?<!\\);/).map((x) => unescapeText(x).trim());

function typesOf(params: Record<string, string>) {
  const raw = params.TYPE ?? '';
  return raw
    .toLowerCase()
    .split(',')
    .map((x) => x.trim().replace(/^"|"$/g, ''));
}

const emailType = (t: string[]): ContactEmailData['type'] =>
  t.includes('home') ? 'home' : t.includes('work') || t.includes('internet') ? 'work' : 'other';

const phoneType = (t: string[]): ContactPhoneData['type'] =>
  t.includes('cell') || t.includes('mobile') || t.includes('iphone')
    ? 'mobile'
    : t.includes('fax')
      ? 'fax'
      : t.includes('home')
        ? 'home'
        : t.includes('work') || t.includes('voice') || t.includes('main')
          ? 'work'
          : 'other';

function birthdayOf(v: string): string | null {
  const m = /^(\d{4}|--)-?(\d{2})-?(\d{2})/.exec(v.trim());
  if (!m || m[1] === '--') return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Wraps a vCard stream so the iCalendar tree parser can read it. */
function tree(text: string): IcsComponent[] {
  const root = parseIcsTree(`BEGIN:VCALENDAR\r\n${text}\r\nEND:VCALENDAR`);
  return root?.children.filter((c) => c.name === 'VCARD') ?? [];
}

export function parseVcards(text: string): { cards: CardData[]; errors: string[] } {
  const cards: CardData[] = [];
  const errors: string[] = [];
  for (const v of tree(text)) {
    // Group prefixes (item1.EMAIL) carry the same properties.
    const props = v.props.map((p) => ({ ...p, name: p.name.replace(/^[^.]+\./, '') }));
    const get = (name: string) => props.find((p) => p.name === name);
    const n = get('N') ? splitStructured(get('N')!.value) : [];
    const fn = get('FN') ? unescapeText(get('FN')!.value).trim() : null;
    const org = get('ORG') ? splitStructured(get('ORG')!.value)[0] || null : null;
    const card: CardData = {
      uid:
        get('UID')
          ?.value.trim()
          .replace(/^urn:uuid:/i, '') || null,
      lastName: n[0] || null,
      firstName: n[1] || null,
      displayName: fn || null,
      company: org,
      jobTitle: get('TITLE') ? unescapeText(get('TITLE')!.value).trim() || null : null,
      emails: props
        .filter((p) => p.name === 'EMAIL')
        .map((p) => ({ type: emailType(typesOf(p.params)), value: p.value.trim().toLowerCase() }))
        .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.value))
        .slice(0, 10),
      phones: props
        .filter((p) => p.name === 'TEL')
        .map((p) => ({
          type: phoneType(typesOf(p.params)),
          value: p.value.replace(/^tel:/i, '').trim().slice(0, 40),
        }))
        .filter((x) => x.value)
        .slice(0, 10),
      address: (() => {
        const adr = get('ADR');
        if (!adr) return null;
        const parts = splitStructured(adr.value).filter(Boolean);
        return parts.length ? parts.join(', ').slice(0, 500) : null;
      })(),
      website: get('URL')?.value.trim().slice(0, 300) || null,
      birthday: get('BDAY') ? birthdayOf(get('BDAY')!.value) : null,
      notes: get('NOTE') ? unescapeText(get('NOTE')!.value).slice(0, 5000) || null : null,
      tags: get('CATEGORIES')
        ? get('CATEGORIES')!
            .value.split(/(?<!\\),/)
            .map((x) => unescapeText(x).trim().slice(0, 40))
            .filter(Boolean)
            .slice(0, 30)
        : [],
      isCompany:
        (get('KIND')?.value ?? '').toLowerCase() === 'org' ||
        (get('X-ABSHOWAS')?.value ?? '').toUpperCase() === 'COMPANY',
    };
    if (!card.displayName && !card.firstName && !card.lastName && !card.company) {
      errors.push(card.uid ?? 'card');
      continue;
    }
    cards.push(card);
  }
  return { cards, errors };
}

const EMAIL_TYPE: Record<ContactEmailData['type'], string> = {
  work: 'INTERNET,WORK',
  home: 'INTERNET,HOME',
  other: 'INTERNET',
};
const PHONE_TYPE: Record<ContactPhoneData['type'], string> = {
  work: 'WORK,VOICE',
  mobile: 'CELL',
  home: 'HOME,VOICE',
  fax: 'FAX',
  other: 'VOICE',
};

export interface CardOut {
  uid: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  department?: string | null;
  jobTitle: string | null;
  emails: ContactEmailData[];
  phones: ContactPhoneData[];
  address: string | null;
  website: string | null;
  birthday: string | null;
  notes: string | null;
  tags: string[];
  updated: Date;
  isCompany?: boolean;
}

/** One vCard 3.0 (CRLF lines, folded). */
export function buildVcard(c: CardOut): string {
  const stamp = c.updated
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'PRODID:-//Crewhall//Contacts//EN',
    `UID:${c.uid}`,
    `FN:${escapeText(c.displayName)}`,
    `N:${escapeText(c.lastName ?? '')};${escapeText(c.firstName ?? (c.lastName ? '' : c.displayName))};;;`,
  ];
  if (c.company || c.department) {
    lines.push(
      `ORG:${escapeText(c.company ?? '')}${c.department ? `;${escapeText(c.department)}` : ''}`,
    );
  }
  if (c.isCompany) lines.push('X-ABSHOWAS:COMPANY');
  if (c.jobTitle) lines.push(`TITLE:${escapeText(c.jobTitle)}`);
  for (const e of c.emails) lines.push(`EMAIL;TYPE=${EMAIL_TYPE[e.type]}:${e.value}`);
  for (const p of c.phones) lines.push(`TEL;TYPE=${PHONE_TYPE[p.type]}:${p.value}`);
  if (c.address) lines.push(`ADR;TYPE=WORK:;;${escapeText(c.address)};;;;`);
  if (c.website) lines.push(`URL:${c.website}`);
  if (c.birthday) lines.push(`BDAY:${c.birthday}`);
  if (c.notes) lines.push(`NOTE:${escapeText(c.notes)}`);
  if (c.tags.length) lines.push(`CATEGORIES:${c.tags.map(escapeText).join(',')}`);
  lines.push(`REV:${stamp}`, 'END:VCARD');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
