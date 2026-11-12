import { parseXml, type XmlElement } from '../../src/services/calendar/xml';
import type { EwsConnection } from '../../src/services/calendar/external/ews/soap';

/**
 * Plays an on-premises Exchange server at the SOAP level: it reads the XML Crewhall sends and
 * answers in EWS's own shapes. Like the real one it checks the schema's element order and keeps a
 * ChangeKey per item. Shapes come from Microsoft's EWS reference; no real server took part.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s: string) => esc(s).replace(/"/g, '&quot;');

/** Element order of the types (XSD sequences), as far as Crewhall writes them. */
const ORDER: Record<string, string[]> = {
  CalendarItem: [
    'Subject',
    'Sensitivity',
    'Body',
    'Categories',
    'Start',
    'End',
    'IsAllDayEvent',
    'LegacyFreeBusyStatus',
    'Location',
    'RequiredAttendees',
    'OptionalAttendees',
    'Recurrence',
    'StartTimeZone',
    'EndTimeZone',
  ],
  Contact: [
    'Subject',
    'Body',
    'Categories',
    'DisplayName',
    'GivenName',
    'CompanyName',
    'EmailAddresses',
    'PhysicalAddresses',
    'PhoneNumbers',
    'Birthday',
    'BusinessHomePage',
    'JobTitle',
    'Surname',
  ],
};

function serialize(el: XmlElement): string {
  const attrs = Object.entries(el.attrs)
    .filter(([k]) => !k.startsWith('xmlns'))
    .map(([k, v]) => ` ${k}="${attr(v)}"`)
    .join('');
  const inner = el.children.length ? el.children.map(serialize).join('') : esc(el.text);
  return `<t:${el.name}${attrs}>${inner}</t:${el.name}>`;
}

export interface FakeItem {
  id: string;
  folder: string;
  kind: 'CalendarItem' | 'Contact' | 'DistributionList';
  changeKey: string;
  /** Field name → element as XML (without ItemId). */
  fields: Map<string, string>;
  /** Occurrences: the series item. */
  masterId?: string;
}

const message = (name: string, inner: string) =>
  `<m:${name} ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>${inner}</m:${name}>`;
const failure = (name: string, code: string) =>
  `<m:${name} ResponseClass="Error"><m:MessageText>${code}</m:MessageText><m:ResponseCode>${code}</m:ResponseCode></m:${name}>`;

export class FakeExchange {
  items = new Map<string, FakeItem>();
  password = 'exchange-test-pass';
  /** Every request's operation, in order. */
  ops: string[] = [];
  /** Every request's XML. */
  requests: string[] = [];
  /** Connections used. */
  connections: EwsConnection[] = [];
  /** Responses sent to meeting invitations. */
  responses: { tag: string; id: string }[] = [];
  /** A calendar view holding more than this says it is too big. */
  viewLimit = 1000;
  /** Changes per SyncFolderItems answer. */
  syncPage = 512;
  failContacts: string | null = null;
  private seq = 0;
  private version = 0;
  private log: {
    folder: string;
    change: 'Create' | 'Update' | 'Delete';
    id: string;
    at: number;
  }[] = [];

  reset() {
    this.items.clear();
    this.ops = [];
    this.requests = [];
    this.connections = [];
    this.responses = [];
    this.viewLimit = 1000;
    this.syncPage = 512;
    this.failContacts = null;
    this.log = [];
  }

  private note(folder: string, change: 'Create' | 'Update' | 'Delete', id: string) {
    this.log.push({ folder, change, id, at: ++this.version });
  }

  /** Puts an item at the server, as someone working in Outlook would. */
  put(
    folder: string,
    kind: FakeItem['kind'],
    fields: Record<string, string>,
    opts: { id?: string; masterId?: string } = {},
  ) {
    const id = opts.id ?? `item-${++this.seq}`;
    const existing = this.items.get(id);
    const map = existing?.fields ?? new Map<string, string>();
    for (const [k, v] of Object.entries(fields)) map.set(k, v);
    this.items.set(id, {
      id,
      folder,
      kind,
      changeKey: `ck-${++this.seq}`,
      fields: map,
      masterId: opts.masterId ?? existing?.masterId,
    });
    this.note(folder, existing ? 'Update' : 'Create', id);
    return id;
  }

  /** Changes fields of an item as someone else would. */
  touch(id: string, fields: Record<string, string>) {
    const item = this.items.get(id)!;
    this.put(item.folder, item.kind, fields, { id });
    return this.items.get(id)!;
  }

  drop(id: string) {
    const item = this.items.get(id)!;
    this.items.delete(id);
    this.note(item.folder, 'Delete', id);
  }

  /** A field's text at the server. */
  field(id: string, name: string) {
    const raw = this.items.get(id)?.fields.get(name);
    if (raw === undefined) return undefined;
    const el = parseXml(raw.replace(/<t:/g, '<').replace(/<\/t:/g, '</'));
    return el?.text.trim();
  }

  transport = async (conn: EwsConnection, xml: string) => {
    this.connections.push(conn);
    if (conn.password !== this.password) return { status: 401, text: '' };
    this.requests.push(xml);
    const root = parseXml(xml);
    const body = root?.children.find((c) => c.name === 'Body')?.children[0];
    if (!body) return { status: 500, text: 'no body' };
    this.ops.push(body.name);
    const handlers: Record<string, (b: XmlElement) => string> = {
      GetFolder: () => this.getFolder(),
      FindFolder: () => this.findFolder(),
      SyncFolderItems: (b) => this.syncFolderItems(b),
      FindItem: (b) => this.findItem(b),
      GetItem: (b) => this.getItem(b),
      CreateItem: (b) => this.createItem(b),
      UpdateItem: (b) => this.updateItem(b),
      DeleteItem: (b) => this.deleteItem(b),
    };
    const run = handlers[body.name];
    if (!run) return { status: 500, text: `unknown ${body.name}` };
    const messages = run(body);
    return {
      status: 200,
      text:
        `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
        `<m:${body.name}Response xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><m:ResponseMessages>${messages}</m:ResponseMessages></m:${body.name}Response></s:Body></s:Envelope>`,
    };
  };

  private calendarFolder = (id: string, name: string) =>
    `<t:CalendarFolder><t:FolderId Id="${id}" ChangeKey="f1"/><t:DisplayName>${name}</t:DisplayName><t:EffectiveRights><t:CreateContents>true</t:CreateContents></t:EffectiveRights></t:CalendarFolder>`;

  private getFolder() {
    return message(
      'GetFolderResponseMessage',
      `<m:Folders>${this.calendarFolder('cal-main', 'Takvim')}</m:Folders>`,
    );
  }

  private findFolder() {
    return message(
      'FindFolderResponseMessage',
      `<m:RootFolder IncludesLastItemInRange="true"><t:Folders>${this.calendarFolder('cal-team', 'Ekip')}<t:ContactsFolder><t:FolderId Id="nope"/></t:ContactsFolder></t:Folders></m:RootFolder>`,
    );
  }

  private folderOf(el: XmlElement | undefined) {
    const ref = el?.children[0];
    const id = ref?.attrs.Id ?? '';
    return id === 'calendar' ? 'cal-main' : id;
  }

  private syncFolderItems(b: XmlElement) {
    const folder = this.folderOf(b.children.find((c) => c.name === 'SyncFolderId'));
    const state = b.children.find((c) => c.name === 'SyncState')?.text;
    if (folder === 'contacts' && this.failContacts) {
      return failure('SyncFolderItemsResponseMessage', this.failContacts);
    }
    if (state === 'bad-state' || (state && !/^s-\d+$/.test(state))) {
      return failure('SyncFolderItemsResponseMessage', 'ErrorInvalidSyncStateData');
    }
    const since = state ? Number(state.slice(2)) : 0;
    const pending = this.log.filter((l) => l.folder === folder && l.at > since);
    // A first sync lists what is there, not the history.
    const relevant = pending.filter((l) => state || l.change !== 'Delete');
    const page = relevant.slice(0, this.syncPage);
    const last = page.at(-1)?.at ?? this.version;
    const changes = page
      .map((l) => {
        if (l.change === 'Delete') return `<t:Delete><t:ItemId Id="${attr(l.id)}"/></t:Delete>`;
        const item = this.items.get(l.id);
        if (!item) return '';
        return `<t:${l.change}><t:${item.kind}><t:ItemId Id="${attr(item.id)}" ChangeKey="${attr(item.changeKey)}"/></t:${item.kind}></t:${l.change}>`;
      })
      .join('');
    const done = page.length === relevant.length;
    return message(
      'SyncFolderItemsResponseMessage',
      `<m:SyncState>s-${done ? this.version : last}</m:SyncState><m:IncludesLastItemInRange>${done}</m:IncludesLastItemInRange><m:Changes>${changes}</m:Changes>`,
    );
  }

  private findItem(b: XmlElement) {
    const view = b.children.find((c) => c.name === 'CalendarView');
    const folder = this.folderOf(b.children.find((c) => c.name === 'ParentFolderIds'));
    const from = Date.parse(view?.attrs.StartDate ?? '');
    const to = Date.parse(view?.attrs.EndDate ?? '');
    const inside = [...this.items.values()].filter((i) => {
      if (i.folder !== folder || i.kind !== 'CalendarItem') return false;
      // A view expands series: their masters are not items of it.
      if (this.field(i.id, 'CalendarItemType') === 'RecurringMaster') return false;
      const start = Date.parse(this.field(i.id, 'Start') ?? '');
      return start < to && Date.parse(this.field(i.id, 'End') ?? '') > from;
    });
    const count = inside.length;
    if (count > this.viewLimit) {
      return message(
        'FindItemResponseMessage',
        `<m:RootFolder TotalItemsInView="${count}" IncludesLastItemInRange="false"><t:Items/></m:RootFolder>`,
      );
    }
    const items = inside
      .map(
        (i) =>
          `<t:CalendarItem><t:ItemId Id="${attr(i.id)}" ChangeKey="${attr(i.changeKey)}"/></t:CalendarItem>`,
      )
      .join('');
    return message(
      'FindItemResponseMessage',
      `<m:RootFolder TotalItemsInView="${count}" IncludesLastItemInRange="true"><t:Items>${items}</t:Items></m:RootFolder>`,
    );
  }

  private render(item: FakeItem) {
    return `<t:${item.kind}><t:ItemId Id="${attr(item.id)}" ChangeKey="${attr(item.changeKey)}"/>${[...item.fields.values()].join('')}</t:${item.kind}>`;
  }

  private getItem(b: XmlElement) {
    const ids = b.children.find((c) => c.name === 'ItemIds')?.children ?? [];
    return ids
      .map((ref) => {
        if (ref.name === 'RecurringMasterItemId') {
          const occ = this.items.get(ref.attrs.OccurrenceId ?? '');
          const master = occ?.masterId ? this.items.get(occ.masterId) : null;
          return master
            ? message(
                'GetItemResponseMessage',
                `<m:Items><t:CalendarItem><t:ItemId Id="${attr(master.id)}" ChangeKey="${attr(master.changeKey)}"/></t:CalendarItem></m:Items>`,
              )
            : failure('GetItemResponseMessage', 'ErrorItemNotFound');
        }
        const item = this.items.get(ref.attrs.Id ?? '');
        return item
          ? message('GetItemResponseMessage', `<m:Items>${this.render(item)}</m:Items>`)
          : failure('GetItemResponseMessage', 'ErrorItemNotFound');
      })
      .join('');
  }

  private checkOrder(el: XmlElement) {
    const order = ORDER[el.name];
    if (!order) return;
    let at = -1;
    for (const c of el.children) {
      const i = order.indexOf(c.name);
      if (i < 0) throw new Error(`unexpected ${c.name} in ${el.name}`);
      if (i <= at) throw new Error(`${c.name} is out of schema order in ${el.name}`);
      at = i;
    }
  }

  private createItem(b: XmlElement) {
    const items = b.children.find((c) => c.name === 'Items')?.children ?? [];
    const folder = this.folderOf(b.children.find((c) => c.name === 'SavedItemFolderId'));
    return items
      .map((el) => {
        if (['AcceptItem', 'DeclineItem', 'TentativelyAcceptItem'].includes(el.name)) {
          const id = el.children.find((c) => c.name === 'ReferenceItemId')?.attrs.Id ?? '';
          if (!this.items.has(id)) return failure('CreateItemResponseMessage', 'ErrorItemNotFound');
          this.responses.push({ tag: el.name, id });
          return message('CreateItemResponseMessage', '<m:Items/>');
        }
        try {
          this.checkOrder(el);
        } catch (err) {
          return failure('CreateItemResponseMessage', `ErrorSchemaValidation: ${String(err)}`);
        }
        const fields: Record<string, string> = {};
        for (const c of el.children) fields[c.name] = serialize(c);
        const id = this.put(folder, el.name as FakeItem['kind'], fields);
        const item = this.items.get(id)!;
        return message(
          'CreateItemResponseMessage',
          `<m:Items><t:${el.name}><t:ItemId Id="${attr(id)}" ChangeKey="${attr(item.changeKey)}"/></t:${el.name}></m:Items>`,
        );
      })
      .join('');
  }

  private updateItem(b: XmlElement) {
    const mode = b.attrs.ConflictResolution;
    const changes = b.children.find((c) => c.name === 'ItemChanges')?.children ?? [];
    return changes
      .map((change) => {
        const ref = change.children.find((c) => c.name === 'ItemId');
        const item = this.items.get(ref?.attrs.Id ?? '');
        if (!item) return failure('UpdateItemResponseMessage', 'ErrorItemNotFound');
        if (mode !== 'AlwaysOverwrite') {
          if (!ref?.attrs.ChangeKey) {
            return failure('UpdateItemResponseMessage', 'ErrorChangeKeyRequiredForWriteOperations');
          }
          if (ref.attrs.ChangeKey !== item.changeKey) {
            return failure('UpdateItemResponseMessage', 'ErrorIrresolvableConflict');
          }
        }
        for (const u of change.children.find((c) => c.name === 'Updates')?.children ?? []) {
          const uri = u.children.find((c) => c.name.endsWith('FieldURI'));
          const name = (uri?.attrs.FieldURI ?? '').split(':')[1] ?? '';
          const index = uri?.attrs.FieldIndex;
          if (u.name === 'DeleteItemField') {
            if (index) this.clearIndexed(item, name, index);
            else item.fields.delete(name);
            continue;
          }
          const value = u.children.find((c) => c.name === item.kind)?.children[0];
          if (!value) continue;
          if (index) this.setIndexed(item, value);
          else item.fields.set(value.name, serialize(value));
        }
        item.changeKey = `ck-${++this.seq}`;
        this.note(item.folder, 'Update', item.id);
        return message(
          'UpdateItemResponseMessage',
          `<m:Items><t:${item.kind}><t:ItemId Id="${attr(item.id)}" ChangeKey="${attr(item.changeKey)}"/></t:${item.kind}></m:Items>`,
        );
      })
      .join('');
  }

  /** The whole list of an indexed field, as parsed elements. */
  private entries(item: FakeItem, tag: string) {
    const raw = item.fields.get(tag);
    if (!raw) return [];
    return (
      parseXml(raw.replace(/<t:/g, '<').replace(/<\/t:/g, '</'))?.children.map((c) => ({
        key: c.attrs.Key ?? '',
        xml: serialize(c),
      })) ?? []
    );
  }

  private writeEntries(item: FakeItem, tag: string, list: { key: string; xml: string }[]) {
    if (list.length)
      item.fields.set(tag, `<t:${tag}>${list.map((e) => e.xml).join('')}</t:${tag}>`);
    else item.fields.delete(tag);
  }

  private setIndexed(item: FakeItem, value: XmlElement) {
    const entry = value.children[0];
    if (!entry) return;
    const key = entry.attrs.Key ?? '';
    const list = this.entries(item, value.name).filter((e) => e.key !== key);
    list.push({ key, xml: serialize(entry) });
    this.writeEntries(item, value.name, list);
  }

  private clearIndexed(item: FakeItem, field: string, key: string) {
    const tag =
      field === 'EmailAddress'
        ? 'EmailAddresses'
        : field === 'PhoneNumber'
          ? 'PhoneNumbers'
          : 'PhysicalAddresses';
    this.writeEntries(
      item,
      tag,
      this.entries(item, tag).filter((e) => e.key !== key),
    );
  }

  private deleteItem(b: XmlElement) {
    const ids = b.children.find((c) => c.name === 'ItemIds')?.children ?? [];
    return ids
      .map((ref) => {
        if (!this.items.has(ref.attrs.Id ?? '')) {
          return failure('DeleteItemResponseMessage', 'ErrorItemNotFound');
        }
        this.drop(ref.attrs.Id!);
        return message('DeleteItemResponseMessage', '');
      })
      .join('');
  }
}

/** Shorthands for fields at the fake server. */
export const f = {
  text: (name: string, value: string) => `<t:${name}>${esc(value)}</t:${name}>`,
  mailbox: (name: string, email: string) =>
    `<t:Mailbox><t:Name>${esc(name)}</t:Name><t:EmailAddress>${esc(email)}</t:EmailAddress><t:RoutingType>SMTP</t:RoutingType></t:Mailbox>`,
  attendee: (name: string, email: string, response: string) =>
    `<t:Attendee>${f.mailbox(name, email)}<t:ResponseType>${response}</t:ResponseType></t:Attendee>`,
};
