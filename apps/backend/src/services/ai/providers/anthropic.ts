import Anthropic from '@anthropic-ai/sdk';
import {
  ProviderError,
  TIMEOUT_MS,
  toolArgs,
  type ModelClient,
  type ModelConfig,
  type ModelRequest,
} from './http';

/** Claude API through the official SDK. */

/** Claude 5 generation models take `effort`; low keeps writing help quick and cheap. */
const EFFORT_MODELS = /^claude-(opus|sonnet|haiku|fable)-5/;

/**
 * System and context as cached blocks (tools render before them, so the mark on the system
 * block covers the tool definitions too). Below the model's minimum (512 tokens on the Claude 5
 * family) the API simply does not cache; nothing breaks.
 */
function systemBlocks(req: Pick<ModelRequest, 'system' | 'context'>) {
  return [
    { type: 'text' as const, text: req.system, cache_control: { type: 'ephemeral' as const } },
    ...(req.context
      ? [
          {
            type: 'text' as const,
            text: req.context,
            cache_control: { type: 'ephemeral' as const },
          },
        ]
      : []),
  ];
}

export function anthropicClient(config: ModelConfig): ModelClient {
  if (!config.apiKey) throw new ProviderError('missing api key', null, 'auth');
  const client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    maxRetries: 1,
    timeout: TIMEOUT_MS,
  });
  return {
    async *stream(req) {
      try {
        const stream = client.messages.stream(
          {
            model: config.model,
            max_tokens: req.maxTokens,
            system: systemBlocks(req),
            messages: [
              ...(req.history ?? []).map((t) => ({ role: t.role, content: t.text })),
              { role: 'user' as const, content: req.prompt },
            ],
            ...(EFFORT_MODELS.test(config.model) ? { output_config: { effort: 'low' } } : {}),
          },
          { signal: req.signal },
        );
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            yield { type: 'text', text: event.delta.text };
          }
        }
        const final = await stream.finalMessage();
        yield {
          type: 'end',
          inputTokens:
            final.usage.input_tokens +
            (final.usage.cache_creation_input_tokens ?? 0) +
            (final.usage.cache_read_input_tokens ?? 0),
          cachedInputTokens: final.usage.cache_read_input_tokens ?? 0,
          outputTokens: final.usage.output_tokens,
          truncated: final.stop_reason === 'max_tokens',
          refused: final.stop_reason === 'refusal',
        };
      } catch (err) {
        throw anthropicError(err);
      }
    },
    async pickTools(req) {
      try {
        const res = await client.messages.create(
          {
            model: config.model,
            max_tokens: req.maxTokens,
            system: systemBlocks(req),
            messages: [
              ...(req.history ?? []).map((t) => ({ role: t.role, content: t.text })),
              { role: 'user' as const, content: req.prompt },
            ],
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: { ...t.parameters },
            })),
            tool_choice: { type: 'auto' },
            ...(EFFORT_MODELS.test(config.model) ? { output_config: { effort: 'low' } } : {}),
          },
          { signal: req.signal },
        );
        return {
          calls: res.content.flatMap((b) =>
            b.type === 'tool_use' ? [{ name: b.name, args: toolArgs(b.input) }] : [],
          ),
          inputTokens:
            res.usage.input_tokens +
            (res.usage.cache_creation_input_tokens ?? 0) +
            (res.usage.cache_read_input_tokens ?? 0),
          cachedInputTokens: res.usage.cache_read_input_tokens ?? 0,
          outputTokens: res.usage.output_tokens,
        };
      } catch (err) {
        throw anthropicError(err);
      }
    },
  };
}

function anthropicError(err: unknown): Error {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.AuthenticationError)
    return new ProviderError('invalid api key', err.status, 'auth');
  if (err instanceof Anthropic.PermissionDeniedError)
    return new ProviderError('permission denied', err.status, 'auth');
  if (err instanceof Anthropic.NotFoundError)
    return new ProviderError('model not found', 404, 'not_found');
  if (err instanceof Anthropic.RateLimitError) {
    const quota = /credit|billing|quota/i.test(err.message);
    return new ProviderError(
      quota ? 'out of credit' : 'rate limited',
      429,
      quota ? 'quota' : 'rate_limit',
    );
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError)
    return new ProviderError('timed out', null, 'timeout');
  if (err instanceof Anthropic.APIConnectionError)
    return new ProviderError('connection failed', null, 'network');
  if (err instanceof Anthropic.APIError) {
    const message = err.message.slice(0, 300);
    if (/credit balance/i.test(message))
      return new ProviderError(message, err.status ?? null, 'quota');
    const status = err.status ?? null;
    return new ProviderError(
      message,
      status,
      status !== null && status >= 500 ? 'server' : 'bad_request',
    );
  }
  return new ProviderError(err instanceof Error ? err.message.slice(0, 300) : 'unknown error');
}
