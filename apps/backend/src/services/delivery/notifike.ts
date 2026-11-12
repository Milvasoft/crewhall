/**
 * Notifike integration API (notifike docs/mimari.md §5.1, api-sozlesmesi.md §12), the same calls
 * as its .NET client (Notifike.Contracts NotifikeClient): JSON in camelCase, enums as numbers,
 * the application's key in `X-Api-Key`, answers in Milvasoft's `{ isSuccess, messages, data }`.
 * Retries are made safe by the recipient `externalId` (a repeated id returns the stored message),
 * since the integration send has no Idempotency-Key.
 */

export const NOTIFIKE_CHANNEL = { email: 1, push: 3 } as const;
export const NOTIFIKE_PUSH_KIND = { notification: 1, silent: 2 } as const;
export const NOTIFIKE_PRIORITY = { low: 1, normal: 5, high: 9 } as const;
/** MessageStatus (mimari.md §4.1). */
export const NOTIFIKE_STATUS = {
  scheduled: 1,
  queued: 2,
  processing: 3,
  sent: 4,
  delivered: 5,
  failed: 6,
  cancelled: 7,
  suppressed: 8,
} as const;

/** At most this many recipients per send, this many ids per status call. */
export const NOTIFIKE_MAX_RECIPIENTS = 1000;
export const NOTIFIKE_MAX_STATUS_IDS = 100;
/** Recipient externalId length (Message.ExternalIdMaxLength). */
export const NOTIFIKE_EXTERNAL_ID_CHARS = 100;

export interface NotifikeConfig {
  baseUrl: string;
  apiKey: string;
}

export interface KeyValue {
  key: string;
  value: string;
}

export interface NotifikeRecipient {
  to: string;
  name?: string;
  language?: string;
  externalId?: string;
  data?: KeyValue[];
}

export interface NotifikeSendRequest {
  channel: (typeof NOTIFIKE_CHANNEL)[keyof typeof NOTIFIKE_CHANNEL];
  recipients: NotifikeRecipient[];
  templateKey?: string;
  subject?: string;
  body?: string;
  data?: KeyValue[];
  pushKind?: (typeof NOTIFIKE_PUSH_KIND)[keyof typeof NOTIFIKE_PUSH_KIND];
  priority: (typeof NOTIFIKE_PRIORITY)[keyof typeof NOTIFIKE_PRIORITY];
  language?: string;
  tags?: string[];
  /** E-mail only; `content` is base64. */
  attachments?: { fileName: string; contentType?: string; content: string }[];
}

export interface NotifikeAccepted {
  messageId: string;
  to: string;
  externalId: string | null;
  status: number;
  isDuplicate?: boolean;
}

export interface NotifikeStatus {
  messageId: string;
  status: number;
  to: string;
  lastError: string | null;
}

/**
 * Notifike refused or could not be reached. `code` is ours (`errors.<code>`); `transient` says
 * whether a later retry may succeed (rate limit, 5xx, network, a key that was just rotated).
 */
export class NotifikeError extends Error {
  override name = 'NotifikeError';
  constructor(
    readonly status: number | null,
    readonly code:
      | 'delivery_unauthorized'
      | 'delivery_rate_limited'
      | 'delivery_rejected'
      | 'delivery_provider_error',
    /** Notifike's message key (InvalidApiKey, DailyLimitExceeded, ...). */
    readonly key: string | null,
    message: string,
  ) {
    super(message);
  }

  get transient() {
    return this.code !== 'delivery_rejected';
  }

  get unauthorized() {
    return this.code === 'delivery_unauthorized';
  }
}

interface Envelope<T> {
  isSuccess?: boolean;
  statusCode?: number;
  messages?: { key?: string | null; message?: string | null }[] | null;
  data?: T;
}

function errorFor(status: number | null, key: string | null, message: string | null) {
  const text = message ?? (status ? `Notifike answered HTTP ${status}` : 'Notifike unreachable');
  if (status === 401 || status === 403) {
    return new NotifikeError(status, 'delivery_unauthorized', key, text);
  }
  if (status === 429) return new NotifikeError(status, 'delivery_rate_limited', key, text);
  if (status !== null && status >= 400 && status < 500) {
    return new NotifikeError(status, 'delivery_rejected', key, text);
  }
  return new NotifikeError(status, 'delivery_provider_error', key, text);
}

async function call<T>(
  cfg: NotifikeConfig,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/api/v1.0/${path}`, {
      method,
      headers: {
        'X-Api-Key': cfg.apiKey,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw errorFor(null, null, null);
  }
  const envelope = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (res.ok && envelope?.isSuccess === true) return envelope.data as T;
  const first = envelope?.messages?.[0];
  // A refusal inside a 200 carries its own statusCode; a 200 without an envelope (a proxy page)
  // counts as unreachable.
  const status = res.ok ? (envelope?.statusCode ?? null) : res.status;
  throw errorFor(status, first?.key ?? null, first?.message ?? null);
}

export function notifikeSend(cfg: NotifikeConfig, request: NotifikeSendRequest) {
  return call<NotifikeAccepted[]>(cfg, 'POST', 'notifications/send', request);
}

export function notifikeStatuses(cfg: NotifikeConfig, messageIds: string[]) {
  return call<NotifikeStatus[]>(cfg, 'PATCH', 'notifications/statuses', { messageIds });
}

/** `{ a: '1' }` → `[{ key: 'a', value: '1' }]`. */
export const keyValues = (data: Record<string, string>): KeyValue[] =>
  Object.entries(data).map(([key, value]) => ({ key, value }));

/** Fits an externalId into Notifike's limit. */
export const externalId = (...parts: string[]) =>
  parts.join(':').slice(0, NOTIFIKE_EXTERNAL_ID_CHARS);
