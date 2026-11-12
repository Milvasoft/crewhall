import { z } from 'zod';
import { Id, Timestamp } from './common';
import { UserSummary } from './org';

/**
 * Automation rules (roadmap 17): no-code "when this happens, do that" per space. A rule has one
 * trigger, optional conditions on the event and one or more actions, run by the worker
 * (pg-boss `automation.run`). Trigger and action types come from a server registry so modules
 * (calendar, AI) add theirs without a contract change: the catalog endpoint describes each one
 * and its config fields, and configs are validated by the registry. Only the automations session
 * edits this file; see docs/contracts/moduller.md.
 */

export const AUTOMATION_LIMITS = {
  rulesPerSpace: 100,
  actionsPerRule: 10,
  conditionsPerRule: 10,
  nameChars: 120,
  /** A rule turns itself off after this many failed runs in a row (design 6.6). */
  failuresToDisable: 3,
  /** Runs of one rule per minute; more are skipped (loop and storm guard). */
  runsPerMinute: 30,
  /** Rules triggering rules: deeper chains are cut. */
  maxDepth: 3,
  /** Incoming webhook body. */
  hookBodyBytes: 32 * 1024,
  /** Incoming webhook requests per rule per minute. */
  hookPerMinute: 60,
  /** Outgoing webhook timeout. */
  webhookTimeoutMs: 10_000,
  /** Days run history is kept. */
  runRetentionDays: 30,
} as const;

/** `<module>.<event>` / `<module>.<verb>`: registry keys. */
export const AutomationKind = z
  .string()
  .regex(/^[a-z]+\.[a-z_]+$/)
  .max(64);

export const AutomationConfig = z.record(z.string().max(64), z.unknown());

export const AutomationTrigger = z.object({
  type: AutomationKind,
  config: AutomationConfig.default({}),
});
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;

export const ConditionOp = z.enum([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'gt',
  'lt',
  'exists',
  'not_exists',
]);
export type ConditionOp = z.infer<typeof ConditionOp>;

/**
 * A test on the event: `field` is a dotted path in the event data (`card.title`, `body.status`,
 * `values.<table field uuid>`).
 */
export const AutomationCondition = z.object({
  field: z
    .string()
    .regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/)
    .max(120),
  op: ConditionOp,
  value: z.string().max(500).nullable().default(null),
});
export type AutomationCondition = z.infer<typeof AutomationCondition>;

export const AutomationAction = z.object({
  /** Stable within the rule; later steps read `{{steps.<id>.<key>}}`. */
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  type: AutomationKind,
  config: AutomationConfig.default({}),
});
export type AutomationAction = z.infer<typeof AutomationAction>;

export const AutomationRunStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'skipped']);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatus>;

export const AutomationRule = z.object({
  id: Id,
  spaceId: Id,
  name: z.string(),
  enabled: z.boolean(),
  trigger: AutomationTrigger,
  conditions: z.array(AutomationCondition),
  actions: z.array(AutomationAction),
  /** Actions run on this person's behalf (the last one who saved the rule). */
  owner: UserSummary.nullable(),
  /** Incoming webhook trigger: POST here (the key is part of the URL). */
  hookUrl: z.url().nullable(),
  /** Outgoing webhooks are signed with this (X-Crewhall-Signature: sha256=<hmac>). */
  signingSecret: z.string().nullable(),
  /** Off after repeated failures; saving with enabled true clears it. */
  disabledReason: z.enum(['failures']).nullable(),
  failureStreak: z.number().int(),
  runCount: z.number().int(),
  lastRunAt: Timestamp.nullable(),
  lastStatus: AutomationRunStatus.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type AutomationRule = z.infer<typeof AutomationRule>;

export const CreateAutomationRule = z.object({
  name: z.string().trim().min(1).max(AUTOMATION_LIMITS.nameChars),
  enabled: z.boolean().default(true),
  trigger: AutomationTrigger,
  conditions: z.array(AutomationCondition).max(AUTOMATION_LIMITS.conditionsPerRule).default([]),
  actions: z.array(AutomationAction).min(1).max(AUTOMATION_LIMITS.actionsPerRule),
});
export type CreateAutomationRule = z.input<typeof CreateAutomationRule>;

export const UpdateAutomationRule = CreateAutomationRule.partial();
export type UpdateAutomationRule = z.input<typeof UpdateAutomationRule>;

export const AutomationStep = z.object({
  actionId: z.string(),
  type: z.string(),
  status: z.enum(['succeeded', 'failed', 'skipped']),
  /** Error code (an `errors.*` key when known) and the message at the time. */
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** Small facts for the history: card ref, message id, HTTP status… */
  output: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  ms: z.number().int(),
});
export type AutomationStep = z.infer<typeof AutomationStep>;

export const AutomationRun = z.object({
  id: Id,
  ruleId: Id,
  status: AutomationRunStatus,
  triggerType: z.string(),
  /** The event data the rule saw (trimmed). */
  event: z.record(z.string(), z.unknown()),
  steps: z.array(AutomationStep),
  /** Why the whole run failed or was skipped (owner gone, module off, rate limited…). */
  error: z.string().nullable(),
  /** Started by "Şimdi dene"; does not count toward the failure streak. */
  test: z.boolean(),
  depth: z.number().int(),
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type AutomationRun = z.infer<typeof AutomationRun>;

export const AutomationRunsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/**
 * How the editor renders a config field. Pickers: board, column (of `dependsOn` board),
 * conversation, users (space members), form, folder (space folders), table, table_field (of the
 * `dependsOn` table) and table_values (a `{{…}}` template per field of the `dependsOn` table).
 */
export const AutomationFieldKind = z.enum([
  'text',
  'template',
  'url',
  'number',
  'boolean',
  'select',
  'board',
  'column',
  'conversation',
  'users',
  'form',
  'folder',
  'table',
  'table_field',
  'table_values',
]);
export type AutomationFieldKind = z.infer<typeof AutomationFieldKind>;

export const AutomationField = z.object({
  key: z.string(),
  kind: AutomationFieldKind,
  required: z.boolean(),
  /** select: allowed values (labels: `web.automations.options.<value>`). */
  options: z.array(z.string()).default([]),
  /** column: the board field it belongs to. */
  dependsOn: z.string().nullable().default(null),
});
export type AutomationField = z.infer<typeof AutomationField>;

export const AutomationCatalogEntry = z.object({
  type: z.string(),
  /** The module it needs; null = core. */
  module: z.string().nullable(),
  available: z.boolean(),
  /** module_off: turned off in this org; module_missing: not installed yet (calendar). */
  unavailableReason: z.enum(['module_off', 'module_missing']).nullable(),
  fields: z.array(AutomationField),
  /** Triggers: event paths for conditions and `{{…}}` templates. */
  variables: z.array(z.string()),
});
export type AutomationCatalogEntry = z.infer<typeof AutomationCatalogEntry>;

export const AutomationCatalog = z.object({
  triggers: z.array(AutomationCatalogEntry),
  actions: z.array(AutomationCatalogEntry),
});
export type AutomationCatalog = z.infer<typeof AutomationCatalog>;

/** Non-JSON routes outside the endpoint table. */
export const AUTOMATION_RAW_PATHS = {
  /** POST JSON (≤ 32 KB): the incoming webhook trigger; `?key=` from hookUrl. */
  hook: '/api/automations/hooks/:ruleId',
} as const;

/* ---------------------------------- helpers ---------------------------------- */

/** Value at a dotted path of the event data. */
export function pathValue(data: unknown, path: string): unknown {
  let node: unknown = data;
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/**
 * Text of a value in a template or condition. An object may carry its own readable form in
 * `_text` (form answers render as "Soru: cevap" lines); other objects become JSON.
 */
const asText = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'object') return String(v);
  const own = (v as { _text?: unknown })._text;
  return typeof own === 'string' ? own : JSON.stringify(v);
};

/** Does one condition hold for the event? Text compares case-insensitively (Turkish rules). */
export function conditionHolds(c: AutomationCondition, data: unknown): boolean {
  const v = pathValue(data, c.field);
  const text = asText(v).toLocaleLowerCase('tr');
  const want = (c.value ?? '').toLocaleLowerCase('tr');
  switch (c.op) {
    case 'exists':
      return text !== '';
    case 'not_exists':
      return text === '';
    case 'equals':
      return text === want;
    case 'not_equals':
      return text !== want;
    case 'contains':
      return Array.isArray(v)
        ? v.some((x) => asText(x).toLocaleLowerCase('tr') === want)
        : text.includes(want);
    case 'not_contains':
      return Array.isArray(v)
        ? !v.some((x) => asText(x).toLocaleLowerCase('tr') === want)
        : !text.includes(want);
    case 'gt':
    case 'lt': {
      const a = Number(v);
      const b = Number(c.value);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return c.op === 'gt' ? a > b : a < b;
    }
  }
}

/** Replaces `{{path}}` with values from the scope (event data and `steps`). */
export function renderTemplate(text: string, scope: unknown): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g, (_, path: string) =>
    asText(pathValue(scope, path)),
  );
}
