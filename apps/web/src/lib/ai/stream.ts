import {
  ApiErrorBody,
  AI_RAW_PATHS,
  AiStreamEvent,
  type AiAskRequest,
  type AiRunRequest,
} from '@crewhall/shared';
import { config } from '@/config';
import { ApiError } from '@/lib/api';

/**
 * Runs an AI action over `AI_RAW_PATHS.stream` and hands each event to `onEvent`. Failures
 * before the stream opens throw ApiError like `api.call`; failures inside it arrive as an
 * `error` event. Abort with `signal` (closing the panel): the server stops the model too.
 */
export function streamAi(
  body: AiRunRequest,
  opts: { signal?: AbortSignal; locale?: string; onEvent: (e: AiStreamEvent) => void },
): Promise<void> {
  return streamPath(AI_RAW_PATHS.stream, body, opts);
}

/** "Crewhall'a sor": like streamAi, with a `citations` event first. */
export function streamAsk(
  body: AiAskRequest,
  opts: { signal?: AbortSignal; locale?: string; onEvent: (e: AiStreamEvent) => void },
): Promise<void> {
  return streamPath(AI_RAW_PATHS.ask, body, opts);
}

async function streamPath(
  path: string,
  body: unknown,
  opts: { signal?: AbortSignal; locale?: string; onEvent: (e: AiStreamEvent) => void },
): Promise<void> {
  const res = await fetch(new URL(path, config.apiUrl), {
    method: 'POST',
    credentials: 'include',
    signal: opts.signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(opts.locale ? { 'Accept-Language': opts.locale } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.headers.get('content-type')?.includes('text/event-stream') || !res.body) {
    const json: unknown = await res.json().catch(() => null);
    const parsed = ApiErrorBody.safeParse(json);
    if (parsed.success) {
      throw new ApiError(res.status, parsed.data.code, parsed.data.message, parsed.data.details);
    }
    throw new ApiError(res.status, 'internal', `HTTP ${res.status}`);
  }
  for await (const data of sseData(res.body)) {
    const event = AiStreamEvent.safeParse(safeJson(data));
    if (event.success) opts.onEvent(event.data);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The `data:` payloads of a server-sent event stream. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
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
  } finally {
    reader.releaseLock();
  }
}
