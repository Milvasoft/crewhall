import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { notifications, pushDevices, pushTickets, users, type Db, type DbOrTx } from '@crewhall/db';
import { resources, type AppLocale } from '@crewhall/i18n';
import {
  CALL_RING_SECONDS,
  pushProviderOf,
  type CallEndReason,
  type PushData,
  toCurrentPath,
  type PushProvider,
} from '@crewhall/shared';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';
import type { Jobs } from '../../jobs/queue';
import type { Logger } from '../../logger';
import { fill } from '../../mail/templates';
import { chatEnabled } from '../chat/module';
import { stillRinging } from '../meet/calls';
import { voipRing } from '../meet/voip';
import {
  externalId,
  keyValues,
  NOTIFIKE_CHANNEL,
  NOTIFIKE_MAX_RECIPIENTS,
  NOTIFIKE_MAX_STATUS_IDS,
  NOTIFIKE_PRIORITY,
  NOTIFIKE_PUSH_KIND,
  NOTIFIKE_STATUS,
  NotifikeError,
  notifikeSend,
  notifikeStatuses,
  type NotifikeConfig,
  type NotifikeSendRequest,
} from '../delivery/notifike';
import { loadDelivery, noteNotifikeRefusal, pushRoute } from '../delivery/settings';
import {
  DATA_CALL_MIN_VERSION,
  FcmTransientError,
  pushSound,
  sendFcm,
  sendFcmData,
  versionAtLeast,
} from './fcm';
import {
  apnsConfig,
  ApnsTransientError,
  sendVoipTo,
  type ApnsConfig,
  type ApnsResult,
} from './apns';
import type { NotificationRow } from './notify';

/**
 * Push (doc 17 §10), sent by the push.send job when nobody has a focused session, through
 * the device's provider:
 * - Expo: one batch to Expo's push service; receipts 15 minutes later, DeviceNotRegistered
 *   disables the token.
 * - FCM: HTTP v1 per device (./fcm); UNREGISTERED / INVALID_ARGUMENT disable the token,
 *   429 / 5xx let pg-boss retry the job.
 * - VoIP (iOS PushKit): incoming calls only, straight to APNs (./apns); an iPhone that got the
 *   VoIP ring gets no ordinary push for it, so CallKit shows the call once.
 * The org picks the FCM account and Expo token, or Notifike for FCM tokens (Yönetim › Bildirim
 * gönderimi, services/delivery); Notifike has no Expo provider, so Expo tokens always go to Expo.
 */

export interface PushDeps {
  db: Db;
  logger: Logger;
  env: Env;
  jobs: Jobs;
}

export const RECEIPT_DELAY_SECONDS = 15 * 60;

export async function registerDevice(
  db: DbOrTx,
  orgId: string,
  userId: string,
  input: {
    expoToken: string;
    platform: 'ios' | 'android';
    appVersion?: string | undefined;
    provider?: PushProvider | undefined;
    apnsEnvironment?: 'sandbox' | 'production' | undefined;
  },
) {
  const provider = pushProviderOf(input.expoToken, input.provider);
  const apnsEnvironment = provider === 'voip' ? (input.apnsEnvironment ?? null) : null;
  // A token belongs to one device; signing in as someone else moves it.
  const [row] = await db
    .insert(pushDevices)
    .values({
      orgId,
      userId,
      expoToken: input.expoToken,
      provider,
      platform: input.platform,
      appVersion: input.appVersion ?? null,
      apnsEnvironment,
    })
    .onConflictDoUpdate({
      target: pushDevices.expoToken,
      set: {
        orgId,
        userId,
        provider,
        platform: input.platform,
        appVersion: input.appVersion ?? null,
        // A token belongs to one build: what the server found out stays unless the app says.
        apnsEnvironment: apnsEnvironment ?? sql`${pushDevices.apnsEnvironment}`,
        lastSeenAt: new Date(),
        disabledAt: null,
        disabledReason: null,
      },
    })
    .returning();
  return toDevice(row!);
}

export async function unregisterDevice(db: DbOrTx, userId: string, expoToken: string) {
  await db
    .delete(pushDevices)
    .where(and(eq(pushDevices.userId, userId), eq(pushDevices.expoToken, expoToken)));
}

/** "Bu cihazda bildirim alma": this device (the caller's own token) gets no push until then. */
export async function muteDevice(
  db: DbOrTx,
  userId: string,
  expoToken: string,
  mutedUntil: string | null,
) {
  const [row] = await db
    .update(pushDevices)
    .set({ mutedUntil: mutedUntil ? new Date(mutedUntil) : null })
    .where(and(eq(pushDevices.userId, userId), eq(pushDevices.expoToken, expoToken)))
    .returning();
  if (!row) throw new AppError('not_found');
  return toDevice(row);
}

/** Devices that may get a push now: not turned off, not muted. */
const reachable = () =>
  and(
    isNull(pushDevices.disabledAt),
    or(isNull(pushDevices.mutedUntil), lt(pushDevices.mutedUntil, sql`now()`)),
  );

export async function listDevices(db: DbOrTx, orgId: string, userId: string) {
  const rows = await db
    .select()
    .from(pushDevices)
    .where(and(eq(pushDevices.orgId, orgId), eq(pushDevices.userId, userId)));
  return rows.map(toDevice);
}

function toDevice(r: typeof pushDevices.$inferSelect) {
  return {
    id: r.id,
    platform: r.platform,
    appVersion: r.appVersion,
    lastSeenAt: r.lastSeenAt.toISOString(),
    disabledAt: r.disabledAt?.toISOString() ?? null,
    mutedUntil: r.mutedUntil?.toISOString() ?? null,
    provider: r.provider,
    apnsEnvironment: r.apnsEnvironment,
  };
}

/** Title and body in the recipient's language. */
export function pushText(row: NotificationRow, locale: AppLocale) {
  const t = resources[locale].email.chat.push;
  const d = row.payload;
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
  const values = {
    actor: s('authorName') || s('actorName'),
    conversation: s('conversationTitle') || s('authorName'),
    count: String(row.count),
    name: s('name'),
    title: s('title'),
  };
  const many = row.count > 1;
  let title: string;
  switch (row.type) {
    case 'chat.mention':
      title = fill(many ? t.mentionMany : t.mention, values);
      break;
    case 'chat.direct':
      title = fill(t.direct, values);
      break;
    case 'chat.reply':
      title = fill(t.reply, values);
      break;
    case 'chat.message':
      title = fill(many ? t.messageMany : t.message, values);
      break;
    case 'chat.alert':
      title = fill(t.alert, values);
      break;
    case 'chat.webhook_failing':
      title = fill(t.webhookFailing, values);
      break;
    case 'chat.reminder':
      title = fill(t.reminder, values);
      break;
    case 'chat.scheduled_failed':
      title = fill(t.scheduledFailed, values);
      break;
    case 'announcement.published':
      title = s('title') || t.fallback;
      break;
    case 'kudos.received':
      title = fill(t.kudos, values);
      break;
    case 'link.down':
      title = fill(t.linkDown, values);
      break;
    case 'link.up':
      title = fill(t.linkUp, values);
      break;
    case 'page.mention':
      title = fill(t.pageMention, values);
      break;
    case 'page.comment_mention':
      title = fill(t.pageCommentMention, values);
      break;
    case 'page.comment_reply':
      title = fill(many ? t.pageCommentReplyMany : t.pageCommentReply, values);
      break;
    case 'page.restored':
      title = fill(t.pageRestored, values);
      break;
    case 'page.updated':
      title = fill(t.pageUpdated, values);
      break;
    case 'page.export_ready':
      title = fill(t.pageExportReady, values);
      break;
    case 'meet.call':
      title = fill(
        d.invite === true ? t.meetRing : d.video === true ? t.callVideo : t.call,
        values,
      );
      break;
    case 'meet.ring_declined':
      title = fill(t.meetRingDeclined, values);
      break;
    case 'meet.ring_unanswered':
      title = fill(t.meetRingUnanswered, values);
      break;
    case 'meet.call_missed':
      title = fill(t.callMissed, values);
      break;
    case 'meet.updated':
      title = fill(t.meetUpdated, values);
      break;
    case 'meet.cancelled':
      title = fill(t.meetCancelled, values);
      break;
    case 'approval.requested':
      title = fill(t.approvalRequested, { client: s('client') });
      break;
    case 'chat.report':
      title = fill(d.kind === 'user' ? t.chatReportUser : t.chatReportMessage, values);
      break;
    case 'plugin.notification':
      // "WhatsApp · Ayşe": the plugin is the source, its title follows.
      title = [s('plugin'), s('title')].filter(Boolean).join(' · ') || t.fallback;
      break;
    default:
      title = s('title') || t.fallback;
  }
  const excerpt = s('excerpt');
  const body =
    row.type === 'chat.message' || row.type === 'chat.mention'
      ? [values.actor, excerpt].filter(Boolean).join(': ')
      : row.type.startsWith('meet.call')
        ? s('conversationTitle')
        : excerpt || s('body');
  return { title, body };
}

/**
 * The data-only ring of an incoming call (Android app DATA_CALL_MIN_VERSION and later): the app
 * shows its own full-screen call and stops ringing at `expiresAt` or on `meet.call_end`.
 */
export function callRingData(row: NotificationRow, callId: string, title: string, body: string) {
  const callerName = row.payload.actorName;
  return {
    type: 'meet.call',
    callId,
    notificationId: row.id,
    url: toCurrentPath(row.url),
    ...(row.conversationId ? { conversationId: row.conversationId } : {}),
    title,
    body,
    callerName: typeof callerName === 'string' ? callerName : '',
    video: row.payload.video === true ? 'true' : 'false',
    expiresAt: new Date(Date.now() + CALL_RING_SECONDS * 1000).toISOString(),
  };
}

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

type DeviceRow = typeof pushDevices.$inferSelect;

export async function expoPost(env: Env, token: string | null, path: string, body: unknown) {
  const res = await fetch(`${env.EXPO_PUSH_URL.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new AppError('internal', { expoStatus: res.status });
  return (await res.json()) as { data: unknown };
}

/** The org's push route (Yönetim › Bildirim gönderimi); 'env' when it never chose one. */
async function routeFor(deps: PushDeps, orgId: string) {
  return pushRoute(deps.env, await loadDelivery(deps.db, orgId));
}

/** Whether this device rings an incoming call from a data-only message. */
const ringsFromData = (d: DeviceRow) =>
  d.provider === 'fcm' &&
  d.platform === 'android' &&
  versionAtLeast(d.appVersion, DATA_CALL_MIN_VERSION);

/** What one device's provider answered (notifications.push_outcome, push diagnostics). */
type Outcome = NonNullable<NotificationRow['pushOutcome']>[number];

/**
 * A grouped push waits for its window. The person may have read that row meanwhile and a newer
 * message opened another: the job serves the conversation, so it sends the newest row.
 */
async function newestOfGroup(db: DbOrTx, row: NotificationRow) {
  if (!row.groupKey) return row;
  const [newest] = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, row.userId),
        eq(notifications.orgId, row.orgId),
        eq(notifications.groupKey, row.groupKey),
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(1);
  return newest ?? row;
}

export async function sendPush(deps: PushDeps, notificationId: string, repeat = false) {
  const { db, logger } = deps;
  const [first] = await db.select().from(notifications).where(eq(notifications.id, notificationId));
  const row = first && !repeat ? await newestOfGroup(db, first) : first;
  if (!row || !row.wantsPush || row.readAt) return;
  if (row.dismissedAt && row.pushedAt) return;
  if (repeat ? !row.pushedAt : row.pushedAt) return;
  if (row.type.startsWith('chat.') && !(await chatEnabled(db, row.orgId))) return;
  // H7: a call that stopped ringing for this person (answered elsewhere, ended) does not ring.
  const callId = row.type === 'meet.call' ? row.payload.callId : undefined;
  if (typeof callId === 'string' && !(await stillRinging(db, callId, row.userId))) return;
  let devices = await db
    .select()
    .from(pushDevices)
    .where(and(eq(pushDevices.userId, row.userId), eq(pushDevices.orgId, row.orgId), reachable()));
  // A held push (push_skip "attending") that goes now is no longer skipped.
  await db
    .update(notifications)
    .set({ pushedAt: new Date(), pushSkip: null })
    .where(eq(notifications.id, row.id));
  if (devices.length === 0) {
    await db
      .update(notifications)
      .set({ pushSkip: 'no_devices' })
      .where(eq(notifications.id, row.id));
    logger.info({ notificationId: row.id, userId: row.userId, type: row.type }, 'push: no devices');
    return;
  }
  // A retry of this job sends only to the devices that have not taken it yet.
  const outcome: Outcome[] = repeat ? [] : (row.pushOutcome ?? []).filter((o) => o.ok);
  const done = new Set(outcome.map((o) => o.deviceId));
  devices = devices.filter((d) => !done.has(d.id));
  const [user] = await db
    .select({ locale: users.locale })
    .from(users)
    .where(eq(users.id, row.userId));
  const { title, body } = pushText(row, user?.locale ?? 'tr');
  if (
    typeof callId === 'string' &&
    (await ringVoip(deps, row, callId, { title, body }, devices, outcome))
  ) {
    // CallKit rings these iPhones; an ordinary push would show the call a second time.
    devices = devices.filter((d) => d.platform !== 'ios');
  }
  const data: PushData = {
    url: toCurrentPath(row.url),
    notificationId: row.id,
    type: row.type,
    ...(typeof callId === 'string' ? { callId } : {}),
    // A plugin may clear what it sent with a thread key (plugins/notify.ts).
    ...(row.type === 'plugin.notification' && row.groupKey ? { tag: pushTag(row.groupKey) } : {}),
  };
  // An incoming call rings at high priority like a critical alert.
  const urgent = row.urgent || row.type === 'meet.call';
  const route = await routeFor(deps, row.orgId);
  const fcmDevices = devices.filter((x) => x.provider === 'fcm');
  const ring = (d: DeviceRow) => typeof callId === 'string' && ringsFromData(d);

  let retry: unknown = null;
  if (route.notifike && fcmDevices.length) {
    // Notifike sends to FCM tokens; a ringing call goes as a silent (data-only) push.
    const pass = repeat ? 'r' : 'p';
    const groups = [
      {
        devices: fcmDevices.filter(ring),
        request: {
          pushKind: NOTIFIKE_PUSH_KIND.silent,
          priority: NOTIFIKE_PRIORITY.high,
          data: keyValues(callRingData(row, String(callId), title, body)),
        },
      },
      {
        devices: fcmDevices.filter((d) => !ring(d)),
        request: {
          pushKind: NOTIFIKE_PUSH_KIND.notification,
          // As direct FCM: normal priority waits for Android's Doze to end, often for hours.
          priority: NOTIFIKE_PRIORITY.high,
          subject: title,
          body,
          data: keyValues(fcmData(data)),
        },
      },
    ];
    for (const g of groups) {
      if (!g.devices.length) continue;
      try {
        await notifikePush(deps, route.notifike, row.orgId, g.devices, g.request, {
          notificationId: row.id,
          key: (d) => externalId(row.id, pass, d.id),
        });
        for (const d of g.devices) outcome.push({ deviceId: d.id, provider: 'notifike', ok: true });
      } catch (err) {
        if (!(err instanceof NotifikeError) || !err.transient) throw err;
        logger.warn({ err, notificationId }, 'notifike push failed, will retry');
        for (const d of g.devices) {
          outcome.push({ deviceId: d.id, provider: 'notifike', ok: false, error: 'transient' });
        }
        retry = err;
      }
    }
  } else {
    // FCM devices one by one; a transient failure retries the whole job at the end.
    for (const d of fcmDevices) {
      try {
        const result = ring(d)
          ? await sendFcmData(
              route.fcm,
              d.expoToken,
              callRingData(row, String(callId), title, body),
              CALL_RING_SECONDS,
            )
          : await sendFcm(route.fcm, d.expoToken, { title, body, data, urgent });
        if (result.ok) {
          outcome.push({ deviceId: d.id, provider: 'fcm', ok: true });
        } else {
          outcome.push({ deviceId: d.id, provider: 'fcm', ok: false, error: result.error });
          if (result.disable) {
            await disableDevice(db, d.id, result.error);
          } else {
            logger.warn(
              { error: result.error, detail: result.detail, notificationId },
              'fcm rejected a push',
            );
          }
        }
      } catch (err) {
        if (!(err instanceof FcmTransientError)) throw err;
        logger.warn({ err, notificationId }, 'fcm push failed, will retry');
        outcome.push({ deviceId: d.id, provider: 'fcm', ok: false, error: err.message });
        retry = err;
      }
    }
  }
  // Notifike has no Expo provider: Expo tokens always go to Expo.
  const expoDevices = devices.filter((x) => x.provider === 'expo');
  if (expoDevices.length) {
    try {
      await sendExpo(
        deps,
        route.expoToken,
        { ...row, urgent },
        expoDevices,
        title,
        body,
        data,
        outcome,
      );
    } catch (err) {
      for (const d of expoDevices) {
        outcome.push({ deviceId: d.id, provider: 'expo', ok: false, error: 'transient' });
      }
      retry = err;
    }
  }
  await db.update(notifications).set({ pushOutcome: outcome }).where(eq(notifications.id, row.id));
  // One line per push for the server log: which provider took it, which did not.
  logger.info(
    {
      notificationId: row.id,
      userId: row.userId,
      type: row.type,
      urgent,
      repeat,
      route: route.notifike ? 'notifike' : 'direct',
      ok: outcome.filter((o) => o.ok).length,
      failed: outcome.filter((o) => !o.ok).map((o) => `${o.provider}:${o.error ?? '?'}`),
    },
    'push sent',
  );
  if (retry) {
    await db.update(notifications).set({ pushedAt: null }).where(eq(notifications.id, row.id));
    throw retry;
  }
}

/**
 * The VoIP ring to the person's iPhones (CallKit); true when at least one took it. Not retried:
 * a second ring would report the call to CallKit twice; the ordinary push is the fallback.
 */
async function ringVoip(
  deps: PushDeps,
  row: NotificationRow,
  callId: string,
  text: { title: string; body: string },
  devices: DeviceRow[],
  outcome: Outcome[],
) {
  const voip = devices.filter((d) => d.provider === 'voip');
  if (!voip.length) return false;
  const cfg = apnsConfig(deps.env);
  if (!cfg) return false;
  const expiresAt = new Date(Date.now() + CALL_RING_SECONDS * 1000);
  const payload = voipRing(deps.env, row, callId, text, expiresAt);
  let rang = false;
  for (const d of voip) {
    const result = await voipTo(deps.db, cfg, d, payload, expiresAt).catch((err: unknown) => {
      if (!(err instanceof ApnsTransientError)) throw err;
      deps.logger.warn({ err, notificationId: row.id }, 'voip push failed');
      return null;
    });
    outcome.push({
      deviceId: d.id,
      provider: 'voip',
      ok: result?.ok === true,
      ...(result && !result.ok ? { error: result.reason } : !result ? { error: 'transient' } : {}),
    });
    if (!result) continue;
    if (result.ok) rang = true;
    else if (!result.disable) {
      deps.logger.warn({ reason: result.reason, notificationId: row.id }, 'apns rejected a push');
    }
  }
  return rang;
}

/**
 * One VoIP push to a device row: its own APNs environment, or APNS_ENV and then the other one.
 * The environment that worked is kept on the device; a token both refuse is turned off.
 */
async function voipTo(
  db: DbOrTx,
  cfg: ApnsConfig,
  d: DeviceRow,
  payload: Parameters<typeof sendVoipTo>[2],
  expiresAt: Date,
): Promise<ApnsResult> {
  const { result, environment } = await sendVoipTo(
    cfg,
    { token: d.expoToken, apnsEnvironment: d.apnsEnvironment },
    payload,
    expiresAt,
  );
  if (result.ok && d.apnsEnvironment !== environment) {
    await db
      .update(pushDevices)
      .set({ apnsEnvironment: environment })
      .where(eq(pushDevices.id, d.id));
  } else if (!result.ok && result.disable) {
    await disableDevice(db, d.id, result.reason);
  }
  return result;
}

const disableDevice = (db: DbOrTx, id: string, reason: string) =>
  db
    .update(pushDevices)
    .set({ disabledAt: new Date(), disabledReason: reason })
    .where(eq(pushDevices.id, id));

/** FCM data values are strings. */
const fcmData = (data: PushData): Record<string, string> => ({
  url: data.url,
  notificationId: data.notificationId,
  type: data.type,
  ...(data.callId ? { callId: data.callId } : {}),
  ...(data.tag ? { tag: data.tag } : {}),
});

/**
 * One Notifike push send to FCM devices; each accepted message becomes a ticket whose status
 * the push.receipts job reads later. `key` makes retries idempotent (recipient externalId).
 * A refused key is remembered on the settings page; transient errors are rethrown.
 */
export async function notifikePush(
  deps: PushDeps,
  cfg: NotifikeConfig,
  orgId: string,
  devices: DeviceRow[],
  request: Omit<NotifikeSendRequest, 'channel' | 'recipients'>,
  opts: { notificationId: string | null; key: (d: DeviceRow) => string },
) {
  const { db } = deps;
  const byToken = new Map(devices.map((d) => [d.expoToken, d]));
  const stored: (typeof pushTickets.$inferInsert)[] = [];
  for (let i = 0; i < devices.length; i += NOTIFIKE_MAX_RECIPIENTS) {
    let accepted;
    try {
      accepted = await notifikeSend(cfg, {
        channel: NOTIFIKE_CHANNEL.push,
        recipients: devices
          .slice(i, i + NOTIFIKE_MAX_RECIPIENTS)
          .map((d) => ({ to: d.expoToken, externalId: opts.key(d) })),
        ...request,
      });
    } catch (err) {
      if (err instanceof NotifikeError) await noteNotifikeRefusal(deps, orgId, err);
      throw err;
    }
    for (const a of accepted) {
      const device = byToken.get(a.to);
      if (!device || a.isDuplicate) continue;
      stored.push({
        orgId,
        deviceId: device.id,
        ticketId: a.messageId,
        provider: 'notifike',
        notificationId: opts.notificationId,
      });
    }
  }
  if (stored.length) {
    await db.insert(pushTickets).values(stored);
    await scheduleReceipts(deps);
  }
  return stored.length;
}

async function scheduleReceipts(deps: PushDeps) {
  await deps.jobs.send(
    'push.receipts',
    { olderThanSeconds: RECEIPT_DELAY_SECONDS },
    {
      startAfterSeconds: RECEIPT_DELAY_SECONDS,
      singletonKey: 'push.receipts',
      singletonSeconds: 60,
    },
  );
}

const expoStatusOf = (err: AppError) => {
  const d = err.details as { expoStatus?: unknown } | undefined;
  return typeof d?.expoStatus === 'number' ? d.expoStatus : null;
};

async function sendExpo(
  deps: PushDeps,
  token: string | null,
  row: NotificationRow,
  devices: DeviceRow[],
  title: string,
  body: string,
  data: PushData,
  outcome: Outcome[],
) {
  const { db, logger } = deps;
  const notificationId = row.id;
  const messages = devices.map((d) => ({
    to: d.expoToken,
    title,
    body,
    sound: pushSound(row.type, row.urgent).sound,
    // 'default' is normal priority on Android: it waits for Doze to end.
    priority: 'high',
    channelId: pushSound(row.type, row.urgent).channel,
    ...(row.urgent ? { interruptionLevel: 'time-sensitive' } : {}),
    data,
  }));
  let tickets: ExpoTicket[];
  try {
    tickets = ((await expoPost(deps.env, token, '/send', messages)).data as ExpoTicket[]) ?? [];
  } catch (err) {
    logger.warn({ err, notificationId }, 'expo push failed');
    // Expo refused the request itself (403: enhanced push security without EXPO_ACCESS_TOKEN):
    // retrying cannot help, and it must not resend to the person's other devices.
    const status = err instanceof AppError ? expoStatusOf(err) : null;
    if (status !== null && status >= 400 && status < 500 && status !== 429) {
      for (const d of devices) {
        outcome.push({ deviceId: d.id, provider: 'expo', ok: false, error: `http_${status}` });
      }
      return;
    }
    // Let pg-boss retry: pushed_at goes back so the retry sends.
    await db.update(notifications).set({ pushedAt: null }).where(eq(notifications.id, row.id));
    throw err;
  }
  const stored: (typeof pushTickets.$inferInsert)[] = [];
  for (const [i, t] of tickets.entries()) {
    const device = devices[i];
    if (!device) continue;
    outcome.push({
      deviceId: device.id,
      provider: 'expo',
      ok: t.status === 'ok',
      ...(t.status === 'ok' ? {} : { error: t.details?.error ?? t.message ?? 'error' }),
    });
    if (t.status === 'ok' && t.id) {
      stored.push({
        orgId: row.orgId,
        deviceId: device.id,
        ticketId: t.id,
        notificationId: row.id,
      });
    } else if (t.details?.error === 'DeviceNotRegistered') {
      await disableDevice(db, device.id, 'DeviceNotRegistered');
    } else {
      logger.warn({ ticket: t, notificationId }, 'expo rejected a push');
    }
  }
  if (stored.length) {
    await db.insert(pushTickets).values(stored);
    await scheduleReceipts(deps);
  }
}

/**
 * Receipts of tickets older than the delay. Expo: DeviceNotRegistered disables the device.
 * Notifike: a failed message keeps its error (Notifike reports dead tokens only through its
 * webhook, so devices stay enabled).
 */
export async function checkReceipts(deps: PushDeps, olderThanSeconds = RECEIPT_DELAY_SECONDS) {
  const { db } = deps;
  for (;;) {
    const batch = await db
      .select()
      .from(pushTickets)
      .where(
        and(
          isNull(pushTickets.checkedAt),
          lt(pushTickets.createdAt, sql`now() - make_interval(secs => ${olderThanSeconds})`),
        ),
      )
      .limit(1000);
    if (batch.length === 0) return;
    const errors = new Map<string, string | null>();
    const dead: string[] = [];
    for (const [orgId, tickets] of groupBy(
      batch.filter((b) => b.provider === 'expo'),
      (b) => b.orgId,
    )) {
      const route = await routeFor(deps, orgId);
      const res = await expoPost(deps.env, route.expoToken, '/getReceipts', {
        ids: tickets.map((b) => b.ticketId),
      });
      const receipts = (res.data ?? {}) as Record<string, ExpoTicket>;
      for (const t of tickets) {
        const r = receipts[t.ticketId];
        if (r?.status === 'error' && r.details?.error === 'DeviceNotRegistered') {
          dead.push(t.deviceId);
        }
        errors.set(t.id, r?.status === 'error' ? (r.details?.error ?? r.message ?? 'error') : null);
      }
    }
    for (const [orgId, tickets] of groupBy(
      batch.filter((b) => b.provider === 'notifike'),
      (b) => b.orgId,
    )) {
      const cfg = (await routeFor(deps, orgId)).notifike;
      for (let i = 0; i < tickets.length; i += NOTIFIKE_MAX_STATUS_IDS) {
        const chunk = tickets.slice(i, i + NOTIFIKE_MAX_STATUS_IDS);
        if (!cfg) {
          for (const t of chunk) errors.set(t.id, 'notifike_not_configured');
          continue;
        }
        const statuses = await notifikeStatuses(
          cfg,
          chunk.map((t) => t.ticketId),
        ).catch(async (err: unknown) => {
          if (err instanceof NotifikeError) await noteNotifikeRefusal(deps, orgId, err);
          throw err;
        });
        const byId = new Map(statuses.map((s) => [s.messageId, s]));
        for (const t of chunk) {
          const s = byId.get(t.ticketId);
          errors.set(t.id, s?.status === NOTIFIKE_STATUS.failed ? (s.lastError ?? 'failed') : null);
        }
      }
    }
    for (const t of batch) {
      await db
        .update(pushTickets)
        .set({ checkedAt: new Date(), error: errors.get(t.id) ?? null })
        .where(eq(pushTickets.id, t.id));
    }
    if (dead.length) {
      await db
        .update(pushDevices)
        .set({ disabledAt: new Date(), disabledReason: 'DeviceNotRegistered' })
        .where(inArray(pushDevices.id, dead));
    }
    if (batch.length < 1000) return;
  }
}

export async function purgePushTickets(db: DbOrTx) {
  await db.delete(pushTickets).where(lt(pushTickets.createdAt, sql`now() - interval '2 days'`));
}

/** The tray tag of a collapse key: short enough for `apns-collapse-id` (64 bytes). */
export const pushTag = (groupKey: string) =>
  createHash('sha256').update(groupKey).digest('hex').slice(0, 32);

/**
 * First app version that handles `notification.clear`. Older ones must not get it: their FCM
 * service passes an unknown data message on to expo-notifications.
 */
export const PUSH_CLEAR_MIN_VERSION = '0.3.0';
const PUSH_CLEAR_TTL_SECONDS = 24 * 60 * 60;

/**
 * Job: remove a delivered push from the person's phones (a plugin's notification, read there).
 * Best effort: Android cancels by tag when the push was sent directly through FCM (Notifike has
 * no tag field); iOS may hold a background push back; Expo tokens get nothing.
 */
export async function pushClear(
  deps: PushDeps,
  input: { orgId: string; userId: string; tag: string },
) {
  const { db, logger } = deps;
  const devices = await db
    .select()
    .from(pushDevices)
    .where(
      and(
        eq(pushDevices.orgId, input.orgId),
        eq(pushDevices.userId, input.userId),
        eq(pushDevices.provider, 'fcm'),
        reachable(),
      ),
    );
  const able = devices.filter((d) => versionAtLeast(d.appVersion, PUSH_CLEAR_MIN_VERSION));
  if (!able.length) return;
  const data = { type: 'notification.clear', tag: input.tag };
  const route = await routeFor(deps, input.orgId);
  if (route.notifike) {
    await notifikePush(
      deps,
      route.notifike,
      input.orgId,
      able,
      {
        pushKind: NOTIFIKE_PUSH_KIND.silent,
        priority: NOTIFIKE_PRIORITY.normal,
        data: keyValues(data),
      },
      { notificationId: null, key: (d) => externalId(input.tag, `clear${Date.now()}`, d.id) },
    ).catch((err: unknown) => {
      logger.warn({ err }, 'push clear failed');
    });
    return;
  }
  for (const d of able) {
    const result = await sendFcmData(route.fcm, d.expoToken, data, PUSH_CLEAR_TTL_SECONDS).catch(
      (err: unknown) => {
        logger.warn({ err }, 'push clear failed');
        return null;
      },
    );
    if (result && !result.ok && result.disable) {
      await db.update(pushDevices).set({ disabledAt: new Date() }).where(eq(pushDevices.id, d.id));
    }
  }
}

/**
 * Job: phones of `userIds` stop ringing for a call (answered here or on another device, declined,
 * cancelled, missed). Only Android apps that ring from data-only messages get it; the others
 * show a system notification that the missed-call notification replaces.
 */
export async function pushCallEnd(
  deps: PushDeps,
  input: { orgId: string; callId: string; userIds: string[]; reason?: CallEndReason | undefined },
) {
  const { db, logger } = deps;
  if (!input.userIds.length) return;
  await voipCallEnd(deps, input);
  const devices = await db
    .select()
    .from(pushDevices)
    .where(
      and(
        eq(pushDevices.orgId, input.orgId),
        inArray(pushDevices.userId, input.userIds),
        eq(pushDevices.provider, 'fcm'),
        eq(pushDevices.platform, 'android'),
        reachable(),
      ),
    );
  const ringing = devices.filter(ringsFromData);
  if (!ringing.length) return;
  const rings = await db
    .select({ id: notifications.id, userId: notifications.userId })
    .from(notifications)
    .where(
      and(
        eq(notifications.orgId, input.orgId),
        eq(notifications.type, 'meet.call'),
        inArray(notifications.userId, input.userIds),
        sql`${notifications.payload}->>'callId' = ${input.callId}`,
      ),
    );
  const ringOf = new Map(rings.map((r) => [r.userId, r.id]));
  const dataFor = (d: DeviceRow) => {
    const notificationId = ringOf.get(d.userId);
    return {
      type: 'meet.call_end',
      callId: input.callId,
      ...(notificationId ? { notificationId } : {}),
    };
  };
  const route = await routeFor(deps, input.orgId);
  if (route.notifike) {
    // Same silent message for everyone but the notification id: one send per person.
    for (const [userId, mine] of groupBy(ringing, (d) => d.userId)) {
      await notifikePush(
        deps,
        route.notifike,
        input.orgId,
        mine,
        {
          pushKind: NOTIFIKE_PUSH_KIND.silent,
          priority: NOTIFIKE_PRIORITY.high,
          data: keyValues(dataFor(mine[0]!)),
        },
        {
          notificationId: ringOf.get(userId) ?? null,
          key: (d) => externalId(input.callId, 'end', d.id),
        },
      ).catch((err: unknown) => {
        // Best effort: a phone that misses it stops at the ring's own expiresAt.
        logger.warn({ err, callId: input.callId }, 'call end push failed');
      });
    }
    return;
  }
  for (const d of ringing) {
    // Best effort: a phone that misses it stops at the ring's own expiresAt.
    const result = await sendFcmData(route.fcm, d.expoToken, dataFor(d), CALL_RING_SECONDS).catch(
      (err: unknown) => {
        logger.warn({ err, callId: input.callId }, 'call end push failed');
        return null;
      },
    );
    if (result && !result.ok && result.disable) {
      await disableDevice(db, d.id, result.error);
    }
  }
}

/**
 * CallKit ends the call on the iPhones that were rung through VoIP (Apple: every VoIP push is
 * reported to CallKit, so only those that rang get it). Best effort, like the Android end.
 */
async function voipCallEnd(
  deps: PushDeps,
  input: { orgId: string; callId: string; userIds: string[]; reason?: CallEndReason | undefined },
) {
  const cfg = apnsConfig(deps.env);
  if (!cfg) return;
  const { db, logger } = deps;
  const rung = await db
    .select({ id: notifications.id, userId: notifications.userId })
    .from(notifications)
    .where(
      and(
        eq(notifications.orgId, input.orgId),
        eq(notifications.type, 'meet.call'),
        inArray(notifications.userId, input.userIds),
        isNotNull(notifications.pushedAt),
        sql`${notifications.payload}->>'callId' = ${input.callId}`,
      ),
    );
  if (!rung.length) return;
  const devices = await db
    .select()
    .from(pushDevices)
    .where(
      and(
        eq(pushDevices.orgId, input.orgId),
        inArray(
          pushDevices.userId,
          rung.map((r) => r.userId),
        ),
        eq(pushDevices.provider, 'voip'),
        reachable(),
      ),
    );
  const ringOf = new Map(rung.map((r) => [r.userId, r.id]));
  const expiresAt = new Date(Date.now() + 60_000);
  for (const d of devices) {
    await voipTo(
      db,
      cfg,
      d,
      {
        type: 'meet.call_end',
        callId: input.callId,
        notificationId: ringOf.get(d.userId) ?? null,
        ...(input.reason ? { reason: input.reason } : {}),
      },
      expiresAt,
    ).catch((err: unknown) => {
      logger.warn({ err, callId: input.callId }, 'voip call end push failed');
      return null;
    });
  }
}

function groupBy<T>(rows: T[], key: (r: T) => string) {
  const out = new Map<string, T[]>();
  for (const r of rows) out.set(key(r), [...(out.get(key(r)) ?? []), r]);
  return out;
}
