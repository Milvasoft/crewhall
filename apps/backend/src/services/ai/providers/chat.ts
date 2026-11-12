import { AI_PROVIDER_INFO, AZURE_DEFAULT_API_VERSION } from '@crewhall/shared';
import { z } from 'zod';
import {
  estimateTokens,
  errorMessageOf,
  kindOf,
  postJson,
  ProviderError,
  readSse,
  safeJson,
  systemText,
  toolArgs,
  type ModelClient,
  type ModelConfig,
  type ModelRequest,
} from './http';

/**
 * Everything that speaks the OpenAI chat-completions protocol: an own server (Ollama, vLLM,
 * LiteLLM, Groq …) and the hosted providers built on it. `chatTarget` holds the differences
 * (address, auth header, token limit field, extras); streaming and usage are the same.
 */

export interface ChatTarget {
  url: string;
  headers: Record<string, string>;
  /** Azure puts the deployment in the URL instead of the body. */
  sendModel: boolean;
  /** Newer OpenAI models take `max_completion_tokens`; most others `max_tokens`. */
  tokenField: 'max_tokens' | 'max_completion_tokens';
  /** Asks for the usage chunk at the end (servers that do not know it may refuse it). */
  includeUsage: boolean;
}

const trim = (url: string) => url.replace(/\/+$/, '');

/** The address of a hosted provider (or the gateway in front of it). */
export function baseOf(config: Pick<ModelConfig, 'provider' | 'baseUrl'>): string {
  const base = config.baseUrl ?? AI_PROVIDER_INFO[config.provider].defaultBaseUrl;
  if (!base) throw new ProviderError('missing base url', null, 'bad_request');
  return trim(base);
}

/** An Azure OpenAI deployment URL (the model is the deployment, the version a query). */
export function azureUrl(
  config: Pick<ModelConfig, 'provider' | 'baseUrl' | 'apiVersion'>,
  deployment: string,
  path: string,
): string {
  const version = config.apiVersion ?? AZURE_DEFAULT_API_VERSION;
  return `${baseOf(config)}/openai/deployments/${encodeURIComponent(deployment)}/${path}?api-version=${encodeURIComponent(version)}`;
}

const bearer = (key: string | null): Record<string, string> =>
  key ? { Authorization: `Bearer ${key}` } : {};

export function chatTarget(config: ModelConfig): ChatTarget {
  switch (config.provider) {
    case 'openai_compatible':
      return {
        url: `${baseOf(config)}/chat/completions`,
        headers: bearer(config.apiKey),
        sendModel: true,
        tokenField: 'max_tokens',
        includeUsage: true,
      };
    case 'openai':
      // GPT-5 and the o-series take max_completion_tokens (max_tokens is refused).
      return {
        url: `${baseOf(config)}/chat/completions`,
        headers: bearer(config.apiKey),
        sendModel: true,
        tokenField: 'max_completion_tokens',
        includeUsage: true,
      };
    case 'mistral':
      // Usage arrives in the last chunk without asking; stream_options is not part of its API.
      return {
        url: `${baseOf(config)}/chat/completions`,
        headers: bearer(config.apiKey),
        sendModel: true,
        tokenField: 'max_tokens',
        includeUsage: false,
      };
    case 'openrouter':
      // One key for many providers' models ("vendor/model"); X-Title names the app in its logs.
      return {
        url: `${baseOf(config)}/chat/completions`,
        headers: { ...bearer(config.apiKey), 'X-Title': 'Crewhall' },
        sendModel: true,
        tokenField: 'max_tokens',
        includeUsage: true,
      };
    case 'azure_openai':
      // https://<resource>.openai.azure.com/openai/deployments/<deployment>/…?api-version=…
      return {
        url: azureUrl(config, config.model, 'chat/completions'),
        headers: config.apiKey ? { 'api-key': config.apiKey } : {},
        sendModel: false,
        tokenField: 'max_completion_tokens',
        includeUsage: true,
      };
    default:
      throw new ProviderError(`unsupported provider ${config.provider}`, null, 'bad_request');
  }
}

const ChatChunk = z.object({
  choices: z
    .array(
      z.object({
        delta: z.object({ content: z.string().nullish() }).nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .nullish(),
  usage: z
    .object({
      prompt_tokens: z.number().int().min(0).nullish(),
      completion_tokens: z.number().int().min(0).nullish(),
      /** OpenAI and Azure cache prompt prefixes of 1024+ tokens on their own. */
      prompt_tokens_details: z
        .object({ cached_tokens: z.number().int().min(0).nullish() })
        .nullish(),
    })
    .nullish(),
  /** Some servers report a failure inside the stream. */
  error: z.unknown().optional(),
});

const ToolChoice = z.object({
  choices: z
    .array(
      z.object({
        message: z
          .object({
            tool_calls: z
              .array(z.object({ function: z.object({ name: z.string(), arguments: z.unknown() }) }))
              .nullish(),
          })
          .nullish(),
      }),
    )
    .nullish(),
  usage: z
    .object({
      prompt_tokens: z.number().int().min(0).nullish(),
      completion_tokens: z.number().int().min(0).nullish(),
      prompt_tokens_details: z
        .object({ cached_tokens: z.number().int().min(0).nullish() })
        .nullish(),
    })
    .nullish(),
});

/** System, earlier turns and the prompt as chat messages. */
export function chatMessages(req: ModelRequest) {
  return [
    // Fixed parts first: OpenAI-style servers cache the longest repeated prefix themselves.
    { role: 'system', content: systemText(req) },
    ...(req.history ?? []).map((t) => ({ role: t.role, content: t.text })),
    { role: 'user', content: req.prompt },
  ];
}

export function chatClient(config: ModelConfig): ModelClient {
  const target = chatTarget(config);
  if (AI_PROVIDER_INFO[config.provider].apiKey === 'required' && !config.apiKey) {
    throw new ProviderError('missing api key', null, 'auth');
  }
  return {
    async *stream(req) {
      const { res, timeout } = await postJson(target.url, {
        headers: { Accept: 'text/event-stream', ...target.headers },
        body: {
          ...(target.sendModel ? { model: config.model } : {}),
          [target.tokenField]: req.maxTokens,
          stream: true,
          ...(target.includeUsage ? { stream_options: { include_usage: true } } : {}),
          messages: chatMessages(req),
        },
        signal: req.signal,
      });
      if (!res.body) throw new ProviderError('empty response', res.status, 'server');

      let inputTokens: number | null = null;
      let cachedInputTokens = 0;
      let outputTokens: number | null = null;
      let finish: string | null = null;
      let chars = 0;
      for await (const data of readSse(res.body, { caller: req.signal, timeout })) {
        if (data === '[DONE]') break;
        const chunk = ChatChunk.safeParse(safeJson(data));
        if (!chunk.success) continue;
        if (chunk.data.error) {
          const message = (errorMessageOf({ error: chunk.data.error }) ?? 'stream error').slice(
            0,
            300,
          );
          throw new ProviderError(message, null, kindOf(500, message));
        }
        for (const choice of chunk.data.choices ?? []) {
          const text = choice.delta?.content;
          if (text) {
            chars += text.length;
            yield { type: 'text', text };
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
        if (chunk.data.usage) {
          inputTokens = chunk.data.usage.prompt_tokens ?? inputTokens;
          cachedInputTokens =
            chunk.data.usage.prompt_tokens_details?.cached_tokens ?? cachedInputTokens;
          outputTokens = chunk.data.usage.completion_tokens ?? outputTokens;
        }
      }
      yield {
        type: 'end',
        inputTokens:
          inputTokens ??
          estimateTokens(
            req.system.length +
              req.prompt.length +
              (req.history ?? []).reduce((n, t) => n + t.text.length, 0),
          ),
        cachedInputTokens,
        outputTokens: outputTokens ?? estimateTokens(chars),
        truncated: finish === 'length',
        refused: finish === 'content_filter',
      };
    },
    async pickTools(req) {
      const { res } = await postJson(target.url, {
        headers: target.headers,
        body: {
          ...(target.sendModel ? { model: config.model } : {}),
          [target.tokenField]: req.maxTokens,
          messages: chatMessages(req),
          tools: req.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
          tool_choice: 'auto',
        },
        signal: req.signal,
      });
      const out = ToolChoice.safeParse(await res.json().catch(() => null));
      if (!out.success) throw new ProviderError('invalid response', res.status, 'server');
      return {
        calls: (out.data.choices?.[0]?.message?.tool_calls ?? []).map((c) => ({
          name: c.function.name,
          args: toolArgs(c.function.arguments),
        })),
        inputTokens:
          out.data.usage?.prompt_tokens ?? estimateTokens(req.system.length + req.prompt.length),
        cachedInputTokens: out.data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        outputTokens: out.data.usage?.completion_tokens ?? 0,
      };
    },
  };
}
