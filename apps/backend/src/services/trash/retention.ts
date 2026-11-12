import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { organizations } from '@crewhall/db';
import { TRASH_RETENTION_DAYS, type OrgSettings } from '@crewhall/shared';

/** Days a trashed item stays restorable in the org (Yönetim › Genel); default 30. */
export function trashRetentionDays(
  settings: Pick<OrgSettings, 'trashRetentionDays'> | null | undefined,
) {
  return settings?.trashRetentionDays ?? TRASH_RETENTION_DAYS;
}

/** When an item trashed at `deletedAt` is purged for good under the org's setting. */
export function purgeDate(
  deletedAt: Date,
  settings: Pick<OrgSettings, 'trashRetentionDays'> | null | undefined,
) {
  return new Date(deletedAt.getTime() + trashRetentionDays(settings) * 86_400_000);
}

/**
 * SQL condition for purge jobs: the row's `deletedAt` is older than its own org's retention.
 * The org is looked up per row, so one job serves every org with its own setting.
 */
export function pastTrashRetention(deletedAt: AnyColumn, orgId: AnyColumn, now = new Date()): SQL {
  const days = sql`(select coalesce((o.settings->>'trashRetentionDays')::int, ${TRASH_RETENTION_DAYS}) from ${organizations} o where o.id = ${orgId})`;
  return sql`${deletedAt} < ${now.toISOString()}::timestamptz - make_interval(days => ${days})`;
}
