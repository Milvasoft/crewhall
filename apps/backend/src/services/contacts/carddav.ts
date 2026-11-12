import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { contacts, directoryProfiles, orgMembers, users } from '@crewhall/db';
import { canContacts } from '@crewhall/shared';
import type { Context } from 'hono';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { AppEnv } from '../../http/types';
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
  requested,
  responseXml,
  type Getter,
} from '../calendar/dav';
import { childrenOf, escapeXml, parseXml } from '../calendar/xml';
import type { ContactsActor } from './access';
import { visibleTo, type ContactRow } from './contacts';
import { allPeople } from './directory';
import { pushChange, removeMirrored } from './external/writes';
import { contactCard, personCard, writeCard } from './transfer';
import { buildVcard, parseVcards } from './vcard';

/**
 * CardDAV (RFC 6352) for phone and desktop address books: `/carddav/` with a personal API
 * token as the Basic password, like CalDAV. Three address books: the org directory (read-only),
 * the org's shared contacts and the caller's private ones; writes need `contacts:write`.
 * getctag/ETag sync; addressbook-query filters are not applied (every card is returned).
 */

const ROOT = '/carddav/';
const PRINCIPAL = '/carddav/principals/me/';
const HOME = '/carddav/addressbooks/';

const BOOKS = ['directory', 'shared', 'private'] as const;
type Book = (typeof BOOKS)[number];

interface Ctx {
  deps: Deps;
  c: Context<AppEnv>;
  actor: ContactsActor;
  canWrite: boolean;
}

type Target =
  | { kind: 'root' }
  | { kind: 'principal' }
  | { kind: 'home' }
  | { kind: 'book'; book: Book }
  | { kind: 'card'; book: Book; name: string };

function targetOf(path: string): Target | null {
  const p = decodeURIComponent(path).replace(/\/+/g, '/');
  if (p === '/carddav' || p === ROOT) return { kind: 'root' };
  if (p.startsWith('/carddav/principals')) return { kind: 'principal' };
  if (p === HOME || p === HOME.slice(0, -1)) return { kind: 'home' };
  const m = /^\/carddav\/addressbooks\/([a-z]+)\/?(?:([^/]+))?$/.exec(p);
  if (!m || !(BOOKS as readonly string[]).includes(m[1]!)) return null;
  const book = m[1] as Book;
  return m[2] ? { kind: 'card', book, name: m[2] } : { kind: 'book', book };
}

const bookHref = (b: Book) => `${HOME}${b}/`;
const contactName = (r: Pick<ContactRow, 'id' | 'davName'>) => r.davName ?? `${r.id}.vcf`;
const etag = (d: Date) => `"${d.getTime().toString(36)}"`;

function bookCondition(x: Ctx, book: Exclude<Book, 'directory'>): SQL {
  return and(
    visibleTo(x.actor, contacts),
    book === 'shared'
      ? eq(contacts.visibility, 'org')
      : and(eq(contacts.visibility, 'private'), eq(contacts.createdBy, x.actor.userId))!,
  )!;
}

async function ctagOf(x: Ctx, book: Book) {
  if (book === 'directory') {
    const [r] = await x.deps.db
      .select({
        at: sql<string>`greatest(max(${users.updatedAt}), max(${directoryProfiles.updatedAt}), max(${orgMembers.updatedAt}))`,
        n: sql<number>`count(*)::int`,
      })
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.userId))
      .leftJoin(
        directoryProfiles,
        and(
          eq(directoryProfiles.userId, users.id),
          eq(directoryProfiles.orgId, orgMembers.organizationId),
        ),
      )
      .where(and(eq(orgMembers.organizationId, x.actor.org.id), eq(orgMembers.status, 'active')));
    return `"${new Date(r?.at ?? 0).getTime().toString(36)}-${r?.n ?? 0}"`;
  }
  // Deleted rows count too (their updated_at moves on delete).
  const [r] = await x.deps.db
    .select({
      at: sql<string>`max(${contacts.updatedAt})`,
      n: sql<number>`count(*) filter (where ${contacts.deletedAt} is null)::int`,
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.orgId, x.actor.org.id),
        book === 'shared'
          ? eq(contacts.visibility, 'org')
          : and(eq(contacts.visibility, 'private'), eq(contacts.createdBy, x.actor.userId)),
      ),
    );
  return `"${new Date(r?.at ?? 0).getTime().toString(36)}-${r?.n ?? 0}"`;
}

/** Cards of a book: name, ETag and (lazily) the vCard text. */
async function cardsOf(x: Ctx, book: Book) {
  if (book === 'directory') {
    const rows = await allPeople(x.deps.db, x.actor);
    return rows.map((r) => {
      const at = new Date(
        Math.max(r.u.updatedAt.getTime(), r.p?.updatedAt.getTime() ?? 0, r.m.updatedAt.getTime()),
      );
      return {
        name: `${r.u.id}.vcf`,
        etag: etag(at),
        updated: at,
        data: async () => buildVcard(personCard(x.actor.org.name, r)),
        row: null as ContactRow | null,
      };
    });
  }
  const rows = await x.deps.db
    .select()
    .from(contacts)
    .where(bookCondition(x, book))
    .orderBy(contacts.displayName);
  return rows.map((r) => ({
    name: contactName(r),
    etag: etag(r.updatedAt),
    updated: r.updatedAt,
    data: async () => buildVcard(await contactCard(x.deps.db, r)),
    row: r as ContactRow | null,
  }));
}

const writable = (x: Ctx, book: Book) =>
  book !== 'directory' && x.canWrite && canContacts('create', { orgRole: x.actor.actor.orgRole });

const DAV_HEADERS = {
  DAV: '1, 3, addressbook',
  Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, REPORT',
};

export async function handleCarddav(deps: Deps, c: Context<AppEnv>): Promise<Response> {
  for (const [k, v] of Object.entries(DAV_HEADERS)) c.header(k, v);
  if (c.req.method === 'OPTIONS') return c.body(null, 200);
  const auth = await authenticateDav(deps, c, 'contacts', 'Crewhall CardDAV');
  if (auth instanceof Response) return auth;
  const actor = actorOf(auth);
  // Guests have no directory or address book.
  if (!canContacts('read', { orgRole: actor.actor.orgRole })) return c.text('Forbidden', 403);
  const x: Ctx = { deps, c, actor, canWrite: auth.scopes.includes('contacts:write') };
  const target = targetOf(new URL(c.req.url).pathname);
  if (!target) return c.text('Not Found', 404);
  try {
    switch (c.req.method) {
      case 'PROPFIND':
        return await propfind(x, target);
      case 'REPORT':
        if (target.kind !== 'book') return c.text('Not Found', 404);
        return await report(x, target.book);
      case 'GET':
      case 'HEAD':
        return await get(x, target);
      case 'PUT':
        if (target.kind !== 'card') return c.text('Method Not Allowed', 405);
        return await put(x, target.book, target.name);
      case 'DELETE':
        if (target.kind !== 'card') return c.text('Forbidden', 403);
        return await remove(x, target.book, target.name);
      case 'PROPPATCH':
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

function commonProps(x: Ctx): Getter {
  return (ns, name) => {
    if (ns === NS.D && name === 'current-user-principal') return hrefXml(PRINCIPAL);
    if (ns === NS.D && name === 'principal-URL') return hrefXml(PRINCIPAL);
    if (ns === NS.CR && name === 'addressbook-home-set') return hrefXml(HOME);
    if (ns === NS.D && name === 'owner') return hrefXml(PRINCIPAL);
    if (ns === NS.C && name === 'calendar-user-address-set') {
      return hrefXml(`mailto:${x.actor.userEmail}`);
    }
    if (ns === NS.D && name === 'supported-report-set') {
      return '<D:supported-report><D:report><CR:addressbook-multiget/></D:report></D:supported-report><D:supported-report><D:report><CR:addressbook-query/></D:report></D:supported-report>';
    }
    return undefined;
  };
}

const BOOK_NAME: Record<Book, { tr: string; en: string }> = {
  directory: { tr: 'Kurum rehberi', en: 'Directory' },
  shared: { tr: 'Kişiler', en: 'Contacts' },
  private: { tr: 'Özel kişilerim', en: 'My private contacts' },
};

async function bookProps(x: Ctx, book: Book): Promise<Getter> {
  const common = commonProps(x);
  const ctag = await ctagOf(x, book);
  const locale = (x.actor.org.settings as { defaultLocale?: 'tr' | 'en' }).defaultLocale ?? 'tr';
  return (ns, name) => {
    if (ns === NS.D && name === 'resourcetype') return '<D:collection/><CR:addressbook/>';
    if (ns === NS.D && name === 'displayname') return escapeXml(BOOK_NAME[book][locale]);
    if (ns === NS.CS && name === 'getctag') return ctag;
    if (ns === NS.D && name === 'getetag') return ctag;
    if (ns === NS.CR && name === 'supported-address-data') {
      return '<CR:address-data-type content-type="text/vcard" version="3.0"/>';
    }
    if (ns === NS.D && name === 'current-user-privilege-set') {
      return writable(x, book) ? PRIVILEGES_WRITE : PRIVILEGES_READ;
    }
    return common(ns, name);
  };
}

function cardProps(card: { etag: string; updated: Date }, data: string | null): Getter {
  return (ns, name) => {
    if (ns === NS.D && name === 'getetag') return escapeXml(card.etag);
    if (ns === NS.D && name === 'resourcetype') return '';
    if (ns === NS.D && name === 'getcontenttype') return 'text/vcard; charset=utf-8';
    if (ns === NS.D && name === 'getlastmodified') return card.updated.toUTCString();
    if (ns === NS.CR && name === 'address-data') return data === null ? undefined : escapeXml(data);
    return undefined;
  };
}

async function propfind(x: Ctx, t: Target) {
  const { c } = x;
  const body = await bodyXml(c);
  const depth = c.req.header('depth') === '0' ? 0 : 1;
  const common = commonProps(x);
  const out: string[] = [];
  if (t.kind === 'root' || t.kind === 'principal') {
    const props = requested(body, [
      [NS.D, 'resourcetype'],
      [NS.D, 'current-user-principal'],
    ]);
    out.push(
      responseXml(
        t.kind === 'principal' ? PRINCIPAL : ROOT,
        answer(props, (ns, name) =>
          ns === NS.D && name === 'resourcetype'
            ? t.kind === 'principal'
              ? '<D:collection/><D:principal/>'
              : '<D:collection/>'
            : ns === NS.D && name === 'displayname'
              ? escapeXml(x.actor.userName)
              : common(ns, name),
        ),
      ),
    );
    return multistatus(c, out);
  }
  const props = requested(body, [
    [NS.D, 'resourcetype'],
    [NS.D, 'displayname'],
    [NS.D, 'getetag'],
    [NS.CS, 'getctag'],
  ]);
  if (t.kind === 'home') {
    out.push(
      responseXml(
        HOME,
        answer(props, (ns, name) =>
          ns === NS.D && name === 'resourcetype' ? '<D:collection/>' : common(ns, name),
        ),
      ),
    );
    if (depth === 1) {
      for (const b of BOOKS)
        out.push(responseXml(bookHref(b), answer(props, await bookProps(x, b))));
    }
    return multistatus(c, out);
  }
  if (t.kind === 'book') {
    out.push(responseXml(bookHref(t.book), answer(props, await bookProps(x, t.book))));
    if (depth === 1) {
      for (const card of await cardsOf(x, t.book)) {
        out.push(
          responseXml(
            `${bookHref(t.book)}${encodeURIComponent(card.name)}`,
            answer(props, cardProps(card, null)),
          ),
        );
      }
    }
    return multistatus(c, out);
  }
  const card = (await cardsOf(x, t.book)).find((k) => k.name === t.name);
  if (!card) return c.text('Not Found', 404);
  out.push(
    responseXml(
      `${bookHref(t.book)}${encodeURIComponent(card.name)}`,
      answer(props, cardProps(card, null)),
    ),
  );
  return multistatus(c, out);
}

async function report(x: Ctx, book: Book) {
  const { c } = x;
  const body = await bodyXml(c);
  if (!body) return c.text('Bad Request', 400);
  const props = requested(body, [
    [NS.D, 'getetag'],
    [NS.CR, 'address-data'],
  ]);
  const wantsData = props.some(([ns, n]) => ns === NS.CR && n === 'address-data');
  const all = await cardsOf(x, book);
  let chosen = all;
  const missing: string[] = [];
  if (body.ns === NS.CR && body.name === 'addressbook-multiget') {
    chosen = [];
    for (const h of childrenOf(body, NS.D, 'href')) {
      const href = h.text.trim();
      const name = decodeURIComponent(href.split('/').filter(Boolean).pop() ?? '');
      const card = all.find((k) => k.name === name);
      if (card) chosen.push(card);
      else missing.push(href);
    }
  } else if (!(body.ns === NS.CR && body.name === 'addressbook-query')) {
    return c.body(
      '<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><D:supported-report/></D:error>',
      403,
      { 'Content-Type': 'application/xml; charset=utf-8' },
    );
  }
  const out: string[] = [];
  for (const card of chosen) {
    out.push(
      responseXml(
        `${bookHref(book)}${encodeURIComponent(card.name)}`,
        answer(props, cardProps(card, wantsData ? await card.data() : null)),
      ),
    );
  }
  for (const href of missing) out.push(missingXml(href));
  return multistatus(c, out);
}

async function get(x: Ctx, t: Target) {
  const { c } = x;
  if (t.kind === 'card') {
    const card = (await cardsOf(x, t.book)).find((k) => k.name === t.name);
    if (!card) return c.text('Not Found', 404);
    c.header('ETag', card.etag);
    const headers = { 'Content-Type': 'text/vcard; charset=utf-8' };
    return c.req.method === 'HEAD'
      ? c.body(null, 200, headers)
      : c.body(await card.data(), 200, headers);
  }
  if (t.kind === 'book') {
    const cards = await cardsOf(x, t.book);
    const text = (await Promise.all(cards.map((k) => k.data()))).join('');
    return c.body(text, 200, { 'Content-Type': 'text/vcard; charset=utf-8' });
  }
  return c.text('Crewhall CardDAV', 200);
}

async function findContact(x: Ctx, book: Exclude<Book, 'directory'>, name: string) {
  const idPart = /^([0-9a-f-]{36})\.vcf$/i.exec(name)?.[1];
  const [row] = await x.deps.db
    .select()
    .from(contacts)
    .where(
      and(
        bookCondition(x, book),
        or(
          eq(contacts.davName, name),
          idPart
            ? and(isNull(contacts.davName), sql`${contacts.id}::text = ${idPart.toLowerCase()}`)
            : sql`false`,
        ),
      ),
    );
  return row ?? null;
}

async function put(x: Ctx, book: Book, name: string) {
  const { c, deps } = x;
  if (book === 'directory' || !writable(x, book)) return c.text('Forbidden', 403);
  if (name.length > 255) return c.text('Bad Request', 400);
  const existing = await findContact(x, book, name);
  if (preconditionFails(c, existing ? etag(existing.updatedAt) : null)) {
    return c.text('Precondition Failed', 412);
  }
  const text = await c.req.text();
  if (text.length > 1_000_000) return c.text('Payload Too Large', 413);
  const parsed = parseVcards(text);
  const card = parsed.cards[0];
  if (!card || parsed.cards.length !== 1) {
    return c.body(
      '<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:" xmlns:CR="urn:ietf:params:xml:ns:carddav"><CR:valid-address-data/></D:error>',
      403,
      { 'Content-Type': 'application/xml; charset=utf-8' },
    );
  }
  if (
    existing &&
    !canContacts('edit', {
      orgRole: x.actor.actor.orgRole,
      own: existing.createdBy === x.actor.userId,
      visibility: existing.visibility,
    })
  ) {
    return c.text('Forbidden', 403);
  }
  const r = await deps.db.transaction(async (tx) => {
    const written = await writeCard(
      tx,
      x.actor,
      { ...card, uid: existing?.uid ?? card.uid },
      book === 'shared' ? 'org' : 'private',
      existing,
      {
        davName: name,
      },
    );
    return existing?.accountId
      ? { ...written, row: await pushChange(deps, tx, existing, written.row) }
      : written;
  });
  c.header('ETag', etag(r.row.updatedAt));
  return c.body(null, r.created ? 201 : 204);
}

async function remove(x: Ctx, book: Book, name: string) {
  const { c, deps } = x;
  if (book === 'directory' || !writable(x, book)) return c.text('Forbidden', 403);
  const row = await findContact(x, book, name);
  if (!row) return c.text('Not Found', 404);
  if (preconditionFails(c, etag(row.updatedAt))) return c.text('Precondition Failed', 412);
  if (
    !canContacts('delete', {
      orgRole: x.actor.actor.orgRole,
      own: row.createdBy === x.actor.userId,
      visibility: row.visibility,
    })
  ) {
    return c.text('Forbidden', 403);
  }
  await removeMirrored(deps, row);
  await deps.db.update(contacts).set({ deletedAt: new Date() }).where(eq(contacts.id, row.id));
  return c.body(null, 204);
}
