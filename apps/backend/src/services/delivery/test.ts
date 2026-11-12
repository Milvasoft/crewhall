import { and, eq, isNull } from 'drizzle-orm';
import { newId, pushDevices, users } from '@crewhall/db';
import { resources, resolveLocale } from '@crewhall/i18n';
import type { DeliveryTestResult, TestDelivery } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { deliveryTestMail } from '../../mail/templates';
import { audit } from '../audit';
import { mailBrandForOrg } from '../brand';
import { FcmTransientError, sendFcm } from '../notifications/fcm';
import { expoPost, notifikePush } from '../notifications/push';
import {
  externalId,
  keyValues,
  NOTIFIKE_PRIORITY,
  NOTIFIKE_PUSH_KIND,
  NotifikeError,
} from './notifike';
import { loadDelivery, pushRoute, storeTestResult } from './settings';

type Failure = Pick<DeliveryTestResult, 'code' | 'message'>;

/** A provider failure as an error code and the provider's own words (never a secret). */
function failureOf(err: unknown): Failure {
  if (err instanceof NotifikeError) return { code: err.code, message: err.message };
  if (err instanceof FcmTransientError) {
    return { code: 'delivery_provider_error', message: err.message };
  }
  if (err instanceof AppError) {
    return {
      code: err.code.startsWith('delivery_') ? err.code : 'delivery_provider_error',
      message: null,
    };
  }
  const e = err as { responseCode?: number; code?: string; message?: string } | null;
  // nodemailer: 535 / EAUTH is a refused login.
  if (e?.responseCode === 535 || e?.code === 'EAUTH') {
    return { code: 'delivery_unauthorized', message: e.message ?? null };
  }
  if (e?.responseCode && e.responseCode >= 500 && e.responseCode < 600) {
    return { code: 'delivery_rejected', message: e.message ?? null };
  }
  return { code: 'delivery_provider_error', message: e?.message ?? null };
}

/**
 * "Test gönder": a test e-mail (to `to` or the caller) or a test push to the caller's own
 * devices, through the org's current settings. The result is stored and audited.
 */
export async function testDelivery(
  deps: Deps,
  a: { orgId: string; userId: string },
  input: TestDelivery,
  req?: Pick<RequestInfo, 'ip' | 'userAgent'>,
): Promise<DeliveryTestResult> {
  const { db } = deps;
  const row = await loadDelivery(db, a.orgId);
  const [user] = await db
    .select({ email: users.email, locale: users.locale })
    .from(users)
    .where(eq(users.id, a.userId));
  if (!user) throw new AppError('unauthenticated');
  const locale = resolveLocale(user.locale);
  const at = new Date().toISOString();
  let result: DeliveryTestResult;

  if (input.channel === 'email') {
    const mode = row?.emailMode ?? 'env';
    const base = { channel: 'email' as const, at, via: mode, recipients: 0 };
    const to = input.to ?? user.email;
    if (!(await deps.mailer.enabledFor(a.orgId))) {
      result = { ...base, ok: false, code: 'delivery_not_configured', message: null };
    } else {
      try {
        const brand = await mailBrandForOrg(db, deps.env.HUB_URL, a.orgId);
        await deps.mailer.send({
          orgId: a.orgId,
          to,
          fromName: brand.branding.orgName,
          ...deliveryTestMail(brand, locale, to),
        });
        result = { ...base, ok: true, recipients: 1, code: null, message: null };
      } catch (err) {
        deps.logger.warn({ err, orgId: a.orgId }, 'test e-mail failed');
        result = { ...base, ok: false, ...failureOf(err) };
      }
    }
  } else {
    const route = pushRoute(deps.env, row);
    const devices = await db
      .select()
      .from(pushDevices)
      .where(
        and(
          eq(pushDevices.orgId, a.orgId),
          eq(pushDevices.userId, a.userId),
          isNull(pushDevices.disabledAt),
        ),
      );
    const fcm = devices.filter((d) => d.provider === 'fcm');
    const base = { channel: 'push' as const, at, via: route.mode, recipients: 0 };
    if (!devices.length) {
      result = { ...base, ok: false, code: 'delivery_no_device', message: null };
    } else if (fcm.length && !route.notifike && !route.fcm.account) {
      result = { ...base, ok: false, code: 'delivery_not_configured', message: null };
    } else {
      const text = resources[locale].email.deliveryTest;
      const data = { url: deps.env.HUB_URL, notificationId: newId(), type: 'delivery.test' };
      try {
        let sent = 0;
        if (route.notifike && fcm.length) {
          const run = newId();
          sent += await notifikePush(
            deps,
            route.notifike,
            a.orgId,
            fcm,
            {
              pushKind: NOTIFIKE_PUSH_KIND.notification,
              priority: NOTIFIKE_PRIORITY.normal,
              subject: text.pushTitle,
              body: text.pushBody,
              data: keyValues(data),
            },
            { notificationId: null, key: (d) => externalId('test', run, d.id) },
          );
        } else {
          for (const d of fcm) {
            const r = await sendFcm(route.fcm, d.expoToken, {
              title: text.pushTitle,
              body: text.pushBody,
              data,
              urgent: false,
            });
            if (!r.ok) throw new AppError('delivery_rejected', { error: r.error });
            sent++;
          }
        }
        const expo = devices.filter((d) => d.provider === 'expo');
        if (expo.length) {
          const res = await expoPost(
            deps.env,
            route.expoToken,
            '/send',
            expo.map((d) => ({
              to: d.expoToken,
              title: text.pushTitle,
              body: text.pushBody,
              data,
            })),
          );
          const tickets = (res.data ?? []) as { status: string }[];
          sent += tickets.filter((t) => t.status === 'ok').length;
        }
        result = {
          ...base,
          ok: sent > 0,
          recipients: sent,
          code: sent ? null : 'delivery_rejected',
          message: null,
        };
      } catch (err) {
        deps.logger.warn({ err, orgId: a.orgId }, 'test push failed');
        result = { ...base, ok: false, ...failureOf(err) };
      }
    }
  }

  await storeTestResult(db, a.orgId, result);
  await audit(
    db,
    {
      orgId: a.orgId,
      actorId: a.userId,
      action: 'org.delivery.test',
      targetType: 'org',
      targetId: a.orgId,
      meta: { channel: result.channel, via: result.via, ok: result.ok, code: result.code },
    },
    req,
  );
  return result;
}
