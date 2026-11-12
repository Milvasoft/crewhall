import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { conversations } from './chat';
import { blobs } from './drive';
import { organizations } from './org';
import { nodes } from './space';
import { id, textC, textTr, timestamps, tz } from './types';

/**
 * Boards and drawings (doc 17 §4 "Sayfa, pano, çizim"). Owned by the boards session.
 *
 * Board structure is relational so "assigned to me" and notifications can query it; a card's
 * description is the Yjs document `card:<id>` (desc_ydoc) with a derived plain text. Drawing
 * scenes are Yjs documents `drawing:<nodeId>` (Excalidraw elements in a Y.Map).
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/** Shape of boards.settings; validated by BoardSettings in @crewhall/shared. */
export interface BoardSettingsData {
  key: string;
  template: 'empty' | 'sprint' | 'roadmap' | 'bugs';
  labels: { id: string; name: string; color: string }[];
  cardChats: boolean;
  fields: { points: boolean; priority: boolean };
  doneArchiveDays: number | null;
  sprint: { name: string; startsOn: string; endsOn: string } | null;
  capacityHours?: number;
}

export interface ChecklistItemData {
  id: string;
  text: string;
  done: boolean;
  assigneeId: string | null;
}

export const boards = pgTable('boards', {
  nodeId: uuid('node_id')
    .primaryKey()
    .references(() => nodes.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').$type<BoardSettingsData>().notNull(),
  /** Last card number handed out (`MLV-142`). */
  cardSeq: integer('card_seq').notNull().default(0),
  /** Bumped on every structural change; clients compare it to refetch. */
  rev: integer('rev').notNull().default(0),
  ...timestamps(),
});

export interface SprintResultData {
  unit: 'points' | 'cards';
  done: number;
  total: number;
}

/**
 * Sprints of a board (kararlar 2026-10-29). At most one is active per board; a card with no
 * sprint is in the backlog. Burndown is computed from the cards (sprint_added_at, done_at).
 */
export const boardSprints = pgTable(
  'board_sprints',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    boardNodeId: uuid('board_node_id')
      .notNull()
      .references(() => boards.nodeId, { onDelete: 'cascade' }),
    name: textTr('name').notNull(),
    goal: text('goal').notNull().default(''),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    status: text('status', { enum: ['planned', 'active', 'closed'] })
      .notNull()
      .default('planned'),
    startedAt: tz('started_at'),
    closedAt: tz('closed_at'),
    /** Kept when the sprint closes: done of total, in the board's unit then. */
    result: jsonb('result').$type<SprintResultData>(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    index('board_sprints_board_idx').on(t.boardNodeId, t.startsOn),
    uniqueIndex('board_sprints_one_active_uq')
      .on(t.boardNodeId)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const boardColumns = pgTable(
  'board_columns',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    boardNodeId: uuid('board_node_id')
      .notNull()
      .references(() => boards.nodeId, { onDelete: 'cascade' }),
    name: textTr('name').notNull(),
    position: textC('position').notNull(),
    wipLimit: integer('wip_limit'),
    isDone: boolean('is_done').notNull().default(false),
    ...timestamps(),
  },
  (t) => [index('board_columns_board_pos_idx').on(t.boardNodeId, t.position)],
);

export const boardCards = pgTable(
  'board_cards',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    boardNodeId: uuid('board_node_id')
      .notNull()
      .references(() => boards.nodeId, { onDelete: 'cascade' }),
    columnId: uuid('column_id')
      .notNull()
      .references(() => boardColumns.id, { onDelete: 'restrict' }),
    number: integer('number').notNull(),
    position: textC('position').notNull(),
    title: textTr('title').notNull(),
    /** Yjs state of `card:<id>` (encodeStateAsUpdate); null until first written. */
    descYdoc: bytea('desc_ydoc'),
    /** Plain text derived from desc_ydoc; never written by clients directly. */
    descText: text('desc_text').notNull().default(''),
    /** Planned start on the timeline; the end is due_at. */
    startAt: tz('start_at'),
    /** Planned effort in minutes (time tracking). */
    estimateMinutes: integer('estimate_minutes'),
    dueAt: tz('due_at'),
    labels: text('labels')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    points: integer('points'),
    priority: text('priority', { enum: ['p1', 'p2', 'p3'] }),
    checklist: jsonb('checklist').$type<ChecklistItemData[]>().notNull().default([]),
    /** Chat conversation of type `card`, opened with the first message. */
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    /** Planned or active sprint the card is in; null = backlog. */
    sprintId: uuid('sprint_id').references(() => boardSprints.id, { onDelete: 'set null' }),
    /** When the card joined its sprint (burndown scope). */
    sprintAddedAt: tz('sprint_added_at'),
    commentCount: integer('comment_count').notNull().default(0),
    attachmentCount: integer('attachment_count').notNull().default(0),
    /** Set while the card sits in a done column. */
    doneAt: tz('done_at'),
    archivedAt: tz('archived_at'),
    deletedAt: tz('deleted_at'),
    /** Last "due soon" notification sent for this due date. */
    dueNotifiedAt: tz('due_notified_at'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    search: tsvector('search').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("desc_text", ''))`,
    ),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('board_cards_board_number_uq').on(t.boardNodeId, t.number),
    index('board_cards_column_pos_idx').on(t.columnId, t.position),
    index('board_cards_due_idx')
      .on(t.dueAt)
      .where(sql`${t.dueAt} is not null and ${t.archivedAt} is null and ${t.deletedAt} is null`),
    index('board_cards_search_idx').using('gin', t.search),
    index('board_cards_sprint_idx').on(t.sprintId),
  ],
);

export const cardAssignees = pgTable(
  'card_assignees',
  {
    cardId: uuid('card_id')
      .notNull()
      .references(() => boardCards.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    assignedBy: uuid('assigned_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.cardId, t.userId] }),
    index('card_assignees_user_idx').on(t.userId),
  ],
);

/**
 * Card dependencies (kararlar 2026-10-29): from blocks to, from relates to, from duplicates
 * to (the original). Cards may sit on different boards of the org.
 */
export const boardCardLinks = pgTable(
  'board_card_links',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    fromCardId: uuid('from_card_id')
      .notNull()
      .references(() => boardCards.id, { onDelete: 'cascade' }),
    toCardId: uuid('to_card_id')
      .notNull()
      .references(() => boardCards.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['blocks', 'relates', 'duplicates'] }).notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('board_card_links_uq').on(t.fromCardId, t.toCardId, t.kind),
    index('board_card_links_to_idx').on(t.toCardId),
  ],
);

/**
 * Time logged on cards (kararlar 2026-10-29): from a timer (minutes null while it runs, one
 * running per person) or typed in.
 */
export const boardTimeEntries = pgTable(
  'board_time_entries',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    cardId: uuid('card_id')
      .notNull()
      .references(() => boardCards.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startedAt: tz('started_at').notNull(),
    minutes: integer('minutes'),
    note: text('note').notNull().default(''),
    source: text('source', { enum: ['timer', 'manual'] }).notNull(),
    ...timestamps(),
  },
  (t) => [
    index('board_time_entries_card_idx').on(t.cardId, t.startedAt),
    index('board_time_entries_user_idx').on(t.userId, t.startedAt),
    uniqueIndex('board_time_entries_running_uq')
      .on(t.userId)
      .where(sql`${t.minutes} is null`),
  ],
);

/** Assignees and commenters follow a card; followers get comment notifications. */
export const boardCardFollowers = pgTable(
  'board_card_followers',
  {
    cardId: uuid('card_id')
      .notNull()
      .references(() => boardCards.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Explicit unfollow: automatic follows do not bring it back. */
    muted: boolean('muted').notNull().default(false),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.userId] })],
);

/** System lines and comments of a card (design 6.3 "Aktivite"). */
export const boardCardActivity = pgTable(
  'board_card_activity',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    cardId: uuid('card_id')
      .notNull()
      .references(() => boardCards.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    text: text('text'),
    data: jsonb('data')
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
    editedAt: tz('edited_at'),
    deletedAt: tz('deleted_at'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('board_card_activity_card_idx').on(t.cardId, t.createdAt)],
);

/** Drive nodes attached to a card (design 6.3 "Ekler · Drive"). */
export const boardCardAttachments = pgTable(
  'board_card_attachments',
  {
    cardId: uuid('card_id')
      .notNull()
      .references(() => boardCards.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.nodeId] })],
);

export const drawings = pgTable('drawings', {
  nodeId: uuid('node_id')
    .primaryKey()
    .references(() => nodes.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  /** Yjs state of `drawing:<nodeId>`. */
  ydoc: bytea('ydoc'),
  sceneRev: integer('scene_rev').notNull().default(0),
  elementCount: integer('element_count').notNull().default(0),
  /** Rendered by the drawing.thumbnail job; derivatives hang off this blob. */
  thumbnailBlobId: uuid('thumbnail_blob_id').references(() => blobs.id, { onDelete: 'set null' }),
  /** scene_rev the thumbnail shows. */
  thumbnailRev: integer('thumbnail_rev').notNull().default(0),
  ...timestamps(),
});

/** Images embedded in a drawing; the scene references them by Excalidraw file id. */
export const drawingFiles = pgTable(
  'drawing_files',
  {
    nodeId: uuid('node_id')
      .notNull()
      .references(() => drawings.nodeId, { onDelete: 'cascade' }),
    fileId: text('file_id').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    blobId: uuid('blob_id')
      .notNull()
      .references(() => blobs.id, { onDelete: 'restrict' }),
    mime: text('mime').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.fileId] })],
);

export const libraryOwnerType = pgEnum('drawing_library_owner', ['user', 'space']);

/** Shape library (design 6.12): one per person and one per space. */
export const drawingLibraries = pgTable(
  'drawing_libraries',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ownerType: libraryOwnerType('owner_type').notNull(),
    ownerId: uuid('owner_id').notNull(),
    items: jsonb('items').$type<Record<string, unknown>[]>().notNull().default([]),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [uniqueIndex('drawing_libraries_owner_uq').on(t.orgId, t.ownerType, t.ownerId)],
);
