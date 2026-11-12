import { boolean, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { organizations } from './org';
import { spaces } from './space';
import { id, timestamps, tz } from './types';

/**
 * Automation rules and their run history (roadmap 17). Owned by the automations session.
 * Trigger, conditions and actions are JSON validated by the server's registry; `trigger_type`
 * is a column so an event finds its rules with one indexed query.
 */

export interface AutomationTriggerData {
  type: string;
  config: Record<string, unknown>;
}
export interface AutomationConditionData {
  field: string;
  op: 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'gt' | 'lt' | 'exists' | 'not_exists';
  value: string | null;
}
export interface AutomationActionData {
  id: string;
  type: string;
  config: Record<string, unknown>;
}
export interface AutomationStepData {
  actionId: string;
  type: string;
  status: 'succeeded' | 'failed' | 'skipped';
  error: { code: string; message: string } | null;
  output: Record<string, string | number | boolean | null>;
  ms: number;
}

export const automationRules = pgTable(
  'automation_rules',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    triggerType: text('trigger_type').notNull(),
    trigger: jsonb('trigger').$type<AutomationTriggerData>().notNull(),
    conditions: jsonb('conditions').$type<AutomationConditionData[]>().notNull().default([]),
    actions: jsonb('actions').$type<AutomationActionData[]>().notNull().default([]),
    /** Actions run as this person (the last one who saved the rule). */
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    /** Incoming webhook key: sha256 for lookup, encrypted so the URL can be shown again. */
    hookKeyHash: text('hook_key_hash'),
    hookKeyEnc: text('hook_key_enc'),
    /** Outgoing webhook signing secret, encrypted with the server key. */
    signingSecretEnc: text('signing_secret_enc').notNull(),
    failureStreak: integer('failure_streak').notNull().default(0),
    disabledReason: text('disabled_reason', { enum: ['failures'] }),
    runCount: integer('run_count').notNull().default(0),
    lastRunAt: tz('last_run_at'),
    lastStatus: text('last_status', {
      enum: ['queued', 'running', 'succeeded', 'failed', 'skipped'],
    }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    index('automation_rules_match_idx').on(t.orgId, t.spaceId, t.triggerType),
    index('automation_rules_space_idx').on(t.spaceId, t.createdAt),
  ],
);

export const automationRuns = pgTable(
  'automation_runs',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => automationRules.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed', 'skipped'] })
      .notNull()
      .default('queued'),
    triggerType: text('trigger_type').notNull(),
    event: jsonb('event').$type<Record<string, unknown>>().notNull(),
    steps: jsonb('steps').$type<AutomationStepData[]>().notNull().default([]),
    error: text('error'),
    /** Rules whose actions led here (loop guard) and how deep the chain is. */
    chain: jsonb('chain').$type<string[]>().notNull().default([]),
    depth: integer('depth').notNull().default(0),
    test: boolean('test').notNull().default(false),
    startedAt: tz('started_at'),
    finishedAt: tz('finished_at'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('automation_runs_rule_idx').on(t.ruleId, t.createdAt),
    index('automation_runs_created_idx').on(t.createdAt),
  ],
);
