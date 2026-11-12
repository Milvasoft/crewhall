import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { organizations } from './org';
import { nodes, spaces } from './space';
import { id, textTr, timestamps, tz } from './types';

/**
 * Forms and surveys (roadmap 16). Owned by the forms session.
 *
 * The definition (fields, settings) is JSON validated by FormField / FormSettings in
 * @crewhall/shared; answers are JSON keyed by field id, so editing a form never rewrites old
 * answers. Uploaded files of file fields live in object storage under `forms/…`, tracked here
 * (they are not Drive nodes: a public respondent has no Drive identity).
 */

/** Shape of forms.fields; validated by FormField in @crewhall/shared. */
export interface FormFieldData {
  id: string;
  type:
    | 'short_text'
    | 'long_text'
    | 'single_choice'
    | 'multi_choice'
    | 'date'
    | 'number'
    | 'file'
    | 'rating';
  label: string;
  help: string | null;
  required: boolean;
  choices: { id: string; label: string }[];
  min: number | null;
  max: number | null;
  maxFiles: number;
  showIf: {
    fieldId: string;
    op: 'equals' | 'not_equals' | 'includes' | 'answered' | 'not_answered';
    value: string | null;
  } | null;
}

/** Shape of forms.settings; validated by FormSettings in @crewhall/shared. */
export interface FormSettingsData {
  access: 'org' | 'public';
  anonymous: boolean;
  oneResponse: boolean;
  confirmation: string | null;
  notifyOnResponse: boolean;
  closesAt: string | null;
  destinations: {
    drive: { parentId: string | null } | null;
    board: { boardId: string; columnId: string; titleFieldId: string | null } | null;
    /** Added with tables; older rows lack it (= null). */
    table?: { tableId: string } | null;
  };
}

export type FormAnswerData =
  | string
  | number
  | string[]
  | { fileId: string; name: string; mime: string; sizeBytes: number }[]
  | null;

export const forms = pgTable(
  'forms',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    title: textTr('title').notNull(),
    description: text('description'),
    fields: jsonb('fields').$type<FormFieldData[]>().notNull().default([]),
    settings: jsonb('settings').$type<FormSettingsData>().notNull(),
    status: text('status', { enum: ['draft', 'open', 'closed'] })
      .notNull()
      .default('draft'),
    /** Public answer link token (not a secret beyond the link itself; regenerated on demand). */
    publicToken: text('public_token').notNull(),
    /** The CSV table in Drive (destinations.drive). */
    driveNodeId: uuid('drive_node_id').references((): AnyPgColumn => nodes.id, {
      onDelete: 'set null',
    }),
    /** Who owns the form: cards and the Drive table are written on their behalf. */
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    lastResponseAt: tz('last_response_at'),
    ...timestamps(),
  },
  (t) => [
    index('forms_space_idx').on(t.spaceId, t.updatedAt),
    uniqueIndex('forms_public_token_uq').on(t.publicToken),
  ],
);

export const formResponses = pgTable(
  'form_responses',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    formId: uuid('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    /** null when anonymous or answered through the public link. */
    respondentId: uuid('respondent_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * Keyed hash of who answered (person or browser token) for the one-answer limit; it does
     * not reveal the person of an anonymous answer.
     */
    respondentKey: text('respondent_key'),
    answers: jsonb('answers').$type<Record<string, FormAnswerData>>().notNull(),
    /** 'org' or 'public'. */
    channel: text('channel', { enum: ['org', 'public'] }).notNull(),
    /** forms.deliver claimed it (board card, owner notification): at most once. */
    deliveredAt: tz('delivered_at'),
    /** The board card opened for it (destinations.board). */
    cardId: uuid('card_id'),
    submittedAt: tz('submitted_at').notNull().defaultNow(),
  },
  (t) => [
    index('form_responses_form_idx').on(t.formId, t.submittedAt),
    uniqueIndex('form_responses_key_uq')
      .on(t.formId, t.respondentKey)
      .where(sql`${t.respondentKey} is not null`),
  ],
);

export const formFiles = pgTable(
  'form_files',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    formId: uuid('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    /** Set when the answer is sent; files never attached are removed by forms.sweep. */
    responseId: uuid('response_id').references(() => formResponses.id, { onDelete: 'cascade' }),
    fieldId: text('field_id').notNull(),
    /** Who may attach it: the uploader's user id or hashed browser token. */
    uploaderKey: text('uploader_key').notNull(),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    storageKey: text('storage_key').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('form_files_response_idx').on(t.responseId),
    index('form_files_orphan_idx')
      .on(t.createdAt)
      .where(sql`${t.responseId} is null`),
  ],
);
