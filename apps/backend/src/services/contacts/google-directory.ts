import { and, eq, inArray, sql } from 'drizzle-orm';
import { calendarIntegrations, orgMembers, users, type DbOrTx } from '@crewhall/db';
import type { DirectoryField } from '@crewhall/shared';
import { apiCall, ProviderError } from '../calendar/external/http';
import { serviceAccountOf } from '../calendar/external/integrations';
import { serviceAccountToken } from '../calendar/external/service-account';
import type { DirectoryDeps } from '../identity/directory';
import { contactsEnabled } from './access';
import { writeSyncedProfile } from './directory-sync';

/**
 * Google Workspace directory (sonraki-isler, org chart): title, department, team (cost center),
 * phones, location and manager of every Workspace user, read with the Directory API as the
 * admin the service account impersonates. People are matched by e-mail to active org members;
 * the fields Google fills become read-only like AD/LDAP ones.
 */

export const DIRECTORY_SCOPE = 'https://www.googleapis.com/auth/admin.directory.user.readonly';
const USERS_URL = 'https://admin.googleapis.com/admin/directory/v1/users';

interface GoogleUser {
  primaryEmail?: string;
  emails?: { address?: string }[];
  organizations?: {
    title?: string;
    department?: string;
    costCenter?: string;
    description?: string;
    location?: string;
    primary?: boolean;
  }[];
  phones?: { value?: string; type?: string; primary?: boolean }[];
  locations?: { buildingId?: string; floorName?: string; area?: string }[];
  relations?: { value?: string; type?: string }[];
  suspended?: boolean;
}

const clip = (v: string | undefined, n = 120) => {
  const s = v?.trim();
  return s ? s.slice(0, n) : undefined;
};

/** A Workspace user's directory fields (manager as the manager's e-mail). */
export function googleValues(u: GoogleUser): Partial<Record<DirectoryField, string>> {
  const org = u.organizations?.find((o) => o.primary) ?? u.organizations?.[0];
  const phone = (type: string) =>
    clip(u.phones?.find((p) => p.type === type)?.value, 40) ??
    (type === 'work' ? clip(u.phones?.find((p) => p.primary)?.value, 40) : undefined);
  const place = u.locations?.[0];
  const values: Partial<Record<DirectoryField, string>> = {
    title: clip(org?.title),
    department: clip(org?.department),
    team: clip(org?.costCenter ?? org?.description),
    phone: phone('work'),
    mobile: phone('mobile'),
    location: clip(
      org?.location ?? [place?.buildingId, place?.floorName].filter(Boolean).join(' · '),
    ),
    managerId: clip(u.relations?.find((r) => r.type === 'manager')?.value, 254),
  };
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v)) as typeof values;
}

async function workspaceUsers(token: string): Promise<GoogleUser[]> {
  const out: GoogleUser[] = [];
  let pageToken: string | undefined;
  // 500 per page; 40 pages are 20,000 people.
  for (let i = 0; i < 40; i++) {
    const url = new URL(USERS_URL);
    url.searchParams.set('customer', 'my_customer');
    url.searchParams.set('projection', 'full');
    url.searchParams.set('maxResults', '500');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const page = (await apiCall(url.toString(), { token })) as {
      users?: GoogleUser[];
      nextPageToken?: string;
    } | null;
    out.push(...(page?.users ?? []));
    pageToken = page?.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

/** One org: returns the number of profiles written. Throws ProviderError. */
export async function syncGoogleDirectory(
  deps: Pick<DirectoryDeps, 'db' | 'env'>,
  row: typeof calendarIntegrations.$inferSelect,
  now = new Date(),
) {
  const key = serviceAccountOf(deps.env, row);
  if (!key || !row.delegatedAdmin) throw new ProviderError(400, 'service_account_missing');
  const token = await serviceAccountToken(key, DIRECTORY_SCOPE, row.delegatedAdmin);
  const people = (await workspaceUsers(token)).filter((u) => !u.suspended && u.primaryEmail);
  const emailsOf = (u: GoogleUser) =>
    [u.primaryEmail, ...(u.emails ?? []).map((e) => e.address)]
      .filter((e): e is string => Boolean(e))
      .map((e) => e.toLowerCase());
  const managers = people.flatMap((u) =>
    (u.relations ?? [])
      .filter((r) => r.type === 'manager' && r.value)
      .map((r) => r.value!.toLowerCase()),
  );
  const all = [...new Set([...people.flatMap(emailsOf), ...managers])];
  const members = all.length
    ? await membersByEmail(deps.db, row.orgId, all)
    : new Map<string, string>();
  let touched = 0;
  for (const u of people) {
    const userId = emailsOf(u)
      .map((e) => members.get(e))
      .find(Boolean);
    if (!userId) continue;
    await writeSyncedProfile(
      deps.db,
      row.orgId,
      userId,
      googleValues(u),
      (email) => members.get(email.toLowerCase()),
      now,
    );
    touched++;
  }
  return touched;
}

async function membersByEmail(db: DbOrTx, orgId: string, emails: string[]) {
  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(
      and(
        eq(orgMembers.organizationId, orgId),
        eq(orgMembers.status, 'active'),
        inArray(sql`lower(${users.email})`, emails),
      ),
    );
  return new Map(rows.map((r) => [r.email.toLowerCase(), r.id]));
}

/** Records the outcome on the integration (shown in Yönetim › Takvim). */
export async function runGoogleDirectorySync(
  deps: Pick<DirectoryDeps, 'db' | 'env'>,
  row: typeof calendarIntegrations.$inferSelect,
) {
  let error: string | null = null;
  let touched = 0;
  try {
    touched = await syncGoogleDirectory(deps, row);
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    error = err.reason;
  }
  await deps.db
    .update(calendarIntegrations)
    .set({ directorySyncedAt: new Date(), directoryError: error })
    .where(
      and(eq(calendarIntegrations.orgId, row.orgId), eq(calendarIntegrations.provider, 'google')),
    );
  return { touched, error };
}

/** contacts.directory_sync (hourly): every org with Workspace directory sync on. */
export async function syncGoogleDirectories(deps: DirectoryDeps) {
  const rows = await deps.db
    .select()
    .from(calendarIntegrations)
    .where(
      and(
        eq(calendarIntegrations.provider, 'google'),
        eq(calendarIntegrations.directorySync, true),
      ),
    );
  let total = 0;
  for (const row of rows) {
    if (!(await contactsEnabled(deps.db, row.orgId))) continue;
    const { touched, error } = await runGoogleDirectorySync(deps, row);
    if (error) deps.logger.warn({ org: row.orgId, error }, 'google directory sync failed');
    total += touched;
  }
  return total;
}
