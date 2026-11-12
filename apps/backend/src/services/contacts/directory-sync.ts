import { eq } from 'drizzle-orm';
import { directoryProfiles, externalIdentities, type DbOrTx } from '@crewhall/db';
import { fillFilter, withServiceBind } from '../identity/ldap';
import { enabledDirectories, type DirectoryDeps } from '../identity/directory';
import { configOf, secretOf } from '../identity/providers';
import type { DirectoryField } from '@crewhall/shared';
import { contactsEnabled } from './access';

/**
 * contacts.directory_sync (hourly, after identity's account sync): profile attributes of the
 * people identity already linked to AD/LDAP entries (external_identities.dn). Nothing about
 * accounts is copied: names, e-mails and status stay identity's. Fields the directory fills
 * become read-only in the app (synced_fields); emptied ones are released again.
 */

/** LDAP attribute → directory field (AD names; OpenLDAP inetOrgPerson uses the same ones). */
const ATTRIBUTES = {
  title: 'title',
  department: 'department',
  team: 'division',
  phone: 'telephoneNumber',
  mobile: 'mobile',
  location: 'physicalDeliveryOfficeName',
  managerId: 'manager',
} as const satisfies Record<DirectoryField, string>;

export interface DirectoryEntry {
  dn: string;
  values: Partial<Record<DirectoryField, string>>;
}

const firstValue = (v: unknown): string | null => {
  const x = Array.isArray(v) ? v[0] : v;
  if (x === undefined || x === null) return null;
  const s = (Buffer.isBuffer(x) ? x.toString('utf8') : String(x)).trim();
  return s || null;
};

/** Entries of a directory with the profile attributes (paged search with the user filter). */
type LdapProvider = Awaited<ReturnType<typeof enabledDirectories>>[number];

async function fetchEntries(provider: LdapProvider, secret: string | null) {
  const config = configOf(provider);
  return withServiceBind(config, secret, async (client) => {
    const { searchEntries } = await client.search(config.baseDn, {
      scope: 'sub',
      filter: fillFilter(config.userFilter, { username: '*' }, true),
      attributes: Object.values(ATTRIBUTES),
      paged: { pageSize: 500 },
    });
    return searchEntries.map((e): DirectoryEntry => {
      const values: DirectoryEntry['values'] = {};
      for (const [field, attr] of Object.entries(ATTRIBUTES) as [DirectoryField, string][]) {
        const v = firstValue(e[attr]);
        if (v) values[field] = v.slice(0, field === 'managerId' ? 1000 : 120);
      }
      return { dn: e.dn, values };
    });
  });
}

const dnKey = (dn: string) => dn.replace(/\s*,\s*/g, ',').toLowerCase();

/**
 * Writes directory values onto the profiles of the linked people of one provider. The manager
 * attribute (a DN) becomes the user linked to that DN; unknown managers are left empty.
 * Returns the number of profiles touched.
 */
export async function applyDirectoryEntries(
  db: DbOrTx,
  provider: { id: string; orgId: string },
  entries: DirectoryEntry[],
  now = new Date(),
) {
  const links = await db
    .select({ userId: externalIdentities.userId, dn: externalIdentities.dn })
    .from(externalIdentities)
    .where(eq(externalIdentities.providerId, provider.id));
  const byDn = new Map(links.filter((l) => l.dn).map((l) => [dnKey(l.dn!), l.userId]));
  let touched = 0;
  for (const e of entries) {
    const userId = byDn.get(dnKey(e.dn));
    if (!userId) continue;
    await writeSyncedProfile(db, provider.orgId, userId, e.values, (v) => byDn.get(dnKey(v)), now);
    touched++;
  }
  return touched;
}

/**
 * One person's profile from a directory (AD/LDAP or Google Workspace): the fields it fills are
 * written and become read-only (synced_fields); fields it left empty are released with their
 * last value. `managerOf` turns the directory's manager reference into a user id.
 */
export async function writeSyncedProfile(
  db: DbOrTx,
  orgId: string,
  userId: string,
  values: Partial<Record<DirectoryField, string>>,
  managerOf: (ref: string) => string | undefined,
  now = new Date(),
) {
  const synced = new Set<DirectoryField>();
  const set: Record<string, string | null> = {};
  for (const field of Object.keys(ATTRIBUTES) as DirectoryField[]) {
    const v = values[field];
    if (!v) {
      // Emptied in the directory: the app takes the field back with its last value.
      continue;
    }
    if (field === 'managerId') {
      const manager = managerOf(v);
      if (!manager || manager === userId) continue;
      set.managerId = manager;
    } else set[field] = v;
    synced.add(field);
  }
  const row = { ...set, syncedFields: [...synced], syncedAt: now };
  await db
    .insert(directoryProfiles)
    .values({ orgId, userId, ...row })
    .onConflictDoUpdate({
      target: [directoryProfiles.orgId, directoryProfiles.userId],
      set: { ...row, updatedAt: now },
    });
}

export async function syncDirectoryProfiles(deps: DirectoryDeps) {
  let total = 0;
  for (const provider of await enabledDirectories(deps)) {
    if (!provider.syncEnabled || !(await contactsEnabled(deps.db, provider.orgId))) continue;
    try {
      const entries = await fetchEntries(provider, secretOf(deps.env, provider));
      total += await applyDirectoryEntries(deps.db, provider, entries);
    } catch (err) {
      deps.logger.warn({ err, provider: provider.id }, 'directory profile sync failed');
    }
  }
  return total;
}
