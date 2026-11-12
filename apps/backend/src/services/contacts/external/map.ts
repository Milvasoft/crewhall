import { z } from 'zod';
import type { contacts, ContactEmailData, ContactPhoneData } from '@crewhall/db';
import { displayNameOf, normTags } from '../contacts';
import { CONTACT_SLOTS, type ExtContact, type ExtContactFields } from './types';

/**
 * Crewhall's contact and the provider's. Phones and e-mails have no room for everything there
 * (three addresses, two work and two home numbers, one mobile, no fax): what does not fit stays
 * in Crewhall and survives the provider's version coming back. Kind stays in Crewhall only.
 */

export type ContactRow = typeof contacts.$inferSelect;

type Fields = Pick<
  ContactRow,
  | 'firstName'
  | 'lastName'
  | 'displayName'
  | 'jobTitle'
  | 'emails'
  | 'phones'
  | 'address'
  | 'website'
  | 'birthday'
  | 'notes'
  | 'tags'
>;

const Email = z.email().max(254);
const cut = (v: string | null, max: number) => (v ? v.slice(0, max) : null);
const lower = (v: string) => v.toLocaleLowerCase('en');

function phonesOfType(phones: ContactPhoneData[], type: ContactPhoneData['type']) {
  return phones.filter((p) => p.type === type).map((p) => p.value);
}

/** The whole contact as the provider should hold it. */
export function extFieldsOf(row: Fields, company: string | null): ExtContactFields {
  return {
    firstName: row.firstName,
    lastName: row.lastName,
    displayName: row.displayName,
    company,
    jobTitle: row.jobTitle,
    emails: row.emails.slice(0, CONTACT_SLOTS.emails).map((e) => e.value),
    workPhones: phonesOfType(row.phones, 'work').slice(0, CONTACT_SLOTS.workPhones),
    homePhones: phonesOfType(row.phones, 'home').slice(0, CONTACT_SLOTS.homePhones),
    mobilePhone: phonesOfType(row.phones, 'mobile')[0] ?? null,
    address: row.address,
    website: row.website,
    birthday: row.birthday,
    notes: row.notes,
    categories: row.tags,
  };
}

/** What changed between two local versions, for the provider. The name always goes along. */
export function extPatch(before: ExtContactFields, after: ExtContactFields) {
  const patch: Partial<ExtContactFields> = {};
  for (const k of Object.keys(after) as (keyof ExtContactFields)[]) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      (patch as Record<string, unknown>)[k] = after[k];
    }
  }
  if (Object.keys(patch).length) patch.displayName = after.displayName;
  return patch;
}

/** Local columns for a provider's contact; `current` keeps types and what has no room there. */
export function localFields(ext: ExtContact, current: Fields | null): Fields {
  const seenEmails = new Set<string>();
  const emails: ContactEmailData[] = [];
  for (const value of ext.emails) {
    if (!Email.safeParse(value).success || seenEmails.has(lower(value))) continue;
    seenEmails.add(lower(value));
    const known = current?.emails.find((e) => lower(e.value) === lower(value));
    emails.push({ type: known?.type ?? 'work', value });
  }
  for (const e of current?.emails.slice(CONTACT_SLOTS.emails) ?? []) {
    if (!seenEmails.has(lower(e.value))) emails.push(e);
  }

  const phones: ContactPhoneData[] = [
    ...ext.workPhones.map((value) => ({ type: 'work' as const, value })),
    ...ext.homePhones.map((value) => ({ type: 'home' as const, value })),
    ...(ext.mobilePhone ? [{ type: 'mobile' as const, value: ext.mobilePhone }] : []),
  ].map((p) => ({ ...p, value: p.value.slice(0, 40) }));
  if (current) {
    const overflow = [
      ...current.phones.filter((p) => p.type === 'fax' || p.type === 'other'),
      ...current.phones.filter((p) => p.type === 'work').slice(CONTACT_SLOTS.workPhones),
      ...current.phones.filter((p) => p.type === 'home').slice(CONTACT_SLOTS.homePhones),
      ...current.phones.filter((p) => p.type === 'mobile').slice(CONTACT_SLOTS.mobile),
    ];
    for (const p of overflow) if (!phones.some((x) => x.value === p.value)) phones.push(p);
  }

  const firstName = cut(ext.firstName, 80);
  const lastName = cut(ext.lastName, 80);
  return {
    firstName,
    lastName,
    displayName: displayNameOf({
      displayName:
        ext.displayName || (firstName || lastName ? null : (ext.company ?? ext.emails[0] ?? null)),
      firstName,
      lastName,
    }),
    jobTitle: cut(ext.jobTitle, 120),
    emails: emails.slice(0, 10),
    phones: phones.slice(0, 10),
    address: cut(ext.address, 500),
    website: cut(ext.website, 300),
    birthday: ext.birthday,
    notes: cut(ext.notes, 5000),
    tags: normTags(ext.categories.map((c) => c.slice(0, 40))).slice(0, 30),
  };
}
