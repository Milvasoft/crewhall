import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { calendarAccounts, calendars, contacts, contactVersions } from '@crewhall/db';
import { recurrenceXml } from '../src/services/calendar/external/ews/calendar';
import { setEwsTransport, single } from '../src/services/calendar/external/ews/soap';
import { setCalendarFetch } from '../src/services/calendar/external/http';
import { syncAccount, syncDueAccounts } from '../src/services/calendar/external/sync';
import { Client, createTestApp, setupWithOwner, type TestApp } from './helpers';
import { f, FakeExchange } from './support/fake-exchange';

/** On-premises Exchange over EWS, calendar and contacts, against a fake SOAP server. */

const EWS_URL = 'https://mail.contoso.test/EWS/Exchange.asmx';
const DAY = 86_400_000;
/** Inside the sync window whatever day the tests run. */
const inDays = (days: number, hour = 7) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString().replace('.000Z', 'Z');
};

const timed = (subject: string, days = 5) => ({
  Subject: f.text('Subject', subject),
  Start: f.text('Start', inDays(days)),
  End: f.text('End', inDays(days, 8)),
  IsAllDayEvent: f.text('IsAllDayEvent', 'false'),
  LegacyFreeBusyStatus: f.text('LegacyFreeBusyStatus', 'Busy'),
  CalendarItemType: f.text('CalendarItemType', 'Single'),
  StartTimeZoneId: f.text('StartTimeZoneId', 'Turkey Standard Time'),
});

describe('on-premises Exchange', () => {
  const exchange = new FakeExchange();
  let app: TestApp;
  let owner: Client;
  let accountId: string;

  const sync = () => syncAccount(app.deps, accountId);
  const window = { from: inDays(-30), to: inDays(120) };
  const occurrences = async () =>
    (
      await owner.api.call('listCalendarOccurrences', {
        query: { ...window, meetings: 'false', cards: 'false' },
      })
    ).items.filter((o) => o.provider === 'exchange');
  const eventNamed = async (title: string) => {
    const o = (await occurrences()).find((x) => x.title === title)!;
    return owner.api.call('getCalendarEvent', { params: { eventId: o.sourceId }, query: {} });
  };
  const account = async () =>
    (await owner.api.call('listCalendarAccounts')).items.find((a) => a.id === accountId)!;
  const mainCalendar = async () => (await account()).calendars.find((c) => c.name === 'Takvim')!.id;
  const contactList = async () =>
    (await owner.api.call('listContacts', { query: { limit: 100 } })).items;

  const setup = (body: Record<string, unknown> = {}) =>
    owner.api.call('updateCalendarIntegration', {
      params: { provider: 'exchange' },
      body: { enabled: true, ewsUrl: EWS_URL, ewsAuth: 'ntlm', contactsSync: false, ...body },
    });

  beforeAll(async () => {
    setEwsTransport(exchange.transport);
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    await setup();
  });

  beforeEach(async () => {
    exchange.reset();
    await app.deps.db.delete(contactVersions);
    await app.deps.db.delete(contacts);
    await app.deps.db.delete(calendarAccounts).where(eq(calendarAccounts.provider, 'exchange'));
    await setup();
    const row = await owner.api.call('connectExchangeAccount', {
      body: {
        email: 'Owner@Contoso.test',
        username: 'CONTOSO\\owner',
        password: exchange.password,
      },
    });
    accountId = row.id;
    exchange.ops = [];
    exchange.requests = [];
  });

  afterAll(async () => {
    setEwsTransport(null);
    setCalendarFetch(null);
    await app?.close();
  });

  describe('connecting', () => {
    it("signs in with the person's own account and seals the password", async () => {
      const a = await account();
      expect(a).toMatchObject({
        provider: 'exchange',
        email: 'owner@contoso.test',
        status: 'active',
      });
      expect(JSON.stringify(a)).not.toContain(exchange.password);
      const [row] = await app.deps.db
        .select()
        .from(calendarAccounts)
        .where(eq(calendarAccounts.id, accountId));
      expect(row!.refreshTokenEnc).toBeTruthy();
      expect(row!.refreshTokenEnc).not.toContain(exchange.password);
      expect(exchange.connections.at(-1)).toMatchObject({
        url: EWS_URL,
        auth: 'ntlm',
        username: 'CONTOSO\\owner',
      });
    });

    it('uses the address when no username is given', async () => {
      await owner.api.call('connectExchangeAccount', {
        body: { email: 'ikinci@contoso.test', password: exchange.password },
      });
      expect(exchange.connections.at(-1)!.username).toBe('ikinci@contoso.test');
    });

    it('refuses a wrong password and keeps nothing', async () => {
      await expect(
        owner.api.call('connectExchangeAccount', {
          body: { email: 'yanlis@contoso.test', password: 'wrong-pass' },
        }),
      ).rejects.toMatchObject({ code: 'calendar_exchange_auth_failed' });
      const { items } = await owner.api.call('listCalendarAccounts');
      expect(items.map((a) => a.email)).not.toContain('yanlis@contoso.test');
    });

    it('needs the admin to set the server up, over https', async () => {
      await expect(setup({ ewsUrl: 'http://mail.contoso.test/EWS' })).rejects.toBeTruthy();
      await expect(setup({ ewsUrl: null })).rejects.toMatchObject({ code: 'validation_failed' });
      await owner.api.call('updateCalendarIntegration', {
        params: { provider: 'exchange' },
        body: { enabled: false },
      });
      await expect(
        owner.api.call('connectExchangeAccount', {
          body: { email: 'x@contoso.test', password: exchange.password },
        }),
      ).rejects.toMatchObject({ code: 'calendar_integration_off' });
      expect((await owner.api.call('listCalendarAccounts')).providers).not.toContain('exchange');
      await setup();
      expect((await owner.api.call('listCalendarAccounts')).providers).toContain('exchange');
      const { items } = await owner.api.call('getCalendarIntegrations');
      expect(items.find((i) => i.provider === 'exchange')).toMatchObject({
        ewsUrl: EWS_URL,
        ewsAuth: 'ntlm',
        domainWide: false,
      });
    });

    it("has no org-wide access: only people's own sign-ins", async () => {
      const saved = await setup({ domainWide: true });
      expect(saved.domainWide).toBe(false);
    });
  });

  describe('calendar', () => {
    it('lists the calendars and brings events in', async () => {
      exchange.put('cal-main', 'CalendarItem', {
        ...timed('Planlama'),
        Sensitivity: f.text('Sensitivity', 'Normal'),
        Body: f.text('Body', 'Gündem'),
        Location: f.text('Location', 'Oda 1'),
        MyResponseType: f.text('MyResponseType', 'Tentative'),
        Organizer: `<t:Organizer>${f.mailbox('Ayşe', 'ayse@contoso.test')}</t:Organizer>`,
        RequiredAttendees: `<t:RequiredAttendees>${f.attendee('Ben', 'owner@contoso.test', 'Tentative')}${f.attendee('X500', '/O=EX/CN=X', 'Accept')}</t:RequiredAttendees>`,
        OptionalAttendees: `<t:OptionalAttendees>${f.attendee('Can', 'can@contoso.test', 'Decline')}</t:OptionalAttendees>`,
      });
      const allDayStart = inDays(9, 21);
      exchange.put('cal-team', 'CalendarItem', {
        Subject: f.text('Subject', 'İzin'),
        // Midnight in Istanbul is 21:00 UTC the day before.
        Start: f.text('Start', allDayStart),
        End: f.text('End', inDays(10, 21)),
        IsAllDayEvent: f.text('IsAllDayEvent', 'true'),
        LegacyFreeBusyStatus: f.text('LegacyFreeBusyStatus', 'Free'),
        Sensitivity: f.text('Sensitivity', 'Private'),
        CalendarItemType: f.text('CalendarItemType', 'Single'),
        StartTimeZoneId: f.text('StartTimeZoneId', 'Turkey Standard Time'),
      });
      await sync();
      const a = await account();
      expect(a.status).toBe('active');
      expect(a.calendars.map((c) => [c.name, c.writable])).toEqual([
        ['Ekip', true],
        ['Takvim', true],
      ]);
      const e = await eventNamed('Planlama');
      expect(e).toMatchObject({
        description: 'Gündem',
        location: 'Oda 1',
        timeZone: 'Europe/Istanbul',
        external: {
          provider: 'exchange',
          organizer: { email: 'ayse@contoso.test', name: 'Ayşe' },
        },
      });
      // An internal address without an SMTP form stays out; the others keep their answers.
      expect(e.attendees.map((x) => [x.email, x.response])).toEqual([
        ['owner@contoso.test', 'tentative'],
        ['can@contoso.test', 'declined'],
      ]);
      const leave = await eventNamed('İzin');
      expect(leave.allDay).toBe(true);
      const nextDay = new Date(Date.parse(allDayStart) + DAY).toISOString().slice(0, 10);
      expect(leave.start).toBe(nextDay);
      expect(leave.busy).toBe(false);
      expect(leave.visibility).toBe('private');
    });

    it('makes every occurrence a row of its series, asking for the series once', async () => {
      const master = exchange.put('cal-main', 'CalendarItem', {
        ...timed('Haftalık', 1),
        CalendarItemType: f.text('CalendarItemType', 'RecurringMaster'),
      });
      for (const days of [2, 9, 16]) {
        exchange.put(
          'cal-main',
          'CalendarItem',
          {
            ...timed('Haftalık', days),
            CalendarItemType: f.text('CalendarItemType', 'Occurrence'),
            UID: f.text('UID', 'series-1'),
          },
          { masterId: master },
        );
      }
      await sync();
      const list = await occurrences();
      expect(list.filter((o) => o.title === 'Haftalık')).toHaveLength(3);
      const e = await eventNamed('Haftalık');
      expect(e.external).toMatchObject({ occurrenceOnly: true });
      const masterLookups = exchange.requests.filter((r) => r.includes('RecurringMasterItemId'));
      expect(masterLookups).toHaveLength(1);
    });

    it('polls cheaply: no change, no listing', async () => {
      exchange.put('cal-main', 'CalendarItem', timed('Planlama'));
      await sync();
      expect(exchange.ops).toContain('FindItem');
      exchange.ops = [];
      await sync();
      expect(exchange.ops).toContain('SyncFolderItems');
      expect(exchange.ops).not.toContain('FindItem');
      expect(exchange.ops).not.toContain('GetItem');
    });

    it('follows changes and deletions at the server', async () => {
      const a = exchange.put('cal-main', 'CalendarItem', timed('Planlama'));
      const b = exchange.put('cal-main', 'CalendarItem', timed('Silinecek', 6));
      await sync();
      exchange.touch(a, { Subject: f.text('Subject', 'Yeni başlık') });
      exchange.drop(b);
      await sync();
      expect((await occurrences()).map((o) => o.title)).toEqual(['Yeni başlık']);
    });

    it('takes a cancelled meeting off', async () => {
      const a = exchange.put('cal-main', 'CalendarItem', timed('Toplantı'));
      await sync();
      exchange.touch(a, { IsCancelled: f.text('IsCancelled', 'true') });
      await sync();
      expect(await occurrences()).toEqual([]);
    });

    it('starts over when the sync state is refused', async () => {
      const a = exchange.put('cal-main', 'CalendarItem', timed('Planlama'));
      await sync();
      const [cal] = await app.deps.db
        .select()
        .from(calendars)
        .where(eq(calendars.externalId, 'cal-main'));
      await app.deps.db
        .update(calendars)
        .set({ syncState: { ...cal!.syncState!, cursor: 'bad-state' } })
        .where(eq(calendars.id, cal!.id));
      exchange.touch(a, { Subject: f.text('Subject', 'Düzeldi') });
      await sync();
      expect((await account()).status).toBe('active');
      expect((await occurrences()).map((o) => o.title)).toEqual(['Düzeldi']);
    });

    it('reads a long change list and splits a view that is too big', async () => {
      for (let i = 0; i < 6; i++) exchange.put('cal-main', 'CalendarItem', timed(`E${i}`, i + 1));
      exchange.syncPage = 2;
      exchange.viewLimit = 2;
      await sync();
      expect((await account()).status).toBe('active');
      expect(await occurrences()).toHaveLength(6);
    });

    it('creates events with their fields in schema order', async () => {
      await sync();
      const calendarId = await mainCalendar();
      const made = await owner.api.call('createCalendarEvent', {
        body: {
          calendarId,
          title: 'A <&> "B"',
          description: 'Not & not',
          location: 'Oda 2',
          allDay: false,
          start: inDays(3),
          end: inDays(3, 8),
          timeZone: 'Europe/Istanbul',
          rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5',
          attendees: { userIds: [], emails: ['can@contoso.test'] },
        },
      });
      expect(made.title).toBe('A <&> "B"');
      const xml = exchange.requests.find((r) => r.includes('<m:CreateItem'))!;
      expect(xml).toContain('SendMeetingInvitations="SendToAllAndSaveCopy"');
      expect(xml).toContain('A &lt;&amp;&gt; &quot;B&quot;');
      expect(xml).toContain(
        '<t:WeeklyRecurrence><t:Interval>2</t:Interval><t:DaysOfWeek>Monday Wednesday</t:DaysOfWeek>',
      );
      expect(xml).toContain('<t:NumberOfOccurrences>5</t:NumberOfOccurrences>');
      expect(xml).toContain('<t:StartTimeZone Id="Turkey Standard Time"/>');
    });

    it('writes an all-day event from midnight in its zone', async () => {
      await sync();
      const date = inDays(4).slice(0, 10);
      const next = inDays(5).slice(0, 10);
      await owner.api.call('createCalendarEvent', {
        body: {
          calendarId: await mainCalendar(),
          title: 'Bayram',
          allDay: true,
          start: date,
          end: next,
          timeZone: 'Europe/Istanbul',
        },
      });
      const item = [...exchange.items.values()].find((i) => i.fields.has('IsAllDayEvent'))!;
      expect(exchange.field(item.id, 'IsAllDayEvent')).toBe('true');
      const start = new Date(exchange.field(item.id, 'Start')!);
      expect(start.getUTCHours()).toBe(21);
      expect(start.toISOString().slice(0, 10)).toBe(
        new Date(Date.parse(`${date}T00:00:00Z`) - DAY).toISOString().slice(0, 10),
      );
    });

    it('writes on the known version; a newer one is saved and overwritten', async () => {
      const id = exchange.put('cal-main', 'CalendarItem', timed('Planlama'));
      await sync();
      const e = await eventNamed('Planlama');
      await owner.api.call('updateCalendarEvent', {
        params: { eventId: e.id },
        body: { location: 'Oda 3' },
      });
      expect(exchange.field(id, 'Location')).toBe('Oda 3');
      const first = exchange.requests.findLast((r) => r.includes('<m:UpdateItem'))!;
      expect(first).toContain('ConflictResolution="NeverOverwrite"');
      expect(first).toMatch(/<t:ItemId Id="[^"]+" ChangeKey="ck-\d+"\/>/);
      let versions = await owner.api.call('listCalendarEventVersions', {
        params: { eventId: e.id },
      });
      expect(versions.items).toEqual([]);

      exchange.touch(id, { Subject: f.text('Subject', 'Outlook başlığı') });
      await owner.api.call('updateCalendarEvent', {
        params: { eventId: e.id },
        body: { location: 'Oda 4' },
      });
      const updates = exchange.requests.filter((r) => r.includes('<m:UpdateItem'));
      expect(updates.at(-1)).toContain('ConflictResolution="AlwaysOverwrite"');
      versions = await owner.api.call('listCalendarEventVersions', { params: { eventId: e.id } });
      expect(versions.items).toEqual([
        expect.objectContaining({
          overwritten: 'provider',
          title: 'Outlook başlığı',
          location: 'Oda 3',
        }),
      ]);
      expect(exchange.field(id, 'Location')).toBe('Oda 4');
    });

    it('sends "all events" to the series master; moving a series stays in Outlook', async () => {
      const master = exchange.put('cal-main', 'CalendarItem', {
        ...timed('Haftalık', 1),
        CalendarItemType: f.text('CalendarItemType', 'RecurringMaster'),
      });
      const occ = exchange.put(
        'cal-main',
        'CalendarItem',
        {
          ...timed('Haftalık', 2),
          CalendarItemType: f.text('CalendarItemType', 'Occurrence'),
          UID: f.text('UID', 'series-1'),
        },
        { masterId: master },
      );
      await sync();
      const e = await eventNamed('Haftalık');
      await owner.api.call('updateCalendarEvent', {
        params: { eventId: e.id },
        body: { scope: 'all', title: 'Tümü' },
      });
      expect(exchange.field(master, 'Subject')).toBe('Tümü');
      expect(exchange.field(occ, 'Subject')).toBe('Haftalık');
      await expect(
        owner.api.call('updateCalendarEvent', {
          params: { eventId: e.id },
          body: { scope: 'all', start: inDays(3), end: inDays(3, 8) },
        }),
      ).rejects.toMatchObject({ code: 'calendar_external_unsupported' });
    });

    it('deletes at the server and answers invitations there', async () => {
      const del = exchange.put('cal-main', 'CalendarItem', timed('Silinecek'));
      const invite = exchange.put('cal-main', 'CalendarItem', {
        ...timed('Davet', 6),
        Organizer: `<t:Organizer>${f.mailbox('Ayşe', 'ayse@contoso.test')}</t:Organizer>`,
        MyResponseType: f.text('MyResponseType', 'NoResponseReceived'),
        RequiredAttendees: `<t:RequiredAttendees>${f.attendee('Ben', 'owner@contoso.test', 'NoResponseReceived')}</t:RequiredAttendees>`,
      });
      await sync();
      const gone = await eventNamed('Silinecek');
      await owner.api.call('deleteCalendarEvent', {
        params: { eventId: gone.id },
        query: { scope: 'all' },
      });
      expect(exchange.items.has(del)).toBe(false);
      const e = await eventNamed('Davet');
      await owner.api.call('respondCalendarEvent', {
        params: { eventId: e.id },
        body: { response: 'accepted' },
      });
      expect(exchange.responses).toEqual([{ tag: 'AcceptItem', id: invite }]);
    });

    it('stops polling when Exchange refuses the sign-in, until connected again', async () => {
      await sync();
      exchange.password = 'changed-pass';
      await sync();
      expect((await account()).status).toBe('revoked');
      const [revoked] = await app.deps.db
        .select()
        .from(calendarAccounts)
        .where(eq(calendarAccounts.id, accountId));
      expect(revoked!.refreshTokenEnc).toBeNull();
      const before = exchange.connections.length;
      await syncDueAccounts(app.deps);
      await sync();
      expect(exchange.connections.length).toBe(before);
      await owner.api.call('connectExchangeAccount', {
        body: { email: 'owner@contoso.test', password: 'changed-pass' },
      });
      await sync();
      expect((await account()).status).toBe('active');
      exchange.password = 'exchange-test-pass';
    });

    it('a busy-only account keeps only the times and writes nothing', async () => {
      exchange.put('cal-main', 'CalendarItem', timed('Gizli'));
      await owner.api.call('updateCalendarAccount', {
        params: { accountId },
        body: { busyOnly: true },
      });
      await sync();
      const list = await occurrences();
      expect(list).toHaveLength(1);
      expect(list[0]!.title).toBe('');
    });
  });

  describe('contacts', () => {
    const anna = {
      GivenName: f.text('GivenName', 'Anna'),
      Surname: f.text('Surname', 'Yılmaz'),
      DisplayName: f.text('DisplayName', 'Anna Yılmaz'),
      CompanyName: f.text('CompanyName', 'Contoso'),
      JobTitle: f.text('JobTitle', 'Satın alma'),
      EmailAddresses:
        '<t:EmailAddresses><t:Entry Key="EmailAddress1">anna@contoso.test</t:Entry><t:Entry Key="EmailAddress2">/O=EX/CN=ANNA</t:Entry></t:EmailAddresses>',
      PhoneNumbers:
        '<t:PhoneNumbers><t:Entry Key="BusinessPhone">+90 212 000 00 00</t:Entry><t:Entry Key="MobilePhone">+90 532 000 00 00</t:Entry><t:Entry Key="BusinessFax">+90 212 111 11 11</t:Entry></t:PhoneNumbers>',
      PhysicalAddresses:
        '<t:PhysicalAddresses><t:Entry Key="Business"><t:Street>Büyükdere 1</t:Street><t:City>İstanbul</t:City><t:PostalCode>34000</t:PostalCode></t:Entry></t:PhysicalAddresses>',
      BusinessHomePage: f.text('BusinessHomePage', 'https://contoso.test'),
      Birthday: f.text('Birthday', '1990-05-17T12:00:00Z'),
      Body: f.text('Body', 'Kuzey bölgesi'),
      Categories: '<t:Categories><t:String>Müşteri</t:String></t:Categories>',
    };

    const on = () => setup({ contactsSync: true });

    it('stays out until the admin switches it on', async () => {
      exchange.put('contacts', 'Contact', anna);
      await sync();
      expect(await contactList()).toEqual([]);
      expect(exchange.requests.join('')).not.toContain('Id="contacts"');
      expect((await account()).contacts).toBeNull();
    });

    it('brings the folder in as private contacts; lists are not contacts', async () => {
      await on();
      exchange.put('contacts', 'Contact', anna);
      exchange.put('contacts', 'DistributionList', { DisplayName: f.text('DisplayName', 'Ekip') });
      await sync();
      const [c, ...rest] = await contactList();
      expect(rest).toEqual([]);
      expect(c).toMatchObject({
        displayName: 'Anna Yılmaz',
        visibility: 'private',
        company: { name: 'Contoso' },
        jobTitle: 'Satın alma',
        emails: [{ type: 'work', value: 'anna@contoso.test' }],
        phones: [
          { type: 'work', value: '+90 212 000 00 00' },
          { type: 'mobile', value: '+90 532 000 00 00' },
        ],
        address: 'Büyükdere 1, 34000 İstanbul',
        website: 'https://contoso.test',
        birthday: '1990-05-17',
        notes: 'Kuzey bölgesi',
        tags: ['Müşteri'],
        external: { provider: 'exchange', accountId },
      });
      expect((await account()).contacts).toMatchObject({ status: 'active', count: 1 });
    });

    it('follows changes and deletions incrementally', async () => {
      await on();
      const a = exchange.put('contacts', 'Contact', anna);
      const b = exchange.put('contacts', 'Contact', { DisplayName: f.text('DisplayName', 'Bora') });
      await sync();
      exchange.touch(a, { JobTitle: f.text('JobTitle', 'Müdür') });
      exchange.drop(b);
      exchange.requests = [];
      await sync();
      const items = await contactList();
      expect(items.map((c) => [c.displayName, c.jobTitle])).toEqual([['Anna Yılmaz', 'Müdür']]);
      const reads = exchange.requests.filter((r) => r.includes('<m:GetItem'));
      expect(reads.join('')).toContain(a);
      expect(reads.join('')).not.toContain(b);
    });

    it('writes edits on the known version, slot by slot', async () => {
      await on();
      const id = exchange.put('contacts', 'Contact', anna);
      await sync();
      const [c] = await contactList();
      const saved = await owner.api.call('updateContact', {
        params: { contactId: c!.id },
        body: {
          jobTitle: 'Direktör',
          emails: [{ type: 'home', value: 'yeni@contoso.test' }],
          address: 'Levent 2',
          notes: null,
        },
      });
      const xml = exchange.requests.findLast((r) => r.includes('<m:UpdateItem'))!;
      expect(xml).toContain('ConflictResolution="NeverOverwrite"');
      expect(xml).toContain('FieldIndex="EmailAddress1"');
      // The second address at the server goes: it is not in the list any more.
      expect(xml).toMatch(
        /DeleteItemField><t:IndexedFieldURI FieldURI="contacts:EmailAddress" FieldIndex="EmailAddress2"/,
      );
      expect(exchange.field(id, 'JobTitle')).toBe('Direktör');
      expect(saved).toMatchObject({
        jobTitle: 'Direktör',
        address: 'Levent 2',
        emails: [{ type: 'home', value: 'yeni@contoso.test' }],
      });
      expect(saved.phones.map((p) => p.value)).toContain('+90 532 000 00 00');
    });

    it('keeps the version a conflict overwrites', async () => {
      await on();
      const id = exchange.put('contacts', 'Contact', anna);
      await sync();
      const [c] = await contactList();
      exchange.touch(id, { JobTitle: f.text('JobTitle', 'Outlook unvanı') });
      const saved = await owner.api.call('updateContact', {
        params: { contactId: c!.id },
        body: { notes: 'Crewhall notu' },
      });
      expect(saved).toMatchObject({ jobTitle: 'Outlook unvanı', notes: 'Crewhall notu' });
      const { items } = await owner.api.call('listContactVersions', {
        params: { contactId: c!.id },
      });
      expect(items).toEqual([
        expect.objectContaining({ overwritten: 'provider', jobTitle: 'Outlook unvanı' }),
      ]);
    });

    it('adds to the account in schema order and deletes there too', async () => {
      await on();
      await sync();
      const made = await owner.api.call('createContact', {
        body: {
          firstName: 'Cem & Can',
          lastName: 'Kaya',
          jobTitle: 'Uzman',
          emails: [{ type: 'work', value: 'cem@contoso.test' }],
          phones: [
            { type: 'mobile', value: '1' },
            { type: 'home', value: '2' },
          ],
          address: 'Ev 1',
          website: 'https://cem.test',
          birthday: '1985-01-02',
          notes: 'Not',
          tags: ['VIP'],
          accountId,
        },
      });
      expect(made).toMatchObject({
        firstName: 'Cem & Can',
        visibility: 'private',
        external: { provider: 'exchange' },
      });
      const item = [...exchange.items.values()].find((i) => i.kind === 'Contact')!;
      expect(item.folder).toBe('contacts');
      expect(exchange.field(item.id, 'Birthday')).toBe('1985-01-02T12:00:00Z');
      await sync();
      expect((await contactList()).filter((c) => c.lastName === 'Kaya')).toHaveLength(1);
      await owner.api.call('deleteContact', { params: { contactId: made.id } });
      expect(exchange.items.has(item.id)).toBe(false);
    });

    it('a refused address book leaves the calendar alone', async () => {
      await on();
      exchange.failContacts = 'ErrorAccessDenied';
      await sync();
      const a = await account();
      expect(a.status).toBe('active');
      expect(a.contacts).toMatchObject({ status: 'error' });
    });
  });
});

describe('EWS building blocks', () => {
  it('writes the rules Exchange knows, and refuses the rest', () => {
    const rule = (r: string) => recurrenceXml(r, '2026-11-02', 'Europe/Istanbul');
    expect(rule('FREQ=DAILY;INTERVAL=3')).toBe(
      '<t:Recurrence><t:DailyRecurrence><t:Interval>3</t:Interval></t:DailyRecurrence><t:NoEndRecurrence><t:StartDate>2026-11-02</t:StartDate></t:NoEndRecurrence></t:Recurrence>',
    );
    expect(rule('FREQ=MONTHLY;BYDAY=2TU')).toContain(
      '<t:DaysOfWeek>Tuesday</t:DaysOfWeek><t:DayOfWeekIndex>Second</t:DayOfWeekIndex>',
    );
    expect(rule('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=8')).toContain(
      '<t:AbsoluteYearlyRecurrence><t:DayOfMonth>8</t:DayOfMonth><t:Month>March</t:Month>',
    );
    expect(rule('FREQ=WEEKLY;UNTIL=20261231')).toContain(
      '<t:EndDateRecurrence><t:StartDate>2026-11-02</t:StartDate><t:EndDate>2026-12-31</t:EndDate>',
    );
    expect(() => rule('FREQ=YEARLY;INTERVAL=2')).toThrow();
  });

  describe('transports', () => {
    const request = '<m:GetFolder/>';
    const ok =
      '<e><Body><R><ResponseMessages><M ResponseClass="Success"><ResponseCode>NoError</ResponseCode></M></ResponseMessages></R></Body></e>';

    it('Basic carries the sign-in and follows no redirect', async () => {
      const seen: { auth?: string; redirect?: string }[] = [];
      setCalendarFetch(async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        seen.push({ auth: headers.authorization, redirect: init?.redirect });
        return new Response(ok, { status: 200 });
      });
      const conn = { url: EWS_URL, auth: 'basic' as const, username: 'u', password: 'p' };
      await single(conn, request);
      expect(seen).toEqual([{ auth: `Basic ${btoa('u:p')}`, redirect: 'error' }]);
      setCalendarFetch(null);
    });

    it('NTLM completes the handshake through the library', async () => {
      const steps: string[] = [];
      // A Type 2 challenge as a server sends it: flags ask for NTLMv2, with target info.
      const target = Buffer.from([2, 0, 0, 0, 0, 0, 0, 0]);
      const type2 = Buffer.alloc(48 + target.length);
      type2.write('NTLMSSP\0', 0, 'latin1');
      type2.writeUInt32LE(2, 8);
      type2.writeUInt32LE(48, 16);
      type2.writeUInt32LE(0x00888201, 20);
      type2.write('12345678', 24, 'latin1');
      type2.writeUInt16LE(target.length, 40);
      type2.writeUInt16LE(target.length, 42);
      type2.writeUInt32LE(48, 44);
      target.copy(type2, 48);
      const server = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          const auth = req.headers.authorization ?? '';
          const message = auth.startsWith('NTLM ')
            ? Buffer.from(auth.slice(5), 'base64').readUInt32LE(8)
            : 0;
          steps.push(`type${message}`);
          if (message === 1) {
            res.writeHead(401, { 'www-authenticate': `NTLM ${type2.toString('base64')}` });
            res.end();
          } else if (message === 3) {
            res.writeHead(200, { 'content-type': 'text/xml' });
            res.end(ok);
          } else {
            res.writeHead(401, { 'www-authenticate': 'NTLM' });
            res.end();
          }
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address() as AddressInfo;
      setEwsTransport(null);
      try {
        const msg = await single(
          {
            url: `http://127.0.0.1:${port}/EWS/Exchange.asmx`,
            auth: 'ntlm',
            username: 'CONTOSO\\owner',
            password: 'p',
          },
          request,
        );
        expect(msg.attrs.ResponseClass).toBe('Success');
        expect(steps).toEqual(['type1', 'type3']);
      } finally {
        await new Promise((r) => server.close(r));
      }
    });
  });
});
