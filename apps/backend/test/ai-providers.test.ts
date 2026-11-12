import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_PROVIDER_INFO, type AiProvider } from '@crewhall/shared';
import {
  modelClient,
  ProviderError,
  type ModelChunk,
  type ModelConfig,
  type ModelRequest,
} from '../src/services/ai/providers';
import { providerAppError } from '../src/services/ai/run';
import { embed, embedConfigOf } from '../src/services/ai/search/embed';

/** Every provider adapter against a mocked fetch: request shape, streaming, usage, errors. */

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const enc = new TextEncoder();

/** An SSE response of `data:` events (objects are JSON-encoded; strings sent as they are). */
function sse(events: (object | string)[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) {
        const data = typeof e === 'string' ? e : JSON.stringify(e);
        // Split each event in two pieces to exercise the chunk joining.
        const line = `data: ${data}\n\n`;
        c.enqueue(enc.encode(line.slice(0, 7)));
        c.enqueue(enc.encode(line.slice(7)));
      }
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function mockFetch(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    const call = { url, headers, body: JSON.parse(raw) as Record<string, unknown> };
    calls.push(call);
    return answer(call);
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const REQ: ModelRequest = {
  system: 'Kısa cevap ver.',
  history: [
    { role: 'user', text: 'Merhaba' },
    { role: 'assistant', text: 'Merhaba, buyrun.' },
  ],
  prompt: 'Özetle: sürüm cuma.',
  maxTokens: 200,
};

async function run(config: ModelConfig, req: ModelRequest = REQ) {
  let text = '';
  let end: Extract<ModelChunk, { type: 'end' }> | null = null;
  for await (const chunk of modelClient(config).stream(req)) {
    if (chunk.type === 'text') text += chunk.text;
    else end = chunk;
  }
  return { text, end: end! };
}

async function failure(config: ModelConfig) {
  const err = await run(config).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderError);
  return err as ProviderError;
}

const configOf = (provider: AiProvider, extra: Partial<ModelConfig> = {}): ModelConfig => ({
  provider,
  model: AI_PROVIDER_INFO[provider].defaultModel,
  baseUrl: null,
  apiKey: 'sk-test-0123456789',
  apiVersion: null,
  ...extra,
});

/** OpenAI-style streamed answer with a usage chunk at the end. */
const chatStream = (finish = 'stop') =>
  sse([
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'Sürüm ' } }] },
    { choices: [{ index: 0, delta: { content: 'cuma.' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    { choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } },
    '[DONE]',
  ]);

describe('openai (ChatGPT)', () => {
  it('streams from api.openai.com with max_completion_tokens and counts usage', async () => {
    const calls = mockFetch(() => chatStream());
    const out = await run(configOf('openai'));
    expect(out).toEqual({
      text: 'Sürüm cuma.',
      end: {
        type: 'end',
        inputTokens: 42,
        cachedInputTokens: 0,
        outputTokens: 7,
        truncated: false,
        refused: false,
      },
    });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-test-0123456789');
    expect(calls[0]!.body).toMatchObject({
      model: 'gpt-5-mini',
      max_completion_tokens: 200,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: 'Kısa cevap ver.' },
        { role: 'user', content: 'Merhaba' },
        { role: 'assistant', content: 'Merhaba, buyrun.' },
        { role: 'user', content: 'Özetle: sürüm cuma.' },
      ],
    });
    expect(calls[0]!.body).not.toHaveProperty('max_tokens');
  });

  it('uses a gateway address when one is set and marks a cut answer', async () => {
    const calls = mockFetch(() => chatStream('length'));
    const out = await run(configOf('openai', { baseUrl: 'https://gw.example.com/v1' }));
    expect(calls[0]!.url).toBe('https://gw.example.com/v1/chat/completions');
    expect(out.end.truncated).toBe(true);
  });

  it('maps 401, rate limits and insufficient quota', async () => {
    mockFetch(() =>
      json(401, { error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } }),
    );
    const auth = await failure(configOf('openai'));
    expect(auth).toMatchObject({ kind: 'auth', status: 401 });
    expect(providerAppError(auth).code).toBe('ai_not_configured');
    vi.restoreAllMocks();

    mockFetch(() =>
      json(429, {
        error: { message: 'Rate limit reached for gpt-5-mini', code: 'rate_limit_exceeded' },
      }),
    );
    expect(providerAppError(await failure(configOf('openai'))).code).toBe('rate_limited');
    vi.restoreAllMocks();

    mockFetch(() =>
      json(429, {
        error: { message: 'You exceeded your current quota', code: 'insufficient_quota' },
      }),
    );
    const quota = providerAppError(await failure(configOf('openai')));
    expect(quota.code).toBe('ai_quota_exceeded');
    expect(quota.details).toMatchObject({ scope: 'provider' });
  });

  it('needs a key before any request', async () => {
    const calls = mockFetch(() => chatStream());
    const err = await failure(configOf('openai', { apiKey: null }));
    expect(err.kind).toBe('auth');
    expect(calls).toHaveLength(0);
  });

  it('embeds with the embeddings endpoint, in input order', async () => {
    const calls = mockFetch(() =>
      json(200, {
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
        usage: { prompt_tokens: 4 },
      }),
    );
    const cfg = embedConfigOf(configOf('openai'), 'text-embedding-3-small')!;
    expect(await embed(cfg, ['bir', 'iki'])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/embeddings');
    expect(calls[0]!.body).toEqual({ model: 'text-embedding-3-small', input: ['bir', 'iki'] });
  });
});

describe('error reports inside a stream', () => {
  it('turns an error event into a provider error', async () => {
    mockFetch(() =>
      sse([
        { choices: [{ index: 0, delta: { content: 'Yar' } }] },
        { error: { message: 'Upstream overloaded', code: 'server_error' } },
      ]),
    );
    const err = await failure(configOf('openai'));
    expect(err.message).toContain('Upstream overloaded');
  });
});

describe('mistral', () => {
  it('streams from api.mistral.ai with max_tokens and the usage of the last chunk', async () => {
    const calls = mockFetch(() =>
      sse([
        { choices: [{ index: 0, delta: { role: 'assistant', content: 'Sürüm ' } }] },
        {
          choices: [{ index: 0, delta: { content: 'cuma.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
        },
        '[DONE]',
      ]),
    );
    const out = await run(configOf('mistral'));
    expect(out.text).toBe('Sürüm cuma.');
    expect(out.end).toMatchObject({ inputTokens: 30, outputTokens: 5 });
    expect(calls[0]!.url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(calls[0]!.body).toMatchObject({ model: 'mistral-medium-latest', max_tokens: 200 });
    expect(calls[0]!.body).not.toHaveProperty('stream_options');
  });

  it('maps its error bodies (message at the top level)', async () => {
    mockFetch(() => json(401, { message: 'Unauthorized', request_id: 'abc' }));
    const auth = await failure(configOf('mistral'));
    expect(auth).toMatchObject({ kind: 'auth', message: 'Unauthorized' });
    vi.restoreAllMocks();
    mockFetch(() => json(429, { message: 'Requests rate limit exceeded' }));
    expect((await failure(configOf('mistral'))).kind).toBe('rate_limit');
  });

  it('embeds with mistral-embed', async () => {
    const calls = mockFetch(() =>
      json(200, { data: [{ index: 0, embedding: [0.5, 0.5] }], model: 'mistral-embed' }),
    );
    const cfg = embedConfigOf(configOf('mistral'), 'mistral-embed')!;
    expect(await embed(cfg, ['metin'])).toEqual([[0.5, 0.5]]);
    expect(calls[0]!.url).toBe('https://api.mistral.ai/v1/embeddings');
  });
});

describe('openrouter', () => {
  it('streams through openrouter.ai, skipping its keep-alive comments', async () => {
    const calls = mockFetch(() => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(': OPENROUTER PROCESSING\n\n'));
          c.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Merhaba' } }] })}\n\n`,
            ),
          );
          c.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
            ),
          );
          c.close();
        },
      });
      return new Response(body, { status: 200 });
    });
    const out = await run(configOf('openrouter'));
    expect(out).toMatchObject({ text: 'Merhaba', end: { inputTokens: 12, outputTokens: 2 } });
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0]!.headers['x-title']).toBe('Crewhall');
    expect(calls[0]!.body.model).toBe('openai/gpt-5-mini');
  });

  it('maps 402 (no credit) to the provider quota', async () => {
    mockFetch(() => json(402, { error: { code: 402, message: 'Insufficient credits' } }));
    const err = await failure(configOf('openrouter'));
    expect(err.kind).toBe('quota');
    expect(providerAppError(err).code).toBe('ai_quota_exceeded');
  });

  it('has no embeddings', () => {
    expect(embedConfigOf(configOf('openrouter'), 'whatever')).toBeNull();
  });
});

describe('azure openai', () => {
  const azure = (extra: Partial<ModelConfig> = {}) =>
    configOf('azure_openai', {
      baseUrl: 'https://kurum.openai.azure.com',
      model: 'gpt4o-mini-prod',
      apiKey: 'azure-key-0123456789',
      ...extra,
    });

  it('calls the deployment with api-key and api-version, without a model in the body', async () => {
    const calls = mockFetch(() =>
      sse([
        // Azure sends the prompt filter results first, with no choices.
        { choices: [], prompt_filter_results: [{ prompt_index: 0 }] },
        { choices: [{ index: 0, delta: { content: 'Tamam.' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 3 } },
        '[DONE]',
      ]),
    );
    const out = await run(azure());
    expect(out).toMatchObject({ text: 'Tamam.', end: { inputTokens: 20, outputTokens: 3 } });
    expect(calls[0]!.url).toBe(
      'https://kurum.openai.azure.com/openai/deployments/gpt4o-mini-prod/chat/completions?api-version=2024-10-21',
    );
    expect(calls[0]!.headers['api-key']).toBe('azure-key-0123456789');
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.body).not.toHaveProperty('model');
    expect(calls[0]!.body).toMatchObject({ max_completion_tokens: 200 });
  });

  it('uses the configured api-version and reports a filtered answer as refused', async () => {
    const calls = mockFetch(() =>
      sse([{ choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] }, '[DONE]']),
    );
    const out = await run(azure({ apiVersion: '2025-01-01-preview' }));
    expect(calls[0]!.url).toContain('api-version=2025-01-01-preview');
    expect(out.end.refused).toBe(true);
  });

  it('maps an unknown deployment and a token rate limit', async () => {
    mockFetch(() =>
      json(404, {
        error: {
          code: 'DeploymentNotFound',
          message: 'The API deployment for this resource does not exist.',
        },
      }),
    );
    expect((await failure(azure())).kind).toBe('not_found');
    vi.restoreAllMocks();
    mockFetch(() =>
      json(429, {
        error: {
          code: '429',
          message:
            'Requests to the ChatCompletions_Create Operation have exceeded token rate limit.',
        },
      }),
    );
    expect((await failure(azure())).kind).toBe('rate_limit');
  });

  it('needs the resource address', async () => {
    mockFetch(() => json(200, {}));
    await expect(run(azure({ baseUrl: null }))).rejects.toThrow('missing base url');
  });

  it('embeds with the embedding deployment', async () => {
    const calls = mockFetch(() => json(200, { data: [{ index: 0, embedding: [1, 2, 3] }] }));
    const cfg = embedConfigOf(azure(), 'embed-prod')!;
    expect(await embed(cfg, ['metin'])).toEqual([[1, 2, 3]]);
    expect(calls[0]!.url).toBe(
      'https://kurum.openai.azure.com/openai/deployments/embed-prod/embeddings?api-version=2024-10-21',
    );
    expect(calls[0]!.body).toEqual({ input: ['metin'] });
  });
});

describe('gemini', () => {
  const GEMINI_STREAM = [
    {
      candidates: [{ content: { role: 'model', parts: [{ text: 'düşünüyorum', thought: true }] } }],
      usageMetadata: { promptTokenCount: 50 },
    },
    {
      candidates: [{ content: { role: 'model', parts: [{ text: 'Sürüm ' }] } }],
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 2 },
    },
    {
      candidates: [
        { content: { role: 'model', parts: [{ text: 'cuma.' }] }, finishReason: 'STOP' },
      ],
      usageMetadata: {
        promptTokenCount: 50,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 12,
        totalTokenCount: 66,
      },
    },
  ];

  it('streams generateContent SSE, maps roles and counts thinking as output', async () => {
    const calls = mockFetch(() => sse(GEMINI_STREAM));
    const out = await run(configOf('gemini', { apiKey: 'AIza-test-key-0123' }));
    expect(out).toEqual({
      text: 'Sürüm cuma.',
      end: {
        type: 'end',
        inputTokens: 50,
        cachedInputTokens: 0,
        outputTokens: 16,
        truncated: false,
        refused: false,
      },
    });
    expect(calls[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
    );
    expect(calls[0]!.headers['x-goog-api-key']).toBe('AIza-test-key-0123');
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.body).toEqual({
      systemInstruction: { parts: [{ text: 'Kısa cevap ver.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'Merhaba' }] },
        { role: 'model', parts: [{ text: 'Merhaba, buyrun.' }] },
        { role: 'user', parts: [{ text: 'Özetle: sürüm cuma.' }] },
      ],
      generationConfig: { maxOutputTokens: 200 },
    });
  });

  it('reads finish reasons: MAX_TOKENS is cut, SAFETY and a blocked prompt are refused', async () => {
    mockFetch(() =>
      sse([
        { candidates: [{ content: { parts: [{ text: 'Yar' }] }, finishReason: 'MAX_TOKENS' }] },
      ]),
    );
    expect((await run(configOf('gemini'))).end.truncated).toBe(true);
    vi.restoreAllMocks();
    mockFetch(() => sse([{ candidates: [{ finishReason: 'SAFETY' }] }]));
    expect((await run(configOf('gemini'))).end.refused).toBe(true);
    vi.restoreAllMocks();
    mockFetch(() =>
      sse([
        {
          promptFeedback: { blockReason: 'PROHIBITED_CONTENT' },
          usageMetadata: { promptTokenCount: 9 },
        },
      ]),
    );
    const blocked = await run(configOf('gemini'));
    expect(blocked.end).toMatchObject({ refused: true, inputTokens: 9 });
  });

  it('maps a wrong key (400 API_KEY_INVALID), quota and rate limits', async () => {
    mockFetch(() =>
      json(400, {
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
        },
      }),
    );
    const auth = await failure(configOf('gemini'));
    expect(auth.kind).toBe('auth');
    expect(providerAppError(auth).code).toBe('ai_not_configured');
    vi.restoreAllMocks();

    mockFetch(() =>
      json(429, {
        error: {
          code: 429,
          message: 'You exceeded your current quota, please check your plan and billing details.',
          status: 'RESOURCE_EXHAUSTED',
        },
      }),
    );
    expect((await failure(configOf('gemini'))).kind).toBe('quota');
    vi.restoreAllMocks();

    mockFetch(() =>
      json(429, {
        error: {
          code: 429,
          message: 'Resource has been exhausted (e.g. check rate).',
          status: 'RESOURCE_EXHAUSTED',
        },
      }),
    );
    expect((await failure(configOf('gemini'))).kind).toBe('rate_limit');
  });

  it('embeds with batchEmbedContents', async () => {
    const calls = mockFetch(() =>
      json(200, { embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] }),
    );
    const cfg = embedConfigOf(configOf('gemini'), 'gemini-embedding-001')!;
    expect(await embed(cfg, ['bir', 'iki'])).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(calls[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents',
    );
    expect(calls[0]!.body).toEqual({
      requests: [
        { model: 'models/gemini-embedding-001', content: { parts: [{ text: 'bir' }] } },
        { model: 'models/gemini-embedding-001', content: { parts: [{ text: 'iki' }] } },
      ],
    });
  });
});

describe('anthropic', () => {
  it('has no embeddings', () => {
    expect(embedConfigOf(configOf('anthropic'), 'voyage-3')).toBeNull();
  });
});

describe('tool choice (function calling)', () => {
  const TOOLS = [
    {
      name: 'upcoming_events',
      description: 'Calendar',
      parameters: {
        type: 'object' as const,
        properties: { from: { type: 'string' as const } },
      },
    },
  ];
  const pick = (config: ModelConfig) =>
    modelClient(config).pickTools!({
      system: 'Seç.',
      prompt: 'yarın ne var',
      tools: TOOLS,
      maxTokens: 100,
    });

  it('OpenAI family: tools as functions, tool_calls with JSON string arguments', async () => {
    const calls = mockFetch(() =>
      json(200, {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: { name: 'upcoming_events', arguments: '{"from":"2026-10-24"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 9 },
      }),
    );
    expect(await pick(configOf('openai'))).toEqual({
      calls: [{ name: 'upcoming_events', args: { from: '2026-10-24' } }],
      inputTokens: 50,
      cachedInputTokens: 0,
      outputTokens: 9,
    });
    expect(calls[0]!.body).toMatchObject({
      tool_choice: 'auto',
      tools: [{ type: 'function', function: { name: 'upcoming_events' } }],
    });
    expect(calls[0]!.body.stream).toBeUndefined();
  });

  it('Gemini: functionDeclarations and functionCall parts', async () => {
    const calls = mockFetch(() =>
      json(200, {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'upcoming_events', args: { from: 'x' } } }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5 },
      }),
    );
    expect((await pick(configOf('gemini'))).calls).toEqual([
      { name: 'upcoming_events', args: { from: 'x' } },
    ]);
    expect(calls[0]!.url).toMatch(/:generateContent$/);
    expect(calls[0]!.body).toMatchObject({
      tools: [{ functionDeclarations: [{ name: 'upcoming_events' }] }],
    });
  });

  it('Claude: tools with input_schema and tool_use blocks', async () => {
    const calls = mockFetch(() =>
      json(200, {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'upcoming_events', input: { from: 'y' } }],
        usage: { input_tokens: 70, output_tokens: 11 },
      }),
    );
    expect(await pick(configOf('anthropic'))).toEqual({
      calls: [{ name: 'upcoming_events', args: { from: 'y' } }],
      inputTokens: 70,
      cachedInputTokens: 0,
      outputTokens: 11,
    });
    expect(calls[0]!.body).toMatchObject({
      tool_choice: { type: 'auto' },
      tools: [{ name: 'upcoming_events', input_schema: { type: 'object' } }],
    });
  });

  it('a server without function calling refuses with bad_request', async () => {
    mockFetch(() => json(400, { error: { message: 'tools not supported' } }));
    const err = await pick(configOf('openai_compatible', { baseUrl: 'http://llm.local/v1' })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('bad_request');
  });
});

describe('prompt cache', () => {
  const withContext = { ...REQ, context: '<people>Elif</people>' };

  it('puts the context after the fixed system text and reads cache hits (OpenAI)', async () => {
    const calls = mockFetch(() =>
      sse([
        { choices: [{ delta: { content: 'Tamam' } }] },
        {
          choices: [],
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 3,
            prompt_tokens_details: { cached_tokens: 1024 },
          },
        },
        '[DONE]',
      ]),
    );
    const out = await run(configOf('openai'), withContext);
    expect(out.end).toMatchObject({ inputTokens: 1200, cachedInputTokens: 1024 });
    const messages = calls[0]!.body.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({
      role: 'system',
      content: `${REQ.system}\n\n<people>Elif</people>`,
    });
  });

  it('sends system and context as two systemInstruction parts (Gemini)', async () => {
    const calls = mockFetch(() =>
      sse([
        {
          candidates: [{ content: { parts: [{ text: 'Tamam' }] }, finishReason: 'STOP' }],
          usageMetadata: {
            promptTokenCount: 900,
            candidatesTokenCount: 2,
            cachedContentTokenCount: 600,
          },
        },
      ]),
    );
    const out = await run(configOf('gemini'), withContext);
    expect(out.end.cachedInputTokens).toBe(600);
    expect(calls[0]!.body.systemInstruction).toEqual({
      parts: [{ text: REQ.system }, { text: '<people>Elif</people>' }],
    });
  });
});
