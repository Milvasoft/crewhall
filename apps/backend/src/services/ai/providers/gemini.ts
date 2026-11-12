import { z } from 'zod';
import { baseOf } from './chat';
import {
  errorMessageOf,
  estimateTokens,
  kindOf,
  postJson,
  ProviderError,
  readSse,
  safeJson,
  toolArgs,
  type ModelClient,
  type ModelConfig,
  type ModelRequest,
  type ModelTurn,
} from './http';

/**
 * Google Gemini through its own Generative Language API (no SDK): `streamGenerateContent` as
 * server-sent events, the key in `x-goog-api-key`. The system prompt is `systemInstruction`;
 * conversation turns are `user` and `model` (Gemini's name for the assistant).
 */

const FINISH_REFUSED = new Set([
  'SAFETY',
  'RECITATION',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'IMAGE_SAFETY',
]);

/** System and context as `systemInstruction` parts (fixed parts first, like the others). */
const geminiSystem = (req: Pick<ModelRequest, 'system' | 'context'>) => ({
  parts: [{ text: req.system }, ...(req.context ? [{ text: req.context }] : [])],
});

/** Earlier turns and the prompt as Gemini `contents`. */
export function geminiContents(history: ModelTurn[], prompt: string) {
  return [...history, { role: 'user' as const, text: prompt }].map((t) => ({
    role: t.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: t.text }],
  }));
}

const GeminiChunk = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z
              .array(z.object({ text: z.string().nullish(), thought: z.boolean().nullish() }))
              .nullish(),
          })
          .nullish(),
        finishReason: z.string().nullish(),
      }),
    )
    .nullish(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().int().min(0).nullish(),
      candidatesTokenCount: z.number().int().min(0).nullish(),
      thoughtsTokenCount: z.number().int().min(0).nullish(),
      cachedContentTokenCount: z.number().int().min(0).nullish(),
    })
    .nullish(),
  promptFeedback: z.object({ blockReason: z.string().nullish() }).nullish(),
  error: z.unknown().optional(),
});

/** One parsed stream event: the visible text, the finish reason and the running usage. */
export function readGeminiChunk(data: string) {
  const parsed = GeminiChunk.safeParse(safeJson(data));
  if (!parsed.success) return null;
  const c = parsed.data;
  if (c.error) {
    const message = (errorMessageOf({ error: c.error }) ?? 'stream error').slice(0, 300);
    throw new ProviderError(message, null, kindOf(500, message));
  }
  const candidate = c.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .filter((p) => !p.thought && p.text)
    .map((p) => p.text)
    .join('');
  return {
    text,
    finish: candidate?.finishReason ?? null,
    blocked: c.promptFeedback?.blockReason ?? null,
    usage: c.usageMetadata ?? null,
  };
}

const keyHeader = (config: Pick<ModelConfig, 'apiKey'>): Record<string, string> =>
  config.apiKey ? { 'x-goog-api-key': config.apiKey } : {};

/** `models/gemini-2.5-flash` or a bare name both work in the URL. */
const modelPath = (model: string) =>
  model.startsWith('models/') ? model : `models/${encodeURIComponent(model)}`;

const GeminiToolAnswer = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z
              .array(
                z.object({
                  functionCall: z.object({ name: z.string(), args: z.unknown() }).nullish(),
                }),
              )
              .nullish(),
          })
          .nullish(),
      }),
    )
    .nullish(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().nullish(),
      candidatesTokenCount: z.number().nullish(),
      thoughtsTokenCount: z.number().nullish(),
      cachedContentTokenCount: z.number().nullish(),
    })
    .nullish(),
});

export function geminiClient(config: ModelConfig): ModelClient {
  if (!config.apiKey) throw new ProviderError('missing api key', null, 'auth');
  const url = `${baseOf(config)}/${modelPath(config.model)}:streamGenerateContent?alt=sse`;
  return {
    async pickTools(req) {
      const pickUrl = `${baseOf(config)}/${modelPath(config.model)}:generateContent`;
      const { res } = await postJson(pickUrl, {
        headers: keyHeader(config),
        body: {
          systemInstruction: geminiSystem(req),
          contents: geminiContents(req.history ?? [], req.prompt),
          tools: [
            {
              functionDeclarations: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              })),
            },
          ],
          toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
          generationConfig: { maxOutputTokens: req.maxTokens },
        },
        signal: req.signal,
      });
      const out = GeminiToolAnswer.safeParse(await res.json().catch(() => null));
      if (!out.success) throw new ProviderError('invalid response', res.status, 'server');
      const parts = out.data.candidates?.[0]?.content?.parts ?? [];
      const usage = out.data.usageMetadata;
      return {
        calls: parts.flatMap((p) =>
          p.functionCall
            ? [{ name: p.functionCall.name, args: toolArgs(p.functionCall.args) }]
            : [],
        ),
        inputTokens: usage?.promptTokenCount ?? 0,
        cachedInputTokens: usage?.cachedContentTokenCount ?? 0,
        outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
      };
    },
    async *stream(req) {
      const { res, timeout } = await postJson(url, {
        headers: { Accept: 'text/event-stream', ...keyHeader(config) },
        body: {
          systemInstruction: geminiSystem(req),
          contents: geminiContents(req.history ?? [], req.prompt),
          generationConfig: { maxOutputTokens: req.maxTokens },
        },
        signal: req.signal,
      });
      if (!res.body) throw new ProviderError('empty response', res.status, 'server');

      let input: number | null = null;
      let cached = 0;
      let output: number | null = null;
      let finish: string | null = null;
      let blocked = false;
      let chars = 0;
      for await (const data of readSse(res.body, { caller: req.signal, timeout })) {
        const chunk = readGeminiChunk(data);
        if (!chunk) continue;
        if (chunk.text) {
          chars += chunk.text.length;
          yield { type: 'text', text: chunk.text };
        }
        if (chunk.finish) finish = chunk.finish;
        if (chunk.blocked) blocked = true;
        // Usage is cumulative; the last event holds the totals.
        if (chunk.usage) {
          input = chunk.usage.promptTokenCount ?? input;
          cached = chunk.usage.cachedContentTokenCount ?? cached;
          const visible = chunk.usage.candidatesTokenCount ?? 0;
          const thinking = chunk.usage.thoughtsTokenCount ?? 0;
          if (chunk.usage.candidatesTokenCount != null || chunk.usage.thoughtsTokenCount != null) {
            output = visible + thinking;
          }
        }
      }
      yield {
        type: 'end',
        inputTokens:
          input ??
          estimateTokens(
            req.system.length +
              req.prompt.length +
              (req.history ?? []).reduce((n, t) => n + t.text.length, 0),
          ),
        cachedInputTokens: cached,
        outputTokens: output ?? estimateTokens(chars),
        truncated: finish === 'MAX_TOKENS',
        refused: blocked || (finish !== null && FINISH_REFUSED.has(finish)),
      };
    },
  };
}

const BatchEmbedResponse = z.object({
  embeddings: z.array(z.object({ values: z.array(z.number()) })),
});

/** `batchEmbedContents`: one request for the whole batch, answers in input order. */
export async function geminiEmbed(
  config: Pick<ModelConfig, 'provider' | 'baseUrl' | 'apiKey'>,
  model: string,
  inputs: string[],
): Promise<number[][]> {
  if (!config.apiKey) throw new ProviderError('missing api key', null, 'auth');
  const path = modelPath(model);
  const { res } = await postJson(`${baseOf(config)}/${path}:batchEmbedContents`, {
    headers: keyHeader(config),
    body: {
      requests: inputs.map((text) => ({
        model: path.replace(/%2F/g, '/'),
        content: { parts: [{ text }] },
      })),
    },
  });
  const parsed = BatchEmbedResponse.safeParse(await res.json().catch(() => null));
  if (!parsed.success || parsed.data.embeddings.length !== inputs.length) {
    throw new ProviderError('invalid embedding response', res.status, 'server');
  }
  return parsed.data.embeddings.map((e) => e.values);
}
