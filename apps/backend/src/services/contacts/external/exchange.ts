import { ProviderError } from '../../calendar/external/http';
import {
  childOf,
  el,
  getItems,
  itemIdXml,
  single,
  syncFolder,
  textOf,
  x,
  type EwsConnection,
} from '../../calendar/external/ews/soap';
import type { XmlElement } from '../../calendar/xml';
import type { ContactsClient, ExtContact, ExtContactFields } from './types';

/**
 * Personal contacts on on-premises Exchange: the default Contacts folder, SyncFolderItems for
 * changes and the ChangeKey for conflicts. Distribution lists in the folder are not contacts.
 */

const EMAIL_KEYS = ['EmailAddress1', 'EmailAddress2', 'EmailAddress3'];
const WORK_KEYS = ['BusinessPhone', 'BusinessPhone2'];
const HOME_KEYS = ['HomePhone', 'HomePhone2'];
const ADDRESS_KEYS = ['Business', 'Home', 'Other'];
const ADDRESS_PARTS = ['Street', 'City', 'State', 'CountryOrRegion', 'PostalCode'];

/** An entry of an indexed field by its key. */
const entry = (list: XmlElement | null, key: string) =>
  list?.children.find((c) => c.attrs.Key === key)?.text.trim() || null;

const dateOf = (v: string | null) => {
  const d = v?.slice(0, 10) ?? '';
  return /^(1[89]|20)\d{2}-\d{2}-\d{2}$/.test(d) ? d : null;
};

function addressOf(item: XmlElement) {
  const list = childOf(item, 'PhysicalAddresses');
  for (const key of ADDRESS_KEYS) {
    const a = list?.children.find((c) => c.attrs.Key === key);
    if (!a) continue;
    const place = [textOf(a, 'PostalCode'), textOf(a, 'City')].filter(Boolean).join(' ');
    const line = [textOf(a, 'Street'), place, textOf(a, 'State'), textOf(a, 'CountryOrRegion')]
      .map((p) => p?.trim())
      .filter(Boolean);
    if (line.length) return line.join(', ');
  }
  return null;
}

export function fromEws(item: XmlElement): ExtContact | null {
  const id = childOf(item, 'ItemId');
  if (!id?.attrs.Id) return null;
  const emails = childOf(item, 'EmailAddresses');
  const phones = childOf(item, 'PhoneNumbers');
  const pick = (keys: string[]) =>
    keys.map((k) => entry(phones, k)).filter((p): p is string => Boolean(p));
  return {
    id: id.attrs.Id,
    etag: id.attrs.ChangeKey ?? null,
    firstName: textOf(item, 'GivenName'),
    lastName: textOf(item, 'Surname'),
    displayName: textOf(item, 'DisplayName'),
    company: textOf(item, 'CompanyName'),
    jobTitle: textOf(item, 'JobTitle'),
    emails: EMAIL_KEYS.map((k) => entry(emails, k)).filter((e): e is string => Boolean(e)),
    workPhones: pick(WORK_KEYS),
    homePhones: pick(HOME_KEYS),
    mobilePhone: entry(phones, 'MobilePhone'),
    address: addressOf(item),
    website: textOf(item, 'BusinessHomePage'),
    birthday: dateOf(textOf(item, 'Birthday')),
    notes: textOf(item, 'Body'),
    categories: (childOf(item, 'Categories')?.children ?? [])
      .map((c) => c.text.trim())
      .filter(Boolean),
  };
}

const birthdayValue = (date: string) => `${date}T12:00:00Z`;
const bodyXml = (text: string | null) => `<t:Body BodyType="Text">${x(text ?? '')}</t:Body>`;
const categoriesXml = (list: string[]) =>
  `<t:Categories>${list.map((c) => `<t:String>${x(c)}</t:String>`).join('')}</t:Categories>`;

/** A new contact, its fields in schema order. */
export function contactXml(c: Partial<ExtContactFields>) {
  const indexed = (tag: string, entries: [string, string | undefined | null][]) => {
    const inner = entries
      .filter((e): e is [string, string] => Boolean(e[1]))
      .map(([k, v]) => `<t:Entry Key="${k}">${x(v)}</t:Entry>`)
      .join('');
    return inner ? `<t:${tag}>${inner}</t:${tag}>` : '';
  };
  return (
    `<t:Contact>` +
    (c.notes ? bodyXml(c.notes) : '') +
    (c.categories?.length ? categoriesXml(c.categories) : '') +
    el('DisplayName', c.displayName) +
    el('GivenName', c.firstName) +
    el('CompanyName', c.company) +
    indexed(
      'EmailAddresses',
      EMAIL_KEYS.map((k, i) => [k, c.emails?.[i]]),
    ) +
    (c.address
      ? `<t:PhysicalAddresses><t:Entry Key="Business"><t:Street>${x(c.address)}</t:Street></t:Entry></t:PhysicalAddresses>`
      : '') +
    indexed('PhoneNumbers', [
      ...WORK_KEYS.map((k, i): [string, string | undefined] => [k, c.workPhones?.[i]]),
      ...HOME_KEYS.map((k, i): [string, string | undefined] => [k, c.homePhones?.[i]]),
      ['MobilePhone', c.mobilePhone],
    ]) +
    (c.birthday ? `<t:Birthday>${birthdayValue(c.birthday)}</t:Birthday>` : '') +
    el('BusinessHomePage', c.website) +
    el('JobTitle', c.jobTitle) +
    el('Surname', c.lastName) +
    `</t:Contact>`
  );
}

const setField = (uri: string, inner: string) =>
  `<t:SetItemField><t:FieldURI FieldURI="${uri}"/><t:Contact>${inner}</t:Contact></t:SetItemField>`;
const clearField = (uri: string) =>
  `<t:DeleteItemField><t:FieldURI FieldURI="${uri}"/></t:DeleteItemField>`;
const setIndexed = (uri: string, key: string, tag: string, value: string) =>
  `<t:SetItemField><t:IndexedFieldURI FieldURI="${uri}" FieldIndex="${key}"/><t:Contact><t:${tag}><t:Entry Key="${key}">${x(value)}</t:Entry></t:${tag}></t:Contact></t:SetItemField>`;
const clearIndexed = (uri: string, key: string) =>
  `<t:DeleteItemField><t:IndexedFieldURI FieldURI="${uri}" FieldIndex="${key}"/></t:DeleteItemField>`;

/** The changes of an update. Lists write every slot: what is not sent stays at Exchange. */
export function contactUpdatesXml(p: Partial<ExtContactFields>) {
  const out: string[] = [];
  const scalar = (uri: string, tag: string, value: string | null | undefined) => {
    if (value === undefined) return;
    out.push(value ? setField(uri, el(tag, value)) : clearField(uri));
  };
  scalar('contacts:DisplayName', 'DisplayName', p.displayName);
  scalar('contacts:GivenName', 'GivenName', p.firstName);
  scalar('contacts:Surname', 'Surname', p.lastName);
  scalar('contacts:CompanyName', 'CompanyName', p.company);
  scalar('contacts:JobTitle', 'JobTitle', p.jobTitle);
  scalar('contacts:BusinessHomePage', 'BusinessHomePage', p.website);
  if (p.notes !== undefined) out.push(setField('item:Body', bodyXml(p.notes)));
  if (p.categories !== undefined) {
    out.push(
      p.categories.length
        ? setField('item:Categories', categoriesXml(p.categories))
        : clearField('item:Categories'),
    );
  }
  if (p.birthday !== undefined) {
    out.push(
      p.birthday
        ? setField('contacts:Birthday', `<t:Birthday>${birthdayValue(p.birthday)}</t:Birthday>`)
        : clearField('contacts:Birthday'),
    );
  }
  const slots = (uri: string, tag: string, keys: string[], values: string[] | undefined) => {
    if (values === undefined) return;
    keys.forEach((key, i) => {
      const v = values[i];
      out.push(v ? setIndexed(uri, key, tag, v) : clearIndexed(uri, key));
    });
  };
  slots('contacts:EmailAddress', 'EmailAddresses', EMAIL_KEYS, p.emails);
  slots('contacts:PhoneNumber', 'PhoneNumbers', WORK_KEYS, p.workPhones);
  slots('contacts:PhoneNumber', 'PhoneNumbers', HOME_KEYS, p.homePhones);
  if (p.mobilePhone !== undefined) {
    slots(
      'contacts:PhoneNumber',
      'PhoneNumbers',
      ['MobilePhone'],
      p.mobilePhone ? [p.mobilePhone] : [],
    );
  }
  if (p.address !== undefined) {
    // One line in Crewhall: the business address's street, whole. Clearing clears all of them.
    for (const key of p.address ? ['Business'] : ADDRESS_KEYS) {
      for (const part of ADDRESS_PARTS) {
        out.push(clearIndexed(`contacts:PhysicalAddress:${part}`, key));
      }
    }
    if (p.address) {
      out.push(
        `<t:SetItemField><t:IndexedFieldURI FieldURI="contacts:PhysicalAddress:Street" FieldIndex="Business"/><t:Contact><t:PhysicalAddresses><t:Entry Key="Business"><t:Street>${x(p.address)}</t:Street></t:Entry></t:PhysicalAddresses></t:Contact></t:SetItemField>`,
      );
    }
  }
  return out.join('');
}

const contactsOf = (items: XmlElement[]) =>
  items
    .filter((i) => i.name === 'Contact')
    .map(fromEws)
    .filter((c): c is ExtContact => Boolean(c));

export function exchangeContacts(connection: () => Promise<EwsConnection>): ContactsClient {
  const read = async (conn: EwsConnection, id: string) => {
    const [item] = contactsOf(await getItems(conn, [id]));
    return item ?? null;
  };
  const idIn = (msg: XmlElement) => childOf(childOf(msg, 'Items')?.children[0], 'ItemId')?.attrs.Id;

  return {
    async delta(cursor) {
      const conn = await connection();
      const changes = await syncFolder(conn, 'contacts', cursor);
      return {
        items: contactsOf(await getItems(conn, changes.changed)),
        removed: changes.deleted,
        cursor: changes.syncState,
        full: !cursor,
      };
    },

    async get(id) {
      return read(await connection(), id);
    },

    async create(input) {
      const conn = await connection();
      const msg = await single(
        conn,
        `<m:CreateItem><m:SavedItemFolderId><t:DistinguishedFolderId Id="contacts"/></m:SavedItemFolderId>` +
          `<m:Items>${contactXml(input)}</m:Items></m:CreateItem>`,
      );
      const id = idIn(msg);
      const fresh = id ? await read(conn, id) : null;
      if (!fresh) throw new ProviderError(500, 'no_item_id');
      return fresh;
    },

    async update(id, patch, opts) {
      const conn = await connection();
      const msg = await single(
        conn,
        `<m:UpdateItem ConflictResolution="${opts?.ifMatch ? 'NeverOverwrite' : 'AlwaysOverwrite'}">` +
          `<m:ItemChanges><t:ItemChange>${itemIdXml(id, opts?.ifMatch)}<t:Updates>${contactUpdatesXml(patch)}</t:Updates></t:ItemChange></m:ItemChanges></m:UpdateItem>`,
      );
      const fresh = await read(conn, idIn(msg) ?? id);
      if (!fresh) throw new ProviderError(404, 'ErrorItemNotFound');
      return fresh;
    },

    async remove(id) {
      try {
        await single(
          await connection(),
          `<m:DeleteItem DeleteType="MoveToDeletedItems"><m:ItemIds>${itemIdXml(id)}</m:ItemIds></m:DeleteItem>`,
        );
      } catch (err) {
        if (!(err instanceof ProviderError) || err.status !== 404) throw err;
      }
    },
  };
}
