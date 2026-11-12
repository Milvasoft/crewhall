import { bigint, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { organizations } from './org';
import { id, tz } from './types';

/**
 * Profile photos and brand images (H5): small, processed files served without a session from
 * `/api/assets/<id>` (login page, e-mails). Not Drive content: no nodes, versions or quota.
 * A photo belongs to the person across orgs, so org_id may be empty for it.
 */
export const mediaAssets = pgTable(
  'media_assets',
  {
    id: id(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['avatar', 'logoLight', 'logoDark', 'mark', 'favicon'] }).notNull(),
    storageKey: text('storage_key').notNull().unique(),
    mime: text('mime').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('media_assets_owner_idx').on(t.ownerUserId),
    index('media_assets_org_idx').on(t.orgId),
  ],
);
