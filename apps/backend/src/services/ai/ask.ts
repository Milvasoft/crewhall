import { resolveLocale } from '@crewhall/i18n';
import {
  AiAskRequest,
  type AiAskResult,
  type AiCitation,
  type AiSearchHit,
  type AiSearchKind,
  type Locale,
} from '@crewhall/shared';
import type { z } from 'zod';
import type { Deps } from '../../deps';
import type { RequestInfo } from '../../http/types';
import { nowIn, validZone } from './actions';
import { availableTools, isAskTool, runTools, toolsForIntent } from './ask-tools';
import { askPrompt, askToolsPrompt } from './prompts';
import {
  modelClient,
  ProviderError,
  type ModelClient,
  type ModelTool,
  type ToolPick,
} from './providers';
import { executeRun, providerAppError, usableSettings, type AiCaller, type Prepared } from './run';
import { embedConfigOf, type EmbedConfig } from './search/embed';
import { searchChunksFor } from './search/query';
import { loadSettings, modelConfigOf } from './settings';

type AskInput = z.output<typeof AiAskRequest>;

/**
 * "Crewhall'a sor" (yol haritası #11). The question is searched as the asker (the same
 * permission checks as each module; vault never indexed), the best chunks become numbered
 * sources, and the model answers from them only, citing [n]. The answer streams like the
 * editor actions and is recorded as an `ask` run.
 */

/** The embedding config of the org, when semantic search is set up. */
async function embedCfgOf(
  deps: Pick<Deps, 'db' | 'env'>,
  orgId: string,
): Promise<EmbedConfig | null> {
  const settings = await loadSettings(deps.db, orgId);
  if (!settings?.embeddingModel) return null;
  try {
    return embedConfigOf(modelConfigOf(deps, settings), settings.embeddingModel);
  } catch {
    return null;
  }
}

export async function search(
  deps: Pick<Deps, 'db' | 'env' | 'logger'>,
  caller: AiCaller,
  q: { q: string; kinds: AiSearchKind[]; limit: number },
): Promise<AiSearchHit[]> {
  const found = await searchChunksFor(deps, caller, {
    ...q,
    embedCfg: await embedCfgOf(deps, caller.org.id),
  });
  return found.map((f) => f.hit);
}

export interface PreparedAsk {
  prepared: Extract<Prepared, { kind: 'model' }>;
  citations: AiCitation[];
}

/**
 * Which tools the model wants (function calling), or, for a model without it or when the choice
 * fails, the ones the question's words plainly ask for. A wrong key, the rate limit or the
 * account's quota stop the question, like a failing answer would.
 */
async function chooseTools(
  client: ModelClient,
  body: AskInput,
  tools: ModelTool[],
  now: string,
): Promise<ToolPick & { via: 'model' | 'intent' | 'none' }> {
  const none = { calls: [], inputTokens: 0, outputTokens: 0 };
  if (!tools.length) return { ...none, via: 'none' };
  const intent = () => ({
    ...none,
    calls: toolsForIntent(body.question, tools),
    via: 'intent' as const,
  });
  if (!client.pickTools) return intent();
  const prompt = askToolsPrompt(body.question, now);
  try {
    const out = await client.pickTools({
      ...prompt,
      history: recentHistory(body.history).flatMap((h) => [
        { role: 'user' as const, text: h.question },
        { role: 'assistant' as const, text: h.answer },
      ]),
      tools,
      maxTokens: TOOL_CHOICE_TOKENS,
    });
    return { ...out, calls: out.calls.filter((c) => isAskTool(c.name)).slice(0, 4), via: 'model' };
  } catch (err) {
    // A wrong key, the rate limit or the account's quota would stop the answer too; anything
    // else (no function calling, an odd reply) only costs the precise choice.
    if (
      err instanceof ProviderError &&
      (err.kind === 'auth' || err.kind === 'rate_limit' || err.kind === 'quota')
    ) {
      throw providerAppError(err);
    }
    if (!(err instanceof ProviderError)) throw err;
    return intent();
  }
}

/** Room for the tool choice: a few calls with short arguments. */
const TOOL_CHOICE_TOKENS = 1_024;

/**
 * Context diet: search sources (6, or 4 next to live data), each about 400 tokens at most, and
 * the last two turns of the conversation with their answers shortened.
 */
const SEARCH_SOURCES = 6;
const SEARCH_SOURCES_WITH_LIVE = 4;
const SOURCE_CHARS = 1_600;
const HISTORY_TURNS = 2;
const HISTORY_ANSWER_CHARS = 1_200;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

const recentHistory = (history: AskInput['history']) =>
  history
    .slice(-HISTORY_TURNS)
    .map((h) => ({ question: h.question, answer: clip(h.answer, HISTORY_ANSWER_CHARS) }));

export async function prepareAsk(
  deps: Deps,
  caller: AiCaller,
  body: AskInput,
  acceptLanguage: string | null,
): Promise<PreparedAsk> {
  const settings = await usableSettings(deps, caller);
  const config = modelConfigOf(deps, settings);
  const embedCfg = embedConfigOf(config, settings.embeddingModel);
  const tz = validZone(body.timeZone);
  const now = nowIn(tz);
  // A follow-up such as "ve ne zaman?" searches better together with the previous question.
  const last = body.history.at(-1)?.question;
  const q = last && body.question.length < 60 ? `${last} ${body.question}` : body.question;
  const tools = await availableTools(deps.db, caller.org.id);
  const [searched, pick] = await Promise.all([
    searchChunksFor(deps, caller, { q, kinds: [], limit: SEARCH_SOURCES, embedCfg }),
    // The tool choice is a short structured step: the "Hızlı model" when the admin set one.
    chooseTools(modelClient(modelConfigOf(deps, settings, { fast: true })), body, tools, now),
  ]);
  const runs = await runTools(deps, caller, pick.calls, tz);
  const live = runs.flatMap((r) => r.sources);
  // With live data the question is mostly about it: fewer search sources.
  const found = live.length ? searched.slice(0, SEARCH_SOURCES_WITH_LIVE) : searched;
  // Live data first: when the model asked for it, it is what the question is about.
  const citations: AiCitation[] = [...live.map((l) => l.hit), ...found.map((f) => f.hit)].map(
    (hit, i) => ({ ...hit, n: i + 1 }),
  );
  const sources = [
    ...live.map((l) => ({
      kind: l.hit.kind,
      title: l.hit.title,
      text: l.text,
      at: new Date(l.hit.at ?? l.hit.updatedAt),
    })),
    ...found.map((f) => ({
      kind: f.kind,
      title: f.title,
      text: clip(f.body || f.title, SOURCE_CHARS),
      at: f.sourceAt,
    })),
  ].map((src, i) => ({ ...src, n: i + 1 }));
  const locale: Locale = body.locale ?? resolveLocale(acceptLanguage);
  return {
    citations,
    prepared: {
      kind: 'model',
      action: 'ask',
      config,
      prompt: askPrompt(body.question, sources, {
        locale,
        asker: caller.userName,
        org: caller.org.name,
        history: recentHistory(body.history),
        now,
        checked: runs.map((r) => `${r.checked}: ${r.sources.length} found`),
      }),
      target: { type: 'question', id: null },
      extraUsage: {
        inputTokens: pick.inputTokens,
        cachedInputTokens: pick.cachedInputTokens ?? 0,
        outputTokens: pick.outputTokens,
      },
    },
  };
}

export async function askOnce(
  deps: Deps,
  caller: AiCaller,
  body: AskInput,
  req: RequestInfo,
): Promise<AiAskResult> {
  const { prepared, citations } = await prepareAsk(deps, caller, body, req.locale);
  const out = await executeRun(deps, caller, prepared, req, {});
  return {
    runId: out.runId,
    answer: out.text,
    citations,
    usage: { inputTokens: out.inputTokens, outputTokens: out.outputTokens },
    truncated: out.truncated,
  };
}
