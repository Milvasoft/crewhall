import { eq } from 'drizzle-orm';
import { calendarAccounts, contacts, type DbOrTx } from '@crewhall/db';
import type { CreateContact, UpdateContact } from '@crewhall/shared';
import type { z } from 'zod';
import { AppError } from '../../../http/errors';
import { loadOwnAccount, type AccountRow, type ExtDeps } from '../../calendar/external/accounts';
import { EWS_REFUSED } from '../../calendar/external/ews/soap';
import { ProviderError } from '../../calendar/external/http';
import type { ContactsActor } from '../access';
import { createContact, deleteContact, loadContact, updateContact } from '../contacts';
import { extFieldsOf, extPatch, localFields, type ContactRow } from './map';
import { applyExt, companyNameOf, contactsClientFor, contactsReadiness } from './sync';
import type { ContactsClient, ExtContact, ExtContactFields } from './types';
import { recordVersion, sameVersion, versionOf } from './versions';

/**
 * Writes to a mirrored contact go to the provider inside the local transaction: a refusal leaves
 * nothing behind, and the row ends up as the provider stored it. Conflicts follow the calendar:
 * write on the known version; when someone else changed it, save theirs and write anyway.
 */

async function provider<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProviderError) {
      if (err.status === 404) throw new AppError('not_found');
      if (err.reason === EWS_REFUSED) throw new AppError('calendar_account_revoked');
      throw new AppError('calendar_external_failed', { status: err.status, reason: err.reason });
    }
    throw err;
  }
}

async function accountOf(db: DbOrTx, row: ContactRow): Promise<AccountRow> {
  const [account] = await db
    .select()
    .from(calendarAccounts)
    .where(eq(calendarAccounts.id, row.accountId!));
  if (!account) throw new AppError('not_found');
  return account;
}

async function lastWriterWins(
  db: DbOrTx,
  client: ContactsClient,
  before: ContactRow,
  company: string | null,
  patch: Partial<ExtContactFields>,
): Promise<ExtContact> {
  const id = before.externalId!;
  try {
    return await client.update(
      id,
      patch,
      before.externalEtag ? { ifMatch: before.externalEtag } : undefined,
    );
  } catch (err) {
    if (!(err instanceof ProviderError) || err.status !== 412) throw err;
  }
  const theirs = await client.get(id);
  if (theirs) {
    const data = versionOf(localFields(theirs, before), theirs.company);
    if (!sameVersion(data, versionOf(before, company))) {
      await recordVersion(db, {
        orgId: before.orgId,
        contactId: before.id,
        source: 'provider',
        data,
        etag: theirs.etag,
      });
    }
  }
  return client.update(id, patch);
}

/** Sends a local change of a mirrored row to the provider. Call inside the row's transaction. */
export async function pushChange(
  deps: ExtDeps,
  tx: DbOrTx,
  before: ContactRow,
  after: ContactRow,
): Promise<ContactRow> {
  if (!before.accountId) return after;
  const [oldCompany, newCompany] = await Promise.all([
    companyNameOf(tx, before.companyId),
    companyNameOf(tx, after.companyId),
  ]);
  const patch = extPatch(extFieldsOf(before, oldCompany), extFieldsOf(after, newCompany));
  // Kind has no place at the provider.
  if (!Object.keys(patch).length) return after;
  const account = await accountOf(deps.db, before);
  const client = contactsClientFor(deps, account);
  const res = await provider(() => lastWriterWins(tx, client, before, oldCompany, patch));
  return applyExt(tx, account, after, res, { written: true });
}

export async function saveContact(
  deps: ExtDeps,
  a: ContactsActor,
  contactId: string,
  patch: UpdateContact,
): Promise<ContactRow> {
  const before = await loadContact(deps.db, a, contactId);
  if (!before.accountId) return updateContact(deps.db, a, contactId, patch);
  return deps.db.transaction(async (tx) => {
    const after = await updateContact(tx, a, contactId, patch);
    return pushChange(deps, tx, before, after);
  });
}

/** New contact; with `accountId` it also goes into that account's address book, as a private one. */
export async function addContact(
  deps: ExtDeps,
  a: ContactsActor,
  input: z.output<typeof CreateContact>,
): Promise<ContactRow> {
  if (!input.accountId) return createContact(deps.db, a, input);
  const account = await loadOwnAccount(deps.db, a.org.id, a.userId, input.accountId);
  if ((await contactsReadiness(deps.db, account)) !== 'ready' || account.status === 'revoked') {
    throw new AppError('contacts_account_unavailable');
  }
  return deps.db.transaction(async (tx) => {
    const row = await createContact(tx, a, { ...input, visibility: 'private' });
    const company = await companyNameOf(tx, row.companyId);
    const client = contactsClientFor(deps, account);
    const res = await provider(() => client.create(extFieldsOf(row, company)));
    const [linked] = await tx
      .update(contacts)
      .set({ accountId: account.id, externalId: res.id, externalEtag: res.etag })
      .where(eq(contacts.id, row.id))
      .returning();
    return applyExt(tx, account, linked!, res, { written: true });
  });
}

/** Deleted at the provider first; only then here. */
export async function removeMirrored(deps: ExtDeps, row: ContactRow) {
  if (!row.accountId) return;
  const account = await accountOf(deps.db, row);
  const client = contactsClientFor(deps, account);
  await provider(() => client.remove(row.externalId!));
}

export async function removeContact(deps: ExtDeps, a: ContactsActor, contactId: string) {
  const row = await loadContact(deps.db, a, contactId);
  if (!row.accountId) return deleteContact(deps.db, a, contactId);
  // Rights first: the provider's copy must not go on a refused request.
  await deps.db.transaction(async (tx) => {
    await deleteContact(tx, a, contactId);
    await removeMirrored(deps, row);
  });
}
