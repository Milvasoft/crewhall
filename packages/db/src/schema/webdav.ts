import { index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { organizations } from './org';
import { nodes } from './space';
import { id, timestamps, tz } from './types';

/**
 * WebDAV locks (RFC 4918 §6, roadmap 9). Windows and Office lock a file before writing it.
 * A lock sits on a node; a depth-infinity lock on a folder covers its subtree through the
 * ltree path, so locks follow the node when it is moved. The lock token is
 * `opaquelocktoken:<id>`.
 */
export const davLocks = pgTable(
  'dav_locks',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['exclusive', 'shared'] }).notNull(),
    depth: text('depth', { enum: ['0', 'infinity'] }).notNull(),
    /** The client's DAV:owner element, sent back in lockdiscovery as it came. */
    owner: text('owner'),
    timeoutSeconds: integer('timeout_seconds').notNull(),
    expiresAt: tz('expires_at').notNull(),
    ...timestamps(),
  },
  (t) => [index('dav_locks_node_idx').on(t.nodeId), index('dav_locks_expires_idx').on(t.expiresAt)],
);
