import type { AiProvider } from '@crewhall/shared';

/**
 * What every provider adapter shares: the request and chunk shapes, errors with a kind the rest
 * of the module maps to error codes, the fetch with a timeout, and the SSE reader.
 */

export interface ModelConfig {
  provider: AiProvider;
  /** Azure OpenAI: the deployment name. */
  model: string;
  /** Own servers and Azure: required; hosted providers: null (their own address) or a gateway. */
  baseUrl: string | null;
  apiKey: string | null;
  /** Azure OpenAI `api-version`. */
  apiVersion: string | null;
}

/** An earlier turn of a conversation (Gemini calls the assistant role `model`). */
export interface ModelTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ModelRequest {
  /** Fixed instructions: byte-identical between requests, so providers can cache them. */
  system: string;
  /**
   * Material that changes rarely (the org's people …), sent right after `system` and cached
   * with it. Anything that changes per request (time, the asker) belongs in `prompt`.
   */
  context?: string | undefined;
  /** Earlier turns before `prompt`, oldest first. */
  history?: ModelTurn[];
  prompt: string;
  maxTokens: number;
  signal?: AbortSignal | undefined;
}

export type ModelChunk =
  | { type: 'text'; text: string }
  | {
      type: 'end';
      inputTokens: number;
      /** Part of `inputTokens` the provider served from its prompt cache. */
      cachedInputTokens?: number;
      outputTokens: number;
      truncated: boolean;
      refused: boolean;
    };

/** JSON Schema of a tool's arguments: the small subset every provider accepts. */
export interface ToolParameters {
  type: 'object';
  properties: Record<
    string,
    {
      type: 'string' | 'integer' | 'number' | 'boolean';
      description?: string;
      enum?: string[];
    }
  >;
  required?: string[];
}

/** A read-only tool the model may ask for before it answers. */
export interface ModelTool {
  name: string;
  description: string;
  parameters: ToolParameters;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolPick {
  calls: ToolCall[];
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
}

/** System and context as one text, for providers that take a single system message. */
export const systemText = (req: Pick<ModelRequest, 'system' | 'context'>) =>
  req.context ? `${req.system}\n\n${req.context}` : req.system;

export interface ToolPickRequest extends Omit<ModelRequest, 'maxTokens'> {
  tools: ModelTool[];
  maxTokens: number;
}

export interface ModelClient {
  stream(req: ModelRequest): AsyncGenerator<ModelChunk>;
  /**
   * Function calling: which tools the model wants for this request (none is a valid answer).
   * One short call without streaming; providers without tool support throw `bad_request`.
   */
  pickTools?(req: ToolPickRequest): Promise<ToolPick>;
}

/** Tool arguments arrive as an object or (OpenAI) as a JSON string. */
export function toolArgs(raw: unknown): Record<string, unknown> {
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * auth: wrong or missing key, no access to the model · rate_limit: too many requests now ·
 * quota: the account is out of credit or over its plan · not_found: unknown model/deployment ·
 * bad_request: the provider refused the request · server, network, timeout: try again later.
 */
export type ProviderErrorKind =
  'auth' | 'rate_limit' | 'quota' | 'not_found' | 'bad_request' | 'server' | 'network' | 'timeout';

/** The provider failed; `message` is safe to show an admin (never contains the key). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly kind: ProviderErrorKind = 'server',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export const TIMEOUT_MS = 60_000;

const QUOTA = /insufficient_quota|exceeded your current quota|quota|billing|credit|payment/i;

export function kindOf(status: number, message: string): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota';
  if (status === 404) return 'not_found';
  if (status === 429) return QUOTA.test(message) ? 'quota' : 'rate_limit';
  if (status >= 500) return 'server';
  // Gemini answers a wrong key with 400 API_KEY_INVALID.
  if (/api[_ ]key/i.test(message) && /invalid|not valid|missing/i.test(message)) return 'auth';
  return 'bad_request';
}

/** The message of an error body: OpenAI `{error:{message}}`, Gemini `{error:{message,status}}`, Mistral `{message}`. */
export function errorMessageOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const err = b.error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const parts = [e.message, e.code, e.status, e.type].filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    );
    if (parts.length) return parts.join(' · ');
  }
  if (typeof b.message === 'string') return b.message;
  if (typeof b.detail === 'string') return b.detail;
  return null;
}

export async function providerErrorFrom(res: Response): Promise<ProviderError> {
  const text = await res.text().catch(() => '');
  const message = (errorMessageOf(safeJson(text)) ?? `HTTP ${res.status}`).slice(0, 300);
  return new ProviderError(message, res.status, kindOf(res.status, message));
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Rough count for servers that do not report usage: ~4 characters per token. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

/**
 * POSTs JSON with the module's timeout; network failures and non-2xx answers become a
 * ProviderError (an abort by the caller is rethrown as it is).
 */
export async function postJson(
  url: string,
  init: { headers: Record<string, string>; body: unknown; signal?: AbortSignal | undefined },
  timeoutMs = TIMEOUT_MS,
): Promise<{ res: Response; timeout: AbortSignal }> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', ...init.headers },
      body: JSON.stringify(init.body),
    });
  } catch (err) {
    if (init.signal?.aborted) throw err;
    throw timeout.aborted
      ? new ProviderError('timed out', null, 'timeout')
      : new ProviderError('connection failed', null, 'network');
  }
  if (!res.ok) throw await providerErrorFrom(res);
  return { res, timeout };
}

/** The `data:` payloads of a server-sent event stream (multi-line data joined with \n). */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line === '') {
        if (data.length) yield data.join('\n');
        data = [];
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
  if (data.length) yield data.join('\n');
}

/** Reads a streamed answer, turning a broken connection into a ProviderError. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signals: { caller?: AbortSignal | undefined; timeout: AbortSignal },
): AsyncGenerator<string> {
  try {
    for await (const data of sseData(body)) yield data;
  } catch (err) {
    if (signals.caller?.aborted) throw err;
    throw signals.timeout.aborted
      ? new ProviderError('timed out', null, 'timeout')
      : new ProviderError('stream interrupted', null, 'network');
  }
}
