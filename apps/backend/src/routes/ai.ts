import { newId } from '@crewhall/db';
import {
  AI_LIMITS,
  AI_PROVIDER_INFO,
  AI_RAW_PATHS,
  AiAskRequest,
  AiRunRequest,
  can,
  type AiCitation,
  type AiStreamEvent,
} from '@crewhall/shared';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { z } from 'zod';
import type { Deps } from '../deps';
import { AppError, errorBody, validationError } from '../http/errors';
import { requestInfo, type Router } from '../http/route';
import type { AppEnv, OrgCtx, RequestInfo } from '../http/types';
import { planActions } from '../services/ai/actions';
import { dictate } from '../services/ai/dictation';
import { askOnce, prepareAsk, search } from '../services/ai/ask';
import {
  createActionCard,
  createNotesPage,
  startTranscript,
  transcriptState,
} from '../services/ai/meeting';
import {
  acceptRun,
  aiStatus,
  executeRun,
  prepareRun,
  runOnce,
  type AiCaller,
  type Prepared,
} from '../services/ai/run';
import { indexCounts } from '../services/ai/search/indexer';
import { vectorModeOf } from '../services/ai/search/embed';
import {
  loadSettings,
  testSettings,
  toSettingsView,
  updateSettings,
} from '../services/ai/settings';
import { usageReport } from '../services/ai/usage';
import { requireModule } from '../services/identity/modules';
import { orgContext } from '../services/membership';

const caller = (ctx: Pick<OrgCtx<never>, 'org' | 'actor' | 'user'>): AiCaller => ({
  org: ctx.org,
  actor: ctx.actor,
  userId: ctx.user.id,
  userName: ctx.user.name,
});

function requireAdmin(ctx: Pick<OrgCtx<never>, 'actor' | 'org'>) {
  if (!can(ctx.actor, 'org.update_settings', { type: 'org', org: orgContext(ctx.org) })) {
    throw new AppError('forbidden');
  }
}

async function indexStatus(deps: Pick<Deps, 'db'>, orgId: string) {
  const settings = await loadSettings(deps.db, orgId);
  const embeddings = !!settings?.embeddingModel && AI_PROVIDER_INFO[settings.provider].embeddings;
  return {
    ...(await indexCounts(deps.db, orgId)),
    embeddings,
    vector: embeddings ? await vectorModeOf(deps.db) : ('off' as const),
  };
}

async function jsonBody<S extends z.ZodType>(c: Context<AppEnv>, schema: S): Promise<z.output<S>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new AppError('bad_request', { reason: 'invalid_json' });
  }
  const body = schema.safeParse(json);
  if (!body.success) throw validationError(body.error, 'body');
  return body.data;
}

/**
 * Streams one prepared model call as server-sent events (AI_RAW_PATHS): `citations` (ask only),
 * `start`, `delta`…, then `done` or `error`. Closing the connection stops the model.
 */
function streamRun(
  c: Context<AppEnv>,
  deps: Deps,
  who: AiCaller,
  req: RequestInfo,
  prepared: Prepared,
  citations: AiCitation[] | null,
) {
  return streamSSE(c, async (stream) => {
    const send = (event: AiStreamEvent) => stream.writeSSE({ data: JSON.stringify(event) });
    if (citations) await send({ type: 'citations', citations });
    if (prepared.kind === 'empty') {
      await send({ type: 'start', runId: null, messages: 0 });
      await send({
        type: 'done',
        runId: null,
        usage: { inputTokens: 0, outputTokens: 0 },
        truncated: false,
      });
      return;
    }
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());
    const runId = newId();
    await send({
      type: 'start',
      runId,
      ...(prepared.messages !== undefined ? { messages: prepared.messages } : {}),
    });
    try {
      const out = await executeRun(deps, who, prepared, req, {
        runId,
        signal: abort.signal,
        onText: (text) => send({ type: 'delta', text }),
      });
      await send({
        type: 'done',
        runId: out.runId,
        usage: { inputTokens: out.inputTokens, outputTokens: out.outputTokens },
        truncated: out.truncated,
      });
    } catch (err) {
      if (abort.signal.aborted) return;
      const appErr = err instanceof AppError ? err : new AppError('internal');
      if (!(err instanceof AppError)) deps.logger.error({ err }, 'ai stream failed');
      const bodyOut = errorBody(appErr, req.locale);
      await send({ type: 'error', code: bodyOut.code, message: bodyOut.message });
    }
  });
}

/** AI module (yol haritası #5, #11): writing help, search, "Crewhall'a sor", Yönetim › Yapay zekâ. */
export function registerAi(r: Router): void {
  r.org('getAiStatus', (ctx) => aiStatus(ctx.deps.db, caller(ctx)));
  r.org('runAi', (ctx) => runOnce(ctx.deps, caller(ctx), ctx.body, ctx.req));
  r.org('acceptAiRun', async (ctx) => {
    await acceptRun(ctx.deps, caller(ctx), ctx.params.runId, ctx.req);
    return {};
  });

  r.org('searchAi', async (ctx) => ({
    items: await search(ctx.deps, caller(ctx), ctx.query),
  }));
  r.org('askAi', (ctx) => askOnce(ctx.deps, caller(ctx), ctx.body, ctx.req));

  r.org('planAiActions', (ctx) => planActions(ctx.deps, caller(ctx), ctx.body, ctx.req));
  r.org('getMeetingTranscript', (ctx) =>
    transcriptState(ctx.deps, caller(ctx), ctx.params.recordingId),
  );
  r.org('startMeetingTranscript', (ctx) =>
    startTranscript(ctx.deps, caller(ctx), ctx.params.recordingId),
  );
  r.org('createMeetingActionCard', (ctx) => {
    const index = Number(ctx.params.index);
    if (!Number.isInteger(index) || index < 0 || index > 200) throw new AppError('not_found');
    return createActionCard(
      ctx.deps,
      caller(ctx),
      ctx.params.transcriptId,
      index,
      ctx.body,
      ctx.req,
    );
  });
  r.org('createMeetingNotesPage', (ctx) =>
    createNotesPage(ctx.deps, caller(ctx), ctx.params.transcriptId),
  );

  r.org('getAiSettings', async (ctx) => {
    requireAdmin(ctx);
    return toSettingsView(await loadSettings(ctx.deps.db, ctx.org.id));
  });
  r.org('updateAiSettings', (ctx) => {
    requireAdmin(ctx);
    return updateSettings(ctx.deps, { orgId: ctx.org.id, userId: ctx.user.id }, ctx.body, ctx.req);
  });
  r.org('testAiSettings', (ctx) => {
    requireAdmin(ctx);
    return testSettings(ctx.deps, ctx.org.id, ctx.body);
  });
  r.org('getAiUsage', (ctx) => {
    requireAdmin(ctx);
    return usageReport(ctx.deps.db, ctx.org.id, ctx.query.month);
  });
  r.org('getAiIndexStatus', (ctx) => {
    requireAdmin(ctx);
    return indexStatus(ctx.deps, ctx.org.id);
  });
  r.org('rebuildAiIndex', async (ctx) => {
    requireAdmin(ctx);
    await ctx.deps.jobs.send('search.sweep', { orgId: ctx.org.id });
    return indexStatus(ctx.deps, ctx.org.id);
  });

  // Streamed runAi / askAi. Checks run before the stream opens so failures keep the usual
  // JSON error body; afterwards they arrive as an `error` event.
  r.rawOrg('POST', AI_RAW_PATHS.stream, async ({ c, deps, org, actor, user }) => {
    await requireModule(deps.db, org.id, 'ai');
    const body = await jsonBody(c, AiRunRequest);
    const req = requestInfo(c);
    const who = caller({ org, actor, user });
    const prepared = await prepareRun(deps, who, body, req.locale);
    return streamRun(c, deps, who, req, prepared, null);
  });
  r.rawOrg('POST', AI_RAW_PATHS.ask, async ({ c, deps, org, actor, user }) => {
    await requireModule(deps.db, org.id, 'ai');
    const body = await jsonBody(c, AiAskRequest);
    const req = requestInfo(c);
    const who = caller({ org, actor, user });
    const { prepared, citations } = await prepareAsk(deps, who, body, req.locale);
    return streamRun(c, deps, who, req, prepared, citations);
  });
  r.rawOrg('POST', AI_RAW_PATHS.transcribe, async ({ c, deps, org, actor, user }) => {
    await requireModule(deps.db, org.id, 'ai');
    const declared = Number(c.req.header('content-length') ?? '0');
    if (declared > AI_LIMITS.dictationBytes) throw new AppError('file_too_large');
    const audio = Buffer.from(await c.req.arrayBuffer());
    const who = caller({ org, actor, user });
    const out = await dictate(
      deps,
      who,
      audio,
      c.req.header('content-type') ?? null,
      requestInfo(c),
    );
    return c.json(out);
  });
}
