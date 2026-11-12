import { bigint, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { tz } from './types';

/**
 * Drive change log behind listDriveChanges (Windows virtual drive). Postgres triggers on nodes,
 * shares, space_members and spaces write it (migration `drive_changes`), so no writer of the tree
 * can forget. Rows hold ids and ltree paths only, never names, and are pruned after
 * DRIVE_CHANGES_RETENTION_DAYS.
 *
 * Readers walk (txid, seq) and only below the oldest running transaction: sequence numbers are
 * taken before commit, so walking seq alone could step past a transaction that commits later.
 *
 * No foreign keys: rows outlive the node, space or org they describe.
 */
export const driveChanges = pgTable(
  'drive_changes',
  {
    seq: bigint('seq', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** pg_current_xact_id() of the writing transaction. */
    txid: bigint('txid', { mode: 'number' }).notNull(),
    orgId: uuid('org_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    /** Moves: where the node was, with prevPath. */
    prevSpaceId: uuid('prev_space_id'),
    /** Null for changes of a whole space. */
    nodeId: uuid('node_id'),
    nodeType: text('node_type'),
    /** Access changes concern this person only; null = everyone who can see the node. */
    userId: uuid('user_id'),
    kind: text('kind', {
      enum: [
        'created',
        'updated',
        'moved',
        'trashed',
        'purged',
        'access_granted',
        'access_changed',
        'access_lost',
        'space_updated',
        'space_removed',
        'space_restored',
      ],
    }).notNull(),
    path: text('path'),
    prevPath: text('prev_path'),
    at: tz('at').notNull().defaultNow(),
  },
  (t) => [
    index('drive_changes_org_position_idx').on(t.orgId, t.txid, t.seq),
    index('drive_changes_at_idx').on(t.at),
  ],
);
