import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, gte, inArray, lt, ne, or, sql } from 'drizzle-orm';
import {
  blobs,
  conversations,
  incomingWebhooks,
  nodes,
  nodeVersions,
  organizations,
  webhookDeliveries,
  type DbOrTx,
} from '@crewhall/db';
import type { AppLocale } from '@crewhall/i18n';
import {
  AlertCard,
  CHAT_LIMITS,
  GoogleChatPayload,
  guessAlertSeverity,
  HookPayload,
  type AlertSeverity,
  type IncomingWebhook,
  paths,
  WEBHOOK_PROVIDER_EVENTS,
  type WebhookProvider,
  withQuery,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { decryptApiKey, encryptApiKey } from '../ai/crypto';
import { deliverNotifications, notify } from '../notifications/notify';
import {
  membershipOf,
  requireMember,
  requirePermission,
  type ChatActor,
  type Membership,
} from './access';
import { appendSystem, publishMessage, writeMessage } from './messages';
import { chatEnabled } from './module';
import { eventOf, providerMessage, verifySignature, type HeaderOf } from './providers';
import { genericMessages, type HookMessage } from './webhook-generic';
import { usersById } from './views';

/**
 * Incoming webhooks (design 4.11-4.14, doc 17 §2): `POST /api/hooks/<id>?key=…`.
 * The key is part of the URL and stored only as its sha256. Limits: 60 requests a
 * minute (429 + Retry-After) and 32 KB bodies (413). Every request is logged.
 */

export type WebhookRow = typeof incomingWebhooks.$inferSelect;

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');
const newKey = () => randomBytes(24).toString('base64url');
/** Integrations: the signing secret pasted into the service, stored encrypted (org key). */
const newSecret = () => randomBytes(24).toString('hex');
const sealSecret = (deps: Pick<Deps, 'env'>, orgId: string, secret: string) =>
  encryptApiKey(deps.env.AUTH_SECRET, orgId, secret);
const openSecret = (deps: Pick<Deps, 'env'>, hook: WebhookRow) =>
  hook.secretEnc ? decryptApiKey(deps.env.AUTH_SECRET, hook.orgId, hook.secretEnc) : null;

function checkEvents(provider: WebhookProvider, events: string[]) {
  const known = WEBHOOK_PROVIDER_EVENTS[provider] as readonly string[];
  if (!events.length || events.some((e) => !known.includes(e))) {
    throw new AppError('bad_request', { field: 'events', reason: 'unknown_event' });
  }
}

const hookUrl = (apiUrl: string, id: string, key: string) =>
  `${apiUrl.replace(/\/$/, '')}/api/hooks/${id}?key=${key}`;
const maskedUrl = (apiUrl: string, id: string) =>
  `${apiUrl.replace(/\/$/, '')}/api/hooks/${id}?key=••••••••`;

async function healthOf(db: DbOrTx, rows: WebhookRow[]) {
  const ids = rows.map((r) => r.id);
  const stats = new Map<string, { day: number; limited: boolean; failing: boolean }>();
  if (ids.length === 0) return stats;
  const day = await db
    .select({
      webhookId: webhookDeliveries.webhookId,
      n: sql<number>`count(*)::int`,
      limited: sql<boolean>`bool_or(${webhookDeliveries.status} = 429 and ${webhookDeliveries.receivedAt} > now() - interval '1 hour')`,
    })
    .from(webhookDeliveries)
    .where(
      and(
        inArray(webhookDeliveries.webhookId, ids),
        gt(webhookDeliveries.receivedAt, sql`now() - interval '24 hours'`),
      ),
    )
    .groupBy(webhookDeliveries.webhookId);
  const latest = await db
    .selectDistinctOn([webhookDeliveries.webhookId], {
      webhookId: webhookDeliveries.webhookId,
      status: webhookDeliveries.status,
    })
    .from(webhookDeliveries)
    .where(and(inArray(webhookDeliveries.webhookId, ids), ne(webhookDeliveries.status, 429)))
    .orderBy(webhookDeliveries.webhookId, desc(webhookDeliveries.receivedAt));
  const last = new Map(latest.map((l) => [l.webhookId, l.status]));
  for (const id of ids) {
    const d = day.find((x) => x.webhookId === id);
    const status = last.get(id);
    stats.set(id, {
      day: d?.n ?? 0,
      limited: d?.limited ?? false,
      failing: status !== undefined && status >= 400 && status < 500,
    });
  }
  return stats;
}

async function toWebhooks(deps: Pick<Deps, 'db' | 'env'>, rows: WebhookRow[]) {
  const stats = await healthOf(deps.db, rows);
  const people = await usersById(
    deps.db,
    rows.map((r) => r.createdBy).filter((v): v is string => !!v),
  );
  const now = Date.now();
  return rows.map((r): IncomingWebhook => {
    const s = stats.get(r.id)!;
    const muted = !!r.mutedUntil && r.mutedUntil.getTime() > now;
    return {
      id: r.id,
      conversationId: r.conversationId,
      name: r.name,
      avatarUrl: null,
      maskedUrl: maskedUrl(deps.env.API_URL, r.id),
      rateLimit: r.rateLimit,
      health: r.disabledAt
        ? 'disabled'
        : muted
          ? 'muted'
          : s.limited
            ? 'limited'
            : s.failing
              ? 'failing'
              : 'active',
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      mutedUntil: muted ? r.mutedUntil!.toISOString() : null,
      disabledAt: r.disabledAt?.toISOString() ?? null,
      createdBy: r.createdBy ? (people.get(r.createdBy) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
      deliveries24h: s.day,
      provider: r.provider ?? null,
      events: r.events,
      textSeverity: r.textSeverity ?? null,
    };
  });
}

async function avatarBlob(db: DbOrTx, a: ChatActor, nodeId: string | null | undefined) {
  if (!nodeId) return null;
  const [row] = await db
    .select({ blobId: blobs.id, mime: blobs.mime })
    .from(nodes)
    .innerJoin(nodeVersions, eq(nodeVersions.id, nodes.currentVersionId))
    .innerJoin(blobs, eq(blobs.id, nodeVersions.blobId))
    .where(and(eq(nodes.id, nodeId), eq(nodes.orgId, a.org.id), eq(nodes.createdBy, a.userId)));
  if (!row || !(row.mime ?? '').startsWith('image/')) throw new AppError('invalid_target');
  return row.blobId;
}

async function requireWebhook(deps: Deps, a: ChatActor, webhookId: string) {
  const [hook] = await deps.db
    .select()
    .from(incomingWebhooks)
    .where(and(eq(incomingWebhooks.id, webhookId), eq(incomingWebhooks.orgId, a.org.id)));
  if (!hook) throw new AppError('not_found');
  const m = await requireMember(deps.db, a, hook.conversationId);
  requirePermission(a, m, 'manageWebhooks');
  return { hook, m };
}

export async function listWebhooks(deps: Deps, a: ChatActor, conversationId: string) {
  const m = await requireMember(deps.db, a, conversationId);
  requirePermission(a, m, 'manageWebhooks');
  const rows = await deps.db
    .select()
    .from(incomingWebhooks)
    .where(eq(incomingWebhooks.conversationId, conversationId))
    .orderBy(incomingWebhooks.createdAt);
  return toWebhooks(deps, rows);
}

export async function createWebhook(
  deps: Deps,
  a: ChatActor,
  conversationId: string,
  input: {
    name: string;
    avatarNodeId?: string | undefined;
    provider?: WebhookProvider | undefined;
    events?: string[] | undefined;
    textSeverity?: AlertSeverity | null | undefined;
  },
) {
  const { db } = deps;
  const m = await requireMember(db, a, conversationId);
  requirePermission(a, m, 'manageWebhooks');
  const provider = input.provider ?? null;
  const events = provider ? (input.events ?? [...WEBHOOK_PROVIDER_EVENTS[provider]]) : [];
  if (provider) checkEvents(provider, events);
  const secret = provider ? newSecret() : null;
  const key = newKey();
  const avatarBlobId = await avatarBlob(db, a, input.avatarNodeId);
  const { hook, line } = await db.transaction(async (tx) => {
    const [hook] = await tx
      .insert(incomingWebhooks)
      .values({
        orgId: a.org.id,
        conversationId,
        name: input.name,
        avatarBlobId,
        tokenHash: hashKey(key),
        provider,
        events,
        textSeverity: input.textSeverity ?? null,
        secretEnc: secret ? sealSecret(deps, a.org.id, secret) : null,
        rateLimit: CHAT_LIMITS.webhookPerMinute,
        createdBy: a.userId,
      })
      .returning();
    const line = await appendSystem(tx, m.conv, {
      type: 'webhook_added',
      actorId: a.userId,
      name: input.name,
    });
    return { hook: hook!, line };
  });
  await publishMessage(deps, m.conv, 'message.created', line);
  const [view] = await toWebhooks(deps, [hook]);
  return { webhook: view!, url: hookUrl(deps.env.API_URL, hook.id, key), secret };
}

export async function updateWebhook(
  deps: Deps,
  a: ChatActor,
  webhookId: string,
  input: {
    name?: string | undefined;
    avatarNodeId?: string | null | undefined;
    mutedUntil?: string | null | undefined;
    disabled?: boolean | undefined;
    events?: string[] | undefined;
    textSeverity?: AlertSeverity | null | undefined;
  },
) {
  const { hook } = await requireWebhook(deps, a, webhookId);
  const patch: Partial<typeof incomingWebhooks.$inferInsert> = {};
  if (input.events !== undefined) {
    if (!hook.provider) throw new AppError('bad_request', { field: 'events' });
    checkEvents(hook.provider, input.events);
    patch.events = input.events;
  }
  if (input.name !== undefined) patch.name = input.name;
  if (input.textSeverity !== undefined) patch.textSeverity = input.textSeverity;
  if (input.avatarNodeId !== undefined) {
    patch.avatarBlobId = await avatarBlob(deps.db, a, input.avatarNodeId);
  }
  if (input.mutedUntil !== undefined) {
    patch.mutedUntil = input.mutedUntil ? new Date(input.mutedUntil) : null;
  }
  if (input.disabled !== undefined) patch.disabledAt = input.disabled ? new Date() : null;
  const [row] = Object.keys(patch).length
    ? await deps.db
        .update(incomingWebhooks)
        .set(patch)
        .where(eq(incomingWebhooks.id, hook.id))
        .returning()
    : [hook];
  const [view] = await toWebhooks(deps, [row!]);
  return view!;
}

export async function deleteWebhook(deps: Deps, a: ChatActor, webhookId: string) {
  const { hook } = await requireWebhook(deps, a, webhookId);
  await deps.db.delete(incomingWebhooks).where(eq(incomingWebhooks.id, hook.id));
}

export async function regenerateWebhookKey(deps: Deps, a: ChatActor, webhookId: string) {
  const { hook } = await requireWebhook(deps, a, webhookId);
  const key = newKey();
  // An integration gets a new signing secret with the new URL.
  const secret = hook.provider ? newSecret() : null;
  const [row] = await deps.db
    .update(incomingWebhooks)
    .set({
      tokenHash: hashKey(key),
      ...(secret ? { secretEnc: sealSecret(deps, hook.orgId, secret) } : {}),
    })
    .where(eq(incomingWebhooks.id, hook.id))
    .returning();
  const [view] = await toWebhooks(deps, [row!]);
  return { webhook: view!, url: hookUrl(deps.env.API_URL, hook.id, key), secret };
}

export async function listDeliveries(
  deps: Deps,
  a: ChatActor,
  webhookId: string,
  q: { cursor?: string | undefined; limit: number },
) {
  const { hook } = await requireWebhook(deps, a, webhookId);
  let cursor: { t: string; id: string } | null = null;
  if (q.cursor) {
    try {
      cursor = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as {
        t: string;
        id: string;
      };
    } catch {
      throw new AppError('bad_request', { reason: 'invalid_cursor' });
    }
  }
  const rows = await deps.db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.webhookId, hook.id),
        gte(webhookDeliveries.receivedAt, sql`now() - interval '7 days'`),
        cursor
          ? or(
              lt(webhookDeliveries.receivedAt, new Date(cursor.t)),
              and(
                eq(webhookDeliveries.receivedAt, new Date(cursor.t)),
                lt(webhookDeliveries.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(webhookDeliveries.receivedAt), desc(webhookDeliveries.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      id: r.id,
      receivedAt: r.receivedAt.toISOString(),
      status: r.status,
      sizeBytes: r.sizeBytes,
      ip: r.ip,
      latencyMs: r.latencyMs,
      error: r.error,
      bodyExcerpt: r.bodyExcerpt,
      messageId: r.messageId,
    })),
    nextCursor:
      rows.length > q.limit && last
        ? Buffer.from(JSON.stringify({ t: last.receivedAt.toISOString(), id: last.id })).toString(
            'base64url',
          )
        : null,
  };
}

// ---- Receiving ------------------------------------------------------------------------

const stripTags = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Google Chat has no severity; read it from the emoji and words senders use (shared rule). */
export function guessSeverity(text: string): AlertCard['severity'] {
  return guessAlertSeverity(text);
}

/** First cardsV2 card → our card; unsupported widgets become text. */
export function fromGoogleCard(card: Record<string, unknown>, text?: string): AlertCard {
  const header = obj(card.header);
  const fields: { label: string; value: string }[] = [];
  const buttons: { text: string; url: string }[] = [];
  const paragraphs: string[] = [];
  for (const section of arr(card.sections)) {
    const s = obj(section);
    if (!s) continue;
    const sh = str(s.header);
    if (sh) paragraphs.push(stripTags(sh));
    for (const widget of arr(s.widgets)) {
      const w = obj(widget);
      if (!w) continue;
      const dt = obj(w.decoratedText) ?? obj(w.keyValue);
      if (dt) {
        const label = stripTags(str(dt.topLabel) ?? str(dt.bottomLabel) ?? '');
        const value = stripTags(str(dt.text) ?? str(dt.content) ?? '');
        if (label && value)
          fields.push({ label: label.slice(0, 100), value: value.slice(0, 1000) });
        else if (value || label) paragraphs.push(value || label);
        continue;
      }
      const tp = obj(w.textParagraph);
      if (tp && str(tp.text)) {
        paragraphs.push(stripTags(str(tp.text)!));
        continue;
      }
      for (const b of arr(obj(w.buttonList)?.buttons)) {
        const bo = obj(b);
        const url = str(obj(obj(bo?.onClick)?.openLink)?.url);
        const label = str(bo?.text);
        if (bo && url && label && /^https?:\/\//.test(url))
          buttons.push({ text: label.slice(0, 80), url });
      }
      const img = obj(w.image);
      if (img && str(img.imageUrl)) paragraphs.push(str(img.imageUrl)!);
    }
  }
  const title = stripTags(str(header?.title) ?? text?.split('\n')[0] ?? 'Webhook').slice(0, 300);
  const subtitle = str(header?.subtitle) ? stripTags(str(header?.subtitle)!).slice(0, 300) : null;
  const body = paragraphs.join('\n').slice(0, 4000) || null;
  const icon = str(header?.imageUrl);
  return {
    severity: guessSeverity([title, subtitle, body, text].filter(Boolean).join(' ')),
    title: title || 'Webhook',
    subtitle,
    source: null,
    iconUrl: icon && /^https?:\/\//.test(icon) ? icon : null,
    text: body,
    fields: fields.slice(0, 20),
    buttons: buttons.slice(0, 5),
  };
}

/** Crewhall body (text/card) or Google Chat (text/cardsV2) → what to write. */
export function normalizePayload(json: unknown): { text: string; card: AlertCard | null } | null {
  const o = obj(json);
  if (!o) return null;
  if ('cardsV2' in o || ('text' in o && !('card' in o))) {
    const g = GoogleChatPayload.safeParse(o);
    if (!g.success) return null;
    const first = g.data.cardsV2?.[0]?.card;
    const text = (g.data.text ?? '').replace(/<@?(all|here)>/gi, '').trim();
    if (!first && !text) return null;
    return { text, card: first ? fromGoogleCard(first, g.data.text) : null };
  }
  const p = HookPayload.safeParse(o);
  if (!p.success) return null;
  return {
    text: (p.data.text ?? '').replace(/<@?(all|here)>/gi, '').trim(),
    card: p.data.card ?? null,
  };
}

export interface HookRequest {
  webhookId: string;
  key: string;
  ip: string | null;
  body: string;
  /** Request headers (service signatures and event names). */
  header?: HeaderOf;
}

async function orgLocale(db: DbOrTx, orgId: string): Promise<AppLocale> {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return org?.settings.defaultLocale === 'en' ? 'en' : 'tr';
}

export interface HookResponse {
  status: number;
  body: Record<string, unknown>;
  retryAfter?: number;
}

const excerptOf = (body: string) => body.slice(0, 2000);

async function record(
  deps: Deps,
  hook: WebhookRow,
  started: number,
  req: HookRequest,
  status: number,
  error: string | null,
  messageId: string | null,
) {
  await deps.db.insert(webhookDeliveries).values({
    orgId: hook.orgId,
    webhookId: hook.id,
    status,
    sizeBytes: Buffer.byteLength(req.body),
    ip: req.ip,
    latencyMs: Math.round(performance.now() - started),
    error,
    // The key travels in the URL, never in the body: the excerpt is safe to keep.
    bodyExcerpt: status >= 400 ? excerptOf(req.body) : null,
    messageId,
  });
  if (status >= 400) await maybeNotifyFailing(deps, hook).catch(() => undefined);
}

/** "Requests are being rejected" to the creator, at most once a day (19 e-mails). */
async function maybeNotifyFailing(deps: Deps, hook: WebhookRow) {
  if (!hook.createdBy) return;
  if (hook.failingNotifiedAt && hook.failingNotifiedAt.getTime() > Date.now() - 86_400_000) return;
  const [n] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.webhookId, hook.id),
        gte(webhookDeliveries.status, 400),
        gt(webhookDeliveries.receivedAt, sql`now() - interval '1 hour'`),
      ),
    );
  if ((n?.n ?? 0) < 3) return;
  const claimed = await deps.db
    .update(incomingWebhooks)
    .set({ failingNotifiedAt: new Date() })
    .where(
      and(
        eq(incomingWebhooks.id, hook.id),
        or(
          sql`${incomingWebhooks.failingNotifiedAt} is null`,
          lt(incomingWebhooks.failingNotifiedAt, sql`now() - interval '1 day'`),
        ),
      ),
    )
    .returning({ id: incomingWebhooks.id });
  if (claimed.length === 0) return;
  await notify(deps, [
    {
      orgId: hook.orgId,
      userId: hook.createdBy,
      type: 'chat.webhook_failing',
      category: 'alert',
      actorId: null,
      target: { type: 'webhook', id: hook.id, conversationId: hook.conversationId },
      data: { name: hook.name },
      url: withQuery(paths.chatConversation(hook.conversationId), {
        panel: 'webhooks',
        hook: hook.id,
      }),
      groupKey: `webhook:${hook.id}:failing`,
    },
  ]);
}

export async function receiveHook(deps: Deps, req: HookRequest): Promise<HookResponse> {
  const started = performance.now();
  const { db } = deps;
  const [hook] = await db
    .select()
    .from(incomingWebhooks)
    .where(eq(incomingWebhooks.id, req.webhookId));
  if (!hook) return { status: 404, body: { code: 'not_found' } };
  // Chat turned off for the org: the endpoint table is blocked centrally, this route here.
  if (!(await chatEnabled(db, hook.orgId))) {
    return { status: 403, body: { code: 'module_disabled', module: 'chat' } };
  }
  const given = Buffer.from(hashKey(req.key), 'hex');
  const stored = Buffer.from(hook.tokenHash, 'hex');
  if (!req.key || given.length !== stored.length || !timingSafeEqual(given, stored)) {
    await record(deps, hook, started, { ...req, body: '' }, 401, 'webhook_key_invalid', null);
    return { status: 401, body: { code: 'webhook_key_invalid' } };
  }
  if (hook.disabledAt) {
    await record(deps, hook, started, req, 403, 'webhook_disabled', null);
    return { status: 403, body: { code: 'webhook_disabled' } };
  }
  const [window] = await db
    .select({
      n: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${webhookDeliveries.receivedAt})`,
    })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.webhookId, hook.id),
        ne(webhookDeliveries.status, 429),
        gt(webhookDeliveries.receivedAt, sql`now() - interval '60 seconds'`),
      ),
    );
  if ((window?.n ?? 0) >= hook.rateLimit) {
    const oldest = window?.oldest ? new Date(window.oldest).getTime() : Date.now();
    const retryAfter = Math.max(1, Math.ceil((oldest + 60_000 - Date.now()) / 1000));
    await record(deps, hook, started, { ...req, body: '' }, 429, 'rate_limited', null);
    return { status: 429, body: { code: 'rate_limited', retryAfter }, retryAfter };
  }
  if (Buffer.byteLength(req.body) > CHAT_LIMITS.webhookBodyBytes) {
    await record(
      deps,
      hook,
      started,
      { ...req, body: req.body.slice(0, 2000) },
      413,
      'webhook_payload_too_large',
      null,
    );
    return { status: 413, body: { code: 'webhook_payload_too_large' } };
  }
  const header: HeaderOf = req.header ?? (() => undefined);
  if (hook.provider) {
    const secret = openSecret(deps, hook);
    if (!secret || !verifySignature(hook.provider, secret, req.body, header)) {
      await record(
        deps,
        hook,
        started,
        { ...req, body: '' },
        401,
        'webhook_signature_invalid',
        null,
      );
      return { status: 401, body: { code: 'webhook_signature_invalid' } };
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(req.body);
  } catch {
    await record(deps, hook, started, req, 400, 'invalid_json', null);
    return { status: 400, body: { code: 'webhook_payload_invalid', reason: 'invalid_json' } };
  }
  let payloads: HookMessage[];
  if (hook.provider) {
    const event = eventOf(hook.provider, json, header);
    // Not chosen, or nothing the channel needs (a ping, a draft, a run still going): 202.
    const message = hook.events.includes(event)
      ? providerMessage(hook.provider, event, json, await orgLocale(db, hook.orgId))
      : null;
    if (!message) {
      await record(deps, hook, started, { ...req, body: '' }, 202, null, null);
      return { status: 200, body: { ignored: true, event } };
    }
    payloads = [message];
  } else {
    // A known body (Crewhall, Google Chat) as it is; anything else is read field by field.
    const known = normalizePayload(json);
    payloads = known ? [known] : genericMessages(json, await orgLocale(db, hook.orgId));
  }
  payloads = payloads.filter((p) => p.text || p.card);
  if (payloads.length === 0) {
    await record(deps, hook, started, req, 400, 'webhook_payload_invalid', null);
    return { status: 400, body: { code: 'webhook_payload_invalid' } };
  }
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, hook.conversationId));
  if (!conv || conv.archivedAt) {
    await record(deps, hook, started, req, 409, 'chat_archived', null);
    return { status: 409, body: { code: 'chat_archived' } };
  }
  const m: Membership = {
    ...(await membershipOf(db, conv, '00000000-0000-0000-0000-000000000000')),
    isMember: true,
  };
  const muted = !!hook.mutedUntil && hook.mutedUntil.getTime() > Date.now();
  // An array body becomes several messages, written in order.
  const results: Awaited<ReturnType<typeof writeMessage>>[] = [];
  try {
    for (const payload of payloads) {
      results.push(
        await db.transaction((tx) =>
          writeMessage(deps, tx, m, {
            authorId: null,
            webhookId: hook.id,
            kind: 'webhook',
            text: payload.text.slice(0, CHAT_LIMITS.messageChars),
            card: payload.card,
            // "Kartsız mesajın önemi": text without a card takes the webhook's severity.
            severity: hook.textSeverity ?? undefined,
            // "Sessize al" keeps the message but silences its notifications.
            silent: muted,
          }),
        ),
      );
    }
  } catch (err) {
    deps.logger.error({ err, webhookId: hook.id }, 'webhook message failed');
    await record(deps, hook, started, req, 500, 'internal', results[0]?.msg.id ?? null);
    return { status: 500, body: { code: 'internal' } };
  }
  await db
    .update(incomingWebhooks)
    .set({ lastUsedAt: new Date() })
    .where(eq(incomingWebhooks.id, hook.id));
  const first = results[0]!;
  await record(deps, hook, started, req, 200, null, first.msg.id);
  for (const result of results) {
    await publishMessage(deps, { ...conv, lastSeq: result.msg.seq }, 'message.created', result.msg);
    await deliverNotifications(deps, result.notes);
  }
  return {
    status: 200,
    body: { messageId: first.msg.id, seq: first.msg.seq, messages: results.length },
  };
}

/** Housekeeping: delivery rows 30 days (doc 17 §4). */
export async function purgeDeliveries(db: DbOrTx) {
  await db
    .delete(webhookDeliveries)
    .where(lt(webhookDeliveries.receivedAt, sql`now() - interval '30 days'`));
}
