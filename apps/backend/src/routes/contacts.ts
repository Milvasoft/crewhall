import { CONTACTS_RAW_PATHS } from '@crewhall/shared';
import type { Router } from '../http/route';
import { AppError } from '../http/errors';
import type { OrgCtx } from '../http/types';
import { moduleOn } from '../services/mcp/policy';
import type { ContactsActor } from '../services/contacts/access';
import { handleCarddav } from '../services/contacts/carddav';
import * as book from '../services/contacts/contacts';
import * as dir from '../services/contacts/directory';
import { listVersions } from '../services/contacts/external/versions';
import { addContact, removeContact, saveContact } from '../services/contacts/external/writes';
import { exportContacts, exportDirectory, importVcards } from '../services/contacts/transfer';
import { importDirectory } from '../services/contacts/directory-import';
import { audit } from '../services/audit';

const contactsActor = (ctx: Pick<OrgCtx<never>, 'org' | 'actor' | 'user'>): ContactsActor => ({
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
  'MKCOL',
] as const;

/** Contacts and directory routes; endpoints come from packages/shared/src/endpoints/contacts.ts. */
export function registerContacts(r: Router): void {
  // Static paths under /contacts and /directory go before the ones with an id.
  // vCard files.
  const vcf = (text: string, name: string) =>
    new Response(text, {
      headers: {
        'Content-Type': 'text/vcard; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
      },
    });
  r.rawOrg('GET', CONTACTS_RAW_PATHS.exportContacts, async ({ deps, org, actor, user }) => {
    if (!moduleOn(org, 'contacts')) throw new AppError('module_disabled');
    const a = { org, actor, userId: user.id, userName: user.name, userEmail: user.email };
    // Checks membership the same way as the list.
    await book.listTags(deps.db, a);
    return vcf(await exportContacts(deps.db, a), 'contacts.vcf');
  });
  r.rawOrg('GET', CONTACTS_RAW_PATHS.exportDirectory, async ({ deps, org, actor, user }) => {
    if (!moduleOn(org, 'contacts')) throw new AppError('module_disabled');
    const a = { org, actor, userId: user.id, userName: user.name, userEmail: user.email };
    return vcf(await exportDirectory(deps.db, a, org.name), 'directory.vcf');
  });

  r.org('getCardDavInfo', async (ctx) => ({
    url: new URL('/carddav/', ctx.deps.env.HUB_URL).toString(),
    username: ctx.user.email,
    tokensAvailable: moduleOn(ctx.org, 'mcp'),
  }));

  r.org('listDirectory', (ctx) => dir.listDirectory(ctx.deps.db, contactsActor(ctx), ctx.query));
  r.org('getDirectoryFacets', (ctx) => dir.facets(ctx.deps.db, contactsActor(ctx)));
  r.org('getOrgChart', (ctx) => dir.orgChart(ctx.deps.db, contactsActor(ctx)));
  r.org('importDirectory', async (ctx) => {
    const out = await importDirectory(ctx.deps.db, contactsActor(ctx), ctx.body);
    if (!out.dryRun && out.updated) {
      await audit(
        ctx.deps.db,
        {
          orgId: ctx.org.id,
          actorId: ctx.user.id,
          action: 'directory.import',
          targetType: 'org',
          targetId: ctx.org.id,
          meta: { updated: out.updated, failed: out.failed },
        },
        ctx.req,
      );
    }
    return out;
  });
  r.org('getDirectoryPerson', (ctx) =>
    dir.getPerson(ctx.deps.db, contactsActor(ctx), ctx.params.userId),
  );
  r.org('updateDirectoryProfile', (ctx) =>
    dir.updateProfile(ctx.deps.db, contactsActor(ctx), ctx.params.userId, ctx.body),
  );

  r.org('listContacts', (ctx) => book.listContacts(ctx.deps.db, contactsActor(ctx), ctx.query));
  r.org(
    'createContact',
    async (ctx) => {
      const a = contactsActor(ctx);
      const row = await addContact(ctx.deps, a, ctx.body);
      return (await book.toContacts(ctx.deps.db, a, [row]))[0]!;
    },
    { status: 201 },
  );
  r.org('getContact', async (ctx) => {
    const a = contactsActor(ctx);
    const row = await book.loadContact(ctx.deps.db, a, ctx.params.contactId);
    return (await book.toContacts(ctx.deps.db, a, [row]))[0]!;
  });
  r.org('updateContact', async (ctx) => {
    const a = contactsActor(ctx);
    const row = await saveContact(ctx.deps, a, ctx.params.contactId, ctx.body);
    return (await book.toContacts(ctx.deps.db, a, [row]))[0]!;
  });
  r.org('deleteContact', async (ctx) => {
    await removeContact(ctx.deps, contactsActor(ctx), ctx.params.contactId);
    return {};
  });
  r.org('listContactVersions', async (ctx) => {
    // Private to its owner, like the contact: not_found for anyone else.
    const row = await book.loadContact(ctx.deps.db, contactsActor(ctx), ctx.params.contactId);
    return { items: await listVersions(ctx.deps.db, row.id) };
  });
  r.org('listContactTags', (ctx) => book.listTags(ctx.deps.db, contactsActor(ctx)));
  r.org('importContactsVcard', (ctx) =>
    ctx.deps.db.transaction((tx) =>
      importVcards(tx, contactsActor(ctx), ctx.body.vcf, ctx.body.visibility),
    ),
  );

  r.org('listContactCompanies', (ctx) =>
    book.listCompanies(ctx.deps.db, contactsActor(ctx), ctx.query),
  );
  r.org(
    'createContactCompany',
    (ctx) => book.createCompany(ctx.deps.db, contactsActor(ctx), ctx.body),
    { status: 201 },
  );
  r.org('getContactCompany', async (ctx) => {
    const a = contactsActor(ctx);
    const row = await book.loadCompany(ctx.deps.db, a, ctx.params.companyId);
    return (await book.toCompanies(ctx.deps.db, a, [row]))[0]!;
  });
  r.org('updateContactCompany', (ctx) =>
    book.updateCompany(ctx.deps.db, contactsActor(ctx), ctx.params.companyId, ctx.body),
  );
  r.org('deleteContactCompany', async (ctx) => {
    await book.deleteCompany(ctx.deps.db, contactsActor(ctx), ctx.params.companyId);
    return {};
  });

  // CardDAV: personal API tokens as the password (services/contacts/carddav.ts).
  for (const method of DAV_METHODS) {
    r.rawPublic(method, CONTACTS_RAW_PATHS.carddav, ({ c, deps }) => handleCarddav(deps, c));
    r.rawPublic(method, `${CONTACTS_RAW_PATHS.carddav}/*`, ({ c, deps }) => handleCarddav(deps, c));
  }
  r.rawPublic('GET', '/.well-known/carddav', async ({ c }) => c.redirect('/carddav/', 301));
  r.rawPublic('PROPFIND', '/.well-known/carddav', async ({ c }) => c.redirect('/carddav/', 301));
}
