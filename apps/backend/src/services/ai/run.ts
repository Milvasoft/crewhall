import { and, eq, inArray, isNull } from 'drizzle-orm';
import { aiRuns, newId, readStates, users, type DbOrTx } from '@crewhall/db';
import { resolveLocale } from '@crewhall/i18n';
import {
  AI_LIMITS,
  type Actor,
  type AiAction,
  type AiRunRequest,
  type AiRunResult,
  type AiStatus,
  type Locale,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { OrgRow, RequestInfo } from '../../http/types';
import { historyFrom, requireMember } from '../chat/access';
import { listMessages } from '../chat/messages';
import { mentionedIds, plainText } from '../chat/text';
import { loadNode } from '../drive/access';
import { isModuleEnabled } from '../identity/modules';
import { aiAudit } from './audit';
import { editorPrompt, unreadPrompt, type ChatLine, type Prompt } from './prompts';
import { modelClient, ProviderError, type ModelConfig } from './providers';
import { isConfigured, loadSettings, modelConfigOf, type SettingsRow } from './settings';
import { exhausted, quotaOf } from './usage';

/**
 * Running one action: checks (switch, configuration, quota, what the caller may see), the prompt,
 * the model call, and the record (ai_runs row + audit with `via: { kind: 'ai' }`).
 *
 * Privacy (yol haritası #5): editor text must name its source — a node the caller can view
 * (`loadNode` → `can(…, 'space.view', …)`) or their own draft; chat summaries are built here
 * from the messages the caller can see. Vault items are end-to-end encrypted and never reach
 * the server in plain text, so they cannot reach a model either.
 */

export interface AiCaller {
  org: OrgRow;
  actor: Actor;
  userId: string;
  userName: string;
}

interface Target {
  type: 'node' | 'conversation' | 'draft' | 'question' | 'recording' | 'automation';
  id: string | null;
}

export type Prepared =
  | {
      kind: 'model';
      action: AiAction;
      config: ModelConfig;
      prompt: Prompt;
      target: Target;
      messages?: number;
      /** Tokens already spent for this run before the answer (the Ask tool choice). */
      extraUsage?: { inputTokens: number; cachedInputTokens?: number; outputTokens: number };
    }
  | { kind: 'empty'; messages: number };

/** Upper bound of the chat transcript sent for one summary. */
const TRANSCRIPT_CHARS = 60_000;

export async function aiStatus(db: DbOrTx, caller: AiCaller): Promise<AiStatus> {
  const settings = await loadSettings(db, caller.org.id);
  const quota = await quotaOf(db, settings, caller.org.id, caller.userId);
  const reason = !settings?.enabled
    ? 'disabled'
    : !isConfigured(settings)
      ? 'not_configured'
      : exhausted(quota)
        ? 'quota'
        : null;
  return {
    available: reason === null,
    reason,
    provider: settings?.enabled ? settings.provider : null,
    model: settings?.enabled ? settings.model : null,
    dictation: !!settings?.enabled && !!settings.transcriptionUrl && !!settings.transcriptionModel,
    quota,
  };
}

export async function usableSettings(
  deps: Pick<Deps, 'db'>,
  caller: AiCaller,
): Promise<SettingsRow> {
  const settings = await loadSettings(deps.db, caller.org.id);
  if (!settings?.enabled) throw new AppError('ai_disabled');
  if (!isConfigured(settings)) throw new AppError('ai_not_configured');
  const quota = await quotaOf(deps.db, settings, caller.org.id, caller.userId);
  const scope = exhausted(quota);
  if (scope) throw new AppError('ai_quota_exceeded', { scope, resetsAt: quota.resetsAt });
  return settings;
}

export async function prepareRun(
  deps: Deps,
  caller: AiCaller,
  req: AiRunRequest,
  acceptLanguage: string | null,
): Promise<Prepared> {
  const settings = await usableSettings(deps, caller);
  const config = modelConfigOf(deps, settings);
  const a = { org: caller.org, actor: caller.actor, userId: caller.userId };

  if (req.action === 'summarize_unread') {
    if (!(await isModuleEnabled(deps.db, caller.org.id, 'chat'))) {
      throw new AppError('module_disabled', { module: 'chat' });
    }
    const transcript = await unreadTranscript(deps.db, a, req.conversationId, req.afterSeq);
    if (transcript.lines.length === 0) return { kind: 'empty', messages: 0 };
    const locale: Locale = req.locale ?? resolveLocale(acceptLanguage);
    return {
      kind: 'model',
      action: req.action,
      config,
      prompt: unreadPrompt(transcript.lines, {
        locale,
        conversation: transcript.title,
        reader: caller.userName,
      }),
      target: { type: 'conversation', id: req.conversationId },
      messages: transcript.lines.length,
    };
  }

  let target: Target = { type: 'draft', id: null };
  if (req.source.kind === 'node') {
    // 404 when the caller cannot view the node (can() 'space.view'), like every Drive read.
    const access = await loadNode(deps.db, a, req.source.nodeId);
    target = { type: 'node', id: access.node.id };
  }
  return { kind: 'model', action: req.action, config, prompt: editorPrompt(req), target };
}

/**
 * The caller's unread messages: after their read position and within the history they may see
 * (`listMessages` applies membership and "Benim için sil"); deleted and system lines are left out.
 */
async function unreadTranscript(
  db: DbOrTx,
  a: { org: OrgRow; actor: Actor; userId: string },
  conversationId: string,
  afterSeq: number | undefined,
): Promise<{ title: string; lines: ChatLine[] }> {
  const m = await requireMember(db, a, conversationId);
  const [state] = await db
    .select({ seq: readStates.lastReadSeq })
    .from(readStates)
    .where(and(eq(readStates.conversationId, conversationId), eq(readStates.userId, a.userId)));
  // History before the caller's first visible seq stays out whatever the client sends.
  const lastRead = Math.max(afterSeq ?? state?.seq ?? 0, historyFrom(m) - 1);
  const unread = m.conv.lastSeq - lastRead;
  if (unread <= 0) return { title: m.conv.name ?? '', lines: [] };

  // The newest messages when there are more than the limit.
  const from = Math.max(lastRead, m.conv.lastSeq - AI_LIMITS.unreadMessages);
  const page = await listMessages(db, a, conversationId, {
    afterSeq: from,
    limit: AI_LIMITS.unreadMessages,
  });
  const visible = page.items.filter(
    (msg) => msg.kind !== 'system' && !msg.deletedAt && msg.author?.id !== a.userId,
  );

  const names = new Map<string, string>();
  for (const msg of visible) if (msg.author) names.set(msg.author.id, msg.author.name);
  const unknown = mentionedIds(visible.map((x) => x.text)).filter((id) => !names.has(id));
  if (unknown.length) {
    const rows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, unknown));
    for (const r of rows) names.set(r.id, r.name);
  }

  const lines: ChatLine[] = [];
  let size = 0;
  for (const msg of [...visible].reverse()) {
    const files = msg.attachments.map((f) => `[${f.name}]`).join(' ');
    const text = [plainText(msg.text, names), files].filter(Boolean).join(' ').trim();
    if (!text) continue;
    const line: ChatLine = {
      at: new Date(msg.createdAt),
      author: msg.author?.name ?? msg.webhook?.name ?? '?',
      text,
    };
    size += text.length + line.author.length + 20;
    if (size > TRANSCRIPT_CHARS) break;
    lines.push(line);
  }
  return { title: m.conv.name ?? '', lines: lines.reverse() };
}

export interface RunOutcome {
  runId: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  truncated: boolean;
}

/**
 * Calls the model, passing each text piece to `onText`, then records the run. Provider failures
 * become `ai_provider_error`, a declined request `ai_refused`; both are recorded too. A run cut
 * short by the client (abort) is recorded with estimated counts so it still counts to the quota.
 */
export async function executeRun(
  deps: Pick<Deps, 'db' | 'logger'>,
  caller: AiCaller,
  prepared: Extract<Prepared, { kind: 'model' }>,
  req: RequestInfo,
  opts: { runId?: string; onText?: (text: string) => void | Promise<void>; signal?: AbortSignal },
): Promise<RunOutcome> {
  const runId = opts.runId ?? newId();
  const started = performance.now();
  let text = '';
  let end: {
    inputTokens: number;
    cachedInputTokens?: number;
    outputTokens: number;
    truncated: boolean;
    refused: boolean;
  } = {
    inputTokens: Math.ceil((prepared.prompt.system.length + prepared.prompt.prompt.length) / 4),
    outputTokens: 0,
    truncated: false,
    refused: false,
  };
  let failure: { status: 'error' | 'refused'; error: string } | null = null;
  let thrown: unknown = null;

  try {
    const client = modelClient(prepared.config);
    for await (const chunk of client.stream({
      ...prepared.prompt,
      maxTokens: AI_LIMITS.maxOutputTokens,
      signal: opts.signal,
    })) {
      if (chunk.type === 'text') {
        text += chunk.text;
        await opts.onText?.(chunk.text);
      } else {
        end = chunk;
      }
    }
    if (end.refused) failure = { status: 'refused', error: 'refused' };
  } catch (err) {
    thrown = err;
    end = { ...end, outputTokens: Math.ceil(text.length / 4) };
    failure = {
      status: 'error',
      error: opts.signal?.aborted
        ? 'aborted'
        : err instanceof ProviderError
          ? err.message
          : 'unknown error',
    };
    if (!(err instanceof ProviderError) && !opts.signal?.aborted) {
      deps.logger.error({ err }, 'ai run failed');
    }
  }

  if (prepared.extraUsage) {
    end = {
      ...end,
      inputTokens: end.inputTokens + prepared.extraUsage.inputTokens,
      cachedInputTokens:
        (end.cachedInputTokens ?? 0) + (prepared.extraUsage.cachedInputTokens ?? 0),
      outputTokens: end.outputTokens + prepared.extraUsage.outputTokens,
    };
  }
  const latencyMs = Math.round(performance.now() - started);
  await deps.db.insert(aiRuns).values({
    id: runId,
    orgId: caller.org.id,
    userId: caller.userId,
    action: prepared.action,
    provider: prepared.config.provider,
    model: prepared.config.model,
    targetType: prepared.target.type,
    targetId: prepared.target.id,
    status: failure?.status ?? 'ok',
    error: failure?.error ?? null,
    inputTokens: end.inputTokens,
    cachedInputTokens: end.cachedInputTokens ?? 0,
    outputTokens: end.outputTokens,
    latencyMs,
  });
  await aiAudit(
    deps.db,
    {
      orgId: caller.org.id,
      actorId: caller.userId,
      action: 'ai.run',
      targetType: prepared.target.type,
      targetId: prepared.target.id,
      meta: {
        action: prepared.action,
        status: failure?.status ?? 'ok',
        inputTokens: end.inputTokens,
        cachedInputTokens: end.cachedInputTokens ?? 0,
        outputTokens: end.outputTokens,
        ...(prepared.messages !== undefined ? { messages: prepared.messages } : {}),
      },
      via: viaOf(prepared.config, runId),
    },
    req,
  );

  if (thrown) {
    if (opts.signal?.aborted) throw thrown;
    throw providerAppError(thrown);
  }
  if (failure?.status === 'refused') throw new AppError('ai_refused');
  return {
    runId,
    text,
    inputTokens: end.inputTokens,
    outputTokens: end.outputTokens,
    truncated: end.truncated,
  };
}

/**
 * A provider failure as one of the module's error codes: a wrong key means the settings are not
 * usable (`ai_not_configured`), the provider's rate limit is `rate_limited`, an account out of
 * credit is `ai_quota_exceeded` (scope `provider`, unlike the org's own monthly quota), anything
 * else `ai_provider_error`. The provider's message goes along for admins.
 */
export function providerAppError(err: unknown): AppError {
  if (!(err instanceof ProviderError)) {
    return new AppError('ai_provider_error', { message: 'unknown error' });
  }
  const details = { message: err.message, status: err.status, kind: err.kind };
  switch (err.kind) {
    case 'auth':
      return new AppError('ai_not_configured', { reason: 'provider_auth', ...details });
    case 'rate_limit':
      return new AppError('rate_limited', { reason: 'provider', ...details });
    case 'quota':
      return new AppError('ai_quota_exceeded', { scope: 'provider', ...details });
    default:
      return new AppError('ai_provider_error', details);
  }
}

const viaOf = (config: ModelConfig, runId: string) => ({
  kind: 'ai',
  provider: config.provider,
  model: config.model,
  runId,
});

export async function runOnce(
  deps: Deps,
  caller: AiCaller,
  body: AiRunRequest,
  req: RequestInfo,
): Promise<AiRunResult> {
  const prepared = await prepareRun(deps, caller, body, req.locale);
  if (prepared.kind === 'empty') {
    return {
      runId: null,
      text: '',
      usage: { inputTokens: 0, outputTokens: 0 },
      truncated: false,
      messages: 0,
    };
  }
  const out = await executeRun(deps, caller, prepared, req, {});
  return {
    runId: out.runId,
    text: out.text,
    usage: { inputTokens: out.inputTokens, outputTokens: out.outputTokens },
    truncated: out.truncated,
    ...(prepared.messages !== undefined ? { messages: prepared.messages } : {}),
  };
}

/**
 * "AI ile": the person kept a result. One audit row on the run's target with the AI `via`;
 * a second call (or someone else's run, or a failed run) is 404 ai_run_not_found.
 */
export async function acceptRun(
  deps: Deps,
  caller: Pick<AiCaller, 'org' | 'userId'>,
  runId: string,
  req: RequestInfo,
) {
  const [run] = await deps.db
    .update(aiRuns)
    .set({ acceptedAt: new Date() })
    .where(
      and(
        eq(aiRuns.id, runId),
        eq(aiRuns.orgId, caller.org.id),
        eq(aiRuns.userId, caller.userId),
        eq(aiRuns.status, 'ok'),
        isNull(aiRuns.acceptedAt),
      ),
    )
    .returning();
  if (!run) throw new AppError('ai_run_not_found');
  await aiAudit(
    deps.db,
    {
      orgId: caller.org.id,
      actorId: caller.userId,
      action: 'ai.suggestion.accept',
      targetType: run.targetType,
      targetId: run.targetId,
      meta: { action: run.action },
      via: { kind: 'ai', provider: run.provider, model: run.model, runId: run.id },
    },
    req,
  );
}
