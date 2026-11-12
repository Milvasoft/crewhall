import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { organizations } from './org';
import { spaces } from './space';
import { id, textTr, timestamps } from './types';

/**
 * Template gallery (roadmap 8): saved page, board and space templates; built-in ones live in
 * code. `kind` names the content shape (`page`, `board`, `space`; forms later) and `content`
 * holds it, validated by the shared `TemplateContent` schema of that kind.
 *
 * Scope: `org` (whole organisation, org admins manage), `space` (`space_id`, space admins
 * manage), `personal` (`owner_user_id`).
 */
export const templates = pgTable(
  'templates',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    scope: text('scope', { enum: ['org', 'space', 'personal'] }).notNull(),
    spaceId: uuid('space_id').references(() => spaces.id, { onDelete: 'cascade' }),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    name: textTr('name').notNull(),
    description: text('description').notNull().default(''),
    category: text('category').notNull().default('team'),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    index('templates_org_kind_idx').on(t.orgId, t.kind),
    index('templates_space_idx').on(t.spaceId),
    index('templates_owner_idx').on(t.ownerUserId),
  ],
);
