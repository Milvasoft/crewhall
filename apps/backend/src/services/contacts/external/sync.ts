import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  calendarAccounts,
  contactCompanies,
  contacts,
  type ContactsSyncState,
  type DbOrTx,
} from '@crewhall/db';
import { AppError } from '../../../http/errors';
import type { AccountRow, ExtDeps } from '../../calendar/external/accounts';
import { apiFor, graphRoot } from '../../calendar/external/accounts';
import { ProviderError } from '../../calendar/external/http';
import { loadIntegration } from '../../calendar/external/integrations';
import { contactsEnabled } from '../access';
import { searchTextOf } from '../contacts';
import { exchangeConnection } from '../../calendar/external/ews/connect';
import { exchangeContacts } from './exchange';
import { localFields, type ContactRow } from './map';
import { microsoftContacts } from './microsoft';
import { dropMirror } from './mirror';
import type { ContactsClient, ExtContact } from './types';
import { recordVersion, sameVersion, versionOf } from './versions';

/**
 * Mirrors the address book of a connected account into the person's private contacts, on the
 * calendar's schedule and with the calendar's rules: same account, the provider is the source of
 * truth, a busy-only account brings nothing in, the mirror leaves with the account.
 */

export function contactsClientFor(
  deps: Pick<ExtDeps, 'db' | 'env'>,
  account: AccountRow,
): ContactsClient {
  return account.provider === 'exchange'
    ? exchangeContacts(exchangeConnection(deps, account))
    : microsoftContacts(apiFor(deps, account), graphRoot(account));
}

export async function companyNameOf(db: DbOrTx, companyId: string | null) {
  if (!companyId) return null;
  const [c] = await db
    .select({ name: contactCompanies.name })
    .from(contactCompanies)
    .where(eq(contactCompanies.id, companyId));
  return c?.name ?? null;
}

/** A company the person can see with that name, or a new private one. */
async function companyIdFor(
  db: DbOrTx,
  account: AccountRow,
  name: string,
  cache: Map<string, string>,
) {
  const key = name.toLocaleLowerCase('tr');
  const hit = cache.get(key);
  if (hit) return hit;
  const [found] = await db
    .select({ id: contactCompanies.id })
    .from(contactCompanies)
    .where(
      and(
        eq(contactCompanies.orgId, account.orgId),
        isNull(contactCompanies.deletedAt),
        or(eq(contactCompanies.visibility, 'org'), eq(contactCompanies.createdBy, account.userId)),
        sql`lower(${contactCompanies.name}) = lower(${name})`,
      ),
    )
    .limit(1);
  const id =
    found?.id ??
    (
      await db
        .insert(contactCompanies)
        .values({
          orgId: account.orgId,
          name,
          kind: 'other',
          visibility: 'private',
          createdBy: account.userId,
        })
        .returning({ id: contactCompanies.id })
    )[0]!.id;
  cache.set(key, id);
  return id;
}

/**
 * Writes the provider's version onto a row. `written`: it is the answer to Crewhall's own write,
 * so nothing was lost; otherwise a version Crewhall wrote and the provider replaced is saved.
 */
export async function applyExt(
  db: DbOrTx,
  account: AccountRow,
  row: ContactRow,
  ext: ExtContact,
  opts: { written?: boolean; companies?: Map<string, string> } = {},
): Promise<ContactRow> {
  const fields = localFields(ext, row);
  const company = ext.company ? ext.company.slice(0, 160) : null;
  const oldCompany = await companyNameOf(db, row.companyId);
  const old = versionOf(row, oldCompany);
  const same = sameVersion(old, versionOf({ ...row, ...fields }, company));
  if (row.writtenHere && !same && !opts.written) {
    await recordVersion(db, {
      orgId: row.orgId,
      contactId: row.id,
      source: 'crewhall',
      data: old,
      etag: row.externalEtag,
    });
  }
  const companyId =
    company === null
      ? null
      : oldCompany?.toLocaleLowerCase('tr') === company.toLocaleLowerCase('tr')
        ? row.companyId
        : await companyIdFor(db, account, company, opts.companies ?? new Map());
  const [fresh] = await db
    .update(contacts)
    .set({
      ...fields,
      companyId,
      searchText: searchTextOf({ ...fields, company }),
      externalEtag: ext.etag,
      writtenHere: opts.written ? true : row.writtenHere && same,
      ...(same && !opts.written ? {} : { updatedAt: new Date() }),
    })
    .where(eq(contacts.id, row.id))
    .returning();
  return fresh!;
}

async function insertExt(
  db: DbOrTx,
  account: AccountRow,
  ext: ExtContact,
  companies: Map<string, string>,
) {
  const fields = localFields(ext, null);
  const company = ext.company ? ext.company.slice(0, 160) : null;
  await db
    .insert(contacts)
    .values({
      orgId: account.orgId,
      uid: randomUUID(),
      kind: 'other',
      ...fields,
      companyId: company ? await companyIdFor(db, account, company, companies) : null,
      visibility: 'private',
      searchText: searchTextOf({ ...fields, company }),
      createdBy: account.userId,
      accountId: account.id,
      externalId: ext.id,
      externalEtag: ext.etag,
    })
    .onConflictDoNothing();
}

async function saveState(db: DbOrTx, account: AccountRow, state: ContactsSyncState | null) {
  await db
    .update(calendarAccounts)
    .set({ contactsState: state })
    .where(eq(calendarAccounts.id, account.id));
  account.contactsState = state;
}

/** Why an account's address book does not sync, if so. */
export async function contactsReadiness(
  db: DbOrTx,
  account: AccountRow,
): Promise<'off' | 'needs_consent' | 'ready'> {
  if (account.provider === 'google' || account.busyOnly) return 'off';
  const integration = await loadIntegration(db, account.orgId, account.provider);
  if (!integration?.enabled || !integration.contactsSync) return 'off';
  if (!(await contactsEnabled(db, account.orgId))) return 'off';
  // Application access has every permission the admin consented to; a person's token only what
  // was asked for when they connected.
  return account.delegated || account.contactsGranted ? 'ready' : 'needs_consent';
}

/** Pulls the account's contact changes. Never throws; it does not touch the calendar's status. */
export async function syncContacts(deps: ExtDeps, account: AccountRow): Promise<void> {
  const { db } = deps;
  const readiness = await contactsReadiness(db, account);
  if (readiness === 'off') {
    if (account.contactsState) {
      await dropMirror(db, [account.id]);
      await saveState(db, account, null);
    }
    return;
  }
  const previous = account.contactsState;
  const stateWith = (patch: Partial<ContactsSyncState>): ContactsSyncState => ({
    cursor: previous?.cursor ?? null,
    status: 'active',
    lastError: null,
    lastSyncedAt: previous?.lastSyncedAt ?? null,
    count: previous?.count ?? 0,
    ...patch,
  });
  if (readiness === 'needs_consent') {
    await saveState(db, account, stateWith({ status: 'needs_consent' }));
    return;
  }
  try {
    const client = contactsClientFor(deps, account);
    const startedAt = new Date();
    let res;
    try {
      res = await client.delta(previous?.cursor ?? null);
    } catch (err) {
      if (!(err instanceof ProviderError) || !err.gone) throw err;
      res = await client.delta(null);
    }
    const existing = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.accountId, account.id), isNull(contacts.deletedAt)));
    const byId = new Map(existing.map((r) => [r.externalId, r]));
    const companies = new Map<string, string>();
    for (const ext of res.items) {
      const row = byId.get(ext.id);
      if (!row) await insertExt(db, account, ext, companies);
      else if (!row.externalEtag || row.externalEtag !== ext.etag) {
        await applyExt(db, account, row, ext, { companies });
      }
    }
    const seen = new Set(res.items.map((c) => c.id));
    const gone = res.full
      ? existing.filter((r) => !seen.has(r.externalId!) && r.updatedAt < startedAt)
      : existing.filter((r) => res.removed.includes(r.externalId!));
    if (gone.length) {
      await db
        .update(contacts)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          inArray(
            contacts.id,
            gone.map((r) => r.id),
          ),
        );
    }
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(contacts)
      .where(and(eq(contacts.accountId, account.id), isNull(contacts.deletedAt)));
    await saveState(
      db,
      account,
      stateWith({
        cursor: res.cursor,
        lastSyncedAt: new Date().toISOString(),
        count: count?.n ?? 0,
      }),
    );
  } catch (err) {
    // Only Microsoft has a permission to grant; Exchange's sign-in reaches its own mailbox.
    const denied =
      err instanceof ProviderError && err.status === 403 && account.provider === 'microsoft';
    const lastError =
      err instanceof ProviderError
        ? `provider:${err.status}:${err.reason}`.slice(0, 200)
        : err instanceof AppError
          ? err.code
          : 'calendar_external_failed';
    deps.logger.warn({ err, accountId: account.id, code: lastError }, 'contacts sync failed');
    await saveState(
      db,
      account,
      stateWith({ status: denied ? 'needs_consent' : 'error', lastError }),
    );
  }
}
