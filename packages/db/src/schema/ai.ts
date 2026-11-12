import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { recordings, meetings } from './meet';
import { nodes } from './space';
import { organizations } from './org';
import { id, timestamps, tz } from './types';

/**
 * AI module A1 (yol haritası #5): the org's model settings and one row per model call. The API
 * key is stored only encrypted (AES-256-GCM, key derived from AUTH_SECRET, bound to the org).
 * Run rows hold counts and the target, never the text sent or received.
 */

export const aiProvider = pgEnum('ai_provider', [
  'anthropic',
  'openai',
  'gemini',
  'mistral',
  'azure_openai',
  'openrouter',
  'openai_compatible',
]);
export const aiRunStatus = pgEnum('ai_run_status', ['ok', 'error', 'refused']);

/** Per-org settings; a missing row means "off, not configured". */
export const aiSettings = pgTable('ai_settings', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  provider: aiProvider('provider').notNull().default('anthropic'),
  model: text('model').notNull(),
  /** OpenAI-compatible servers only. */
  baseUrl: text('base_url'),
  /** Azure OpenAI api-version. */
  apiVersion: text('api_version'),
  apiKeyEnc: text('api_key_enc'),
  /** Last four characters, for "••••abcd" on the settings screen. */
  apiKeyHint: text('api_key_hint'),
  apiKeyUpdatedAt: tz('api_key_updated_at'),
  /** Null = unlimited. */
  orgMonthlyTokens: integer('org_monthly_tokens'),
  userMonthlyTokens: integer('user_monthly_tokens'),
  /** OpenAI-compatible embedding model for semantic search; null = full-text search only. */
  embeddingModel: text('embedding_model'),
  /** Cheaper model for short structured steps (tool choice, "Yap" plans); null = the main one. */
  fastModel: text('fast_model'),
  /** Meeting notes (yol haritası #12): OpenAI-compatible speech server and model. */
  transcriptionUrl: text('transcription_url'),
  transcriptionModel: text('transcription_model'),
  /** Transcribe and summarize every recording automatically. */
  meetingNotes: boolean('meeting_notes').notNull().default(false),
  /** AiTestResult of the last "Test et". */
  lastTest: jsonb('last_test').$type<Record<string, unknown>>(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps(),
});

export const aiRuns = pgTable(
  'ai_runs',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    provider: aiProvider('provider').notNull(),
    model: text('model').notNull(),
    /** node (page …), conversation or draft. */
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id'),
    status: aiRunStatus('status').notNull().default('ok'),
    error: text('error'),
    inputTokens: integer('input_tokens').notNull().default(0),
    /** Part of input_tokens served from the provider's prompt cache ("önbellekten"). */
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    latencyMs: integer('latency_ms'),
    acceptedAt: tz('accepted_at'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('ai_runs_org_at_idx').on(t.orgId, t.createdAt),
    index('ai_runs_user_at_idx').on(t.orgId, t.userId, t.createdAt),
  ],
);

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/**
 * "Crewhall'a sor" (yol haritası #11): one row per chunk of searchable content — page bodies,
 * Drive item names and paths (file contents once extracted), board cards and chat messages.
 * Vault content is never indexed. Rows carry what the permission check needs (node, space,
 * conversation and seq); every query checks the caller with the same rules as the module itself.
 */
export const searchChunks = pgTable(
  'search_chunks',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** page, file, folder, board, drawing, card, message */
    kind: text('kind').notNull(),
    /** The source row: node id, card id or message id. */
    refId: uuid('ref_id').notNull(),
    chunk: integer('chunk').notNull().default(0),
    /** Node the permission check runs on (the board for a card); null for messages. */
    nodeId: uuid('node_id'),
    spaceId: uuid('space_id'),
    conversationId: uuid('conversation_id'),
    seq: bigint('seq', { mode: 'number' }),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** Revision of the source when indexed; a different one means re-index. */
    sourceRev: text('source_rev').notNull(),
    /** 'simple' config with prefix queries: one column for Turkish and English. */
    search: tsvector('search').generatedAlwaysAs(
      sql.raw(
        "setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(body, '')), 'B')",
      ),
    ),
    embedding: real('embedding').array(),
    embeddingModel: text('embedding_model'),
    sourceAt: tz('source_at').notNull(),
    indexedAt: tz('indexed_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('search_chunks_ref_uq').on(t.kind, t.refId, t.chunk),
    index('search_chunks_org_idx').on(t.orgId, t.kind),
    index('search_chunks_search_gin').using('gin', t.search),
    index('search_chunks_conversation_idx').on(t.conversationId),
  ],
);

export const meetingTranscriptStatus = pgEnum('meeting_transcript_status', [
  'queued',
  'transcribing',
  'summarizing',
  'ready',
  'failed',
]);

/**
 * Toplantı asistanı (yol haritası #12): one row per recording — the transcript from the org's
 * speech server, the model's summary, decisions and action items, and the notes page.
 */
export const meetingTranscripts = pgTable(
  'meeting_transcripts',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recordings.id, { onDelete: 'cascade' }),
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    status: meetingTranscriptStatus('status').notNull().default('queued'),
    error: text('error'),
    language: text('language'),
    text: text('text'),
    /** [{ start, end, text }] in seconds. */
    segments: jsonb('segments').$type<{ start: number; end: number; text: string }[]>(),
    summary: text('summary'),
    decisions: jsonb('decisions').$type<string[]>().notNull().default([]),
    /** MeetingAction[] */
    actions: jsonb('actions').$type<Record<string, unknown>[]>().notNull().default([]),
    pageNodeId: uuid('page_node_id').references(() => nodes.id, { onDelete: 'set null' }),
    runId: uuid('run_id'),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('meeting_transcripts_recording_uq').on(t.recordingId),
    index('meeting_transcripts_meeting_idx').on(t.meetingId),
  ],
);
