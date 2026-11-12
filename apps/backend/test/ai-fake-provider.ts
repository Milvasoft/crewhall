import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A fake model server for the AI tests: speaks the OpenAI chat-completions stream
 * (`POST /v1/chat/completions`) and the Claude Messages stream (`POST /v1/messages`, what the
 * official SDK calls). No request leaves the machine; every request is kept for assertions.
 */

export interface FakeRequest {
  path: string;
  headers: IncomingMessage['headers'];
  body: {
    model?: string;
    max_tokens?: number;
    /** A string, or (Claude, cached) text blocks. */
    system?: string | { type: string; text: string; cache_control?: unknown }[];
    messages?: { role: string; content: string }[];
    output_config?: { effort?: string };
    stream?: boolean;
    input?: string[];
    /** Function calling: OpenAI `{type, function}` or Claude `{name, input_schema}`. */
    tools?: { name?: string; function?: { name: string } }[];
  };
}

/** The system prompt of a request as one text (Claude sends cached blocks). */
export function systemOf(r: FakeRequest): string {
  const s = r.body.system;
  return typeof s === 'string' ? s : (s ?? []).map((b) => b.text).join('\n');
}

export class FakeProvider {
  readonly requests: FakeRequest[] = [];
  /** Speech-to-text calls (multipart; only the model and size are kept). */
  readonly transcriptions: { model: string | null; bytes: number; auth: string | null }[] = [];
  transcript = 'Merhaba. Sürüm cuma çıkıyor. Elif test raporunu perşembeye hazırlayacak.';
  /** Text streamed back, in three pieces. */
  reply = 'Kısa bir özet.';
  /** Answers for the next requests, in order; `reply` once they run out. */
  replies: string[] = [];
  /** Computes the answer from the request (the eval's mock model); wins over `replies`. */
  responder: ((request: FakeRequest) => string) | null = null;
  /** What the next requests do. */
  mode: 'ok' | 'unauthorized' | 'rate_limit' | 'quota' | 'refuse' | 'length' | 'no_usage' = 'ok';
  /** Required key; requests with another one get 401. */
  apiKey: string | null = null;
  /** `cached`: the part of `input` reported as read from the prompt cache. */
  usage = { input: 120, output: 30, cached: 0 };
  /** Requests with `tools` (the Ask tool choice), kept apart from the answers. */
  readonly toolRequests: FakeRequest[] = [];
  /** The tools the next tool choice asks for. */
  toolCalls: { name: string; args: Record<string, unknown> }[] = [];
  /** Like an own server without function calling: requests with `tools` get 400. */
  noTools = false;
  private server: Server | null = null;
  url = '';

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  close() {
    return new Promise<void>((resolve) => {
      this.server?.closeAllConnections();
      this.server?.close(() => resolve());
    });
  }

  reset() {
    this.requests.length = 0;
    this.toolRequests.length = 0;
    this.toolCalls = [];
    this.noTools = false;
    this.transcriptions.length = 0;
    this.reply = 'Kısa bir özet.';
    this.replies = [];
    this.responder = null;
    this.mode = 'ok';
    this.usage = { input: 120, output: 30, cached: 0 };
  }

  /** Every prompt text the fake received (system + messages), for privacy assertions. */
  allPromptText() {
    return this.requests
      .map((r) => [systemOf(r), ...(r.body.messages ?? []).map((m) => m.content)].join('\n'))
      .join('\n');
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const path = (req.url ?? '').split('?')[0]!;
    if (path.endsWith('/audio/transcriptions')) {
      const form = Buffer.concat(chunks).toString('latin1');
      this.transcriptions.push({
        model: modelField(form),
        bytes: Buffer.concat(chunks).length,
        auth: req.headers.authorization ?? null,
      });
      if (this.mode === 'unauthorized') {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end('{}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          text: this.transcript,
          language: 'tr',
          duration: 61.5,
          segments: [{ start: 0, end: 61.5, text: this.transcript }],
        }),
      );
      return;
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = (raw ? JSON.parse(raw) : {}) as FakeRequest['body'];
    if (body.tools && this.mode === 'ok') {
      this.toolRequests.push({ path, headers: req.headers, body });
      if (this.noTools) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'tools are not supported by this model' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          path.endsWith('/v1/messages')
            ? {
                id: 'msg_tools',
                type: 'message',
                role: 'assistant',
                model: body.model,
                stop_reason: this.toolCalls.length ? 'tool_use' : 'end_turn',
                content: this.toolCalls.map((c, i) => ({
                  type: 'tool_use',
                  id: `toolu_${i}`,
                  name: c.name,
                  input: c.args,
                })),
                usage: { input_tokens: 40, output_tokens: 12 },
              }
            : {
                choices: [
                  {
                    message: {
                      role: 'assistant',
                      content: null,
                      tool_calls: this.toolCalls.map((c, i) => ({
                        id: `call_${i}`,
                        type: 'function',
                        function: { name: c.name, arguments: JSON.stringify(c.args) },
                      })),
                    },
                  },
                ],
                usage: { prompt_tokens: 40, completion_tokens: 12 },
              },
        ),
      );
      return;
    }
    this.requests.push({ path, headers: req.headers, body });

    const anthropic = path.endsWith('/v1/messages');
    // The Claude SDK sends the key as a bearer token (1.x) or as x-api-key (older versions).
    const key = req.headers.authorization?.replace(/^Bearer /, '') ?? req.headers['x-api-key'];
    if (this.mode === 'unauthorized' || (this.apiKey !== null && key !== this.apiKey)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          anthropic
            ? {
                type: 'error',
                error: { type: 'authentication_error', message: 'invalid x-api-key' },
              }
            : { error: { message: 'Invalid API key' } },
        ),
      );
      return;
    }
    if (this.mode === 'rate_limit' || this.mode === 'quota') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            this.mode === 'quota'
              ? { message: 'You exceeded your current quota.', code: 'insufficient_quota' }
              : { message: 'Rate limit reached for requests.', code: 'rate_limit_exceeded' },
        }),
      );
      return;
    }
    if (path.endsWith('/embeddings')) {
      const inputs = body.input ?? [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: inputs.map((text, index) => ({ index, embedding: wordVector(text) })),
          usage: { prompt_tokens: inputs.join(' ').length / 4 },
        }),
      );
      return;
    }
    if (!path.endsWith('/v1/messages') && !path.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const text = this.responder
      ? this.responder({ path, headers: req.headers, body })
      : (this.replies.shift() ?? this.reply);
    const pieces = split(this.mode === 'refuse' ? '' : text);
    if (anthropic) this.anthropicStream(res, body, pieces);
    else this.openAiStream(res, pieces);
    res.end();
  }

  private openAiStream(res: ServerResponse, pieces: string[]) {
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    for (const p of pieces) send({ choices: [{ index: 0, delta: { content: p } }] });
    const finish =
      this.mode === 'length' ? 'length' : this.mode === 'refuse' ? 'content_filter' : 'stop';
    send({ choices: [{ index: 0, delta: {}, finish_reason: finish }] });
    if (this.mode !== 'no_usage') {
      send({
        choices: [],
        usage: {
          prompt_tokens: this.usage.input,
          completion_tokens: this.usage.output,
          prompt_tokens_details: { cached_tokens: this.usage.cached },
        },
      });
    }
    res.write('data: [DONE]\n\n');
  }

  private anthropicStream(res: ServerResponse, body: FakeRequest['body'], pieces: string[]) {
    const send = (event: string, o: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(o)}\n\n`);
    send('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: this.usage.input - this.usage.cached,
          cache_read_input_tokens: this.usage.cached,
          output_tokens: 1,
        },
      },
    });
    send('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    for (const p of pieces) {
      send('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: p },
      });
    }
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    const stop =
      this.mode === 'refuse' ? 'refusal' : this.mode === 'length' ? 'max_tokens' : 'end_turn';
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: this.usage.output },
    });
    send('message_stop', { type: 'message_stop' });
  }
}

/** The `model` field of a multipart form. */
function modelField(form: string): string | null {
  const at = form.indexOf('name="model"');
  if (at < 0) return null;
  const value = form.slice(at).split('\r\n\r\n')[1] ?? '';
  return value.split('\r\n')[0] ?? null;
}

function split(text: string) {
  if (!text) return [];
  const n = Math.ceil(text.length / 3);
  return [text.slice(0, n), text.slice(n, 2 * n), text.slice(2 * n)].filter(Boolean);
}

/** A deterministic bag-of-words embedding: texts sharing words point the same way. */
export function wordVector(text: string, dims = 32): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const w of text.toLocaleLowerCase('tr').split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 3) continue;
    const stem = w.slice(0, 4);
    let h = 0;
    for (const ch of stem) h = (h * 31 + ch.codePointAt(0)!) % 100_003;
    v[h % dims] = (v[h % dims] ?? 0) + 1;
  }
  return v;
}
