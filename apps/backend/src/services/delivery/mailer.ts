import type { Db } from '@crewhall/db';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';
import type { Logger } from '../../logger';
import { createSmtpMailer, type MailMessage, type Mailer } from '../../mail/mailer';
import {
  NOTIFIKE_CHANNEL,
  NOTIFIKE_PRIORITY,
  NotifikeError,
  notifikeSend,
  type NotifikeConfig,
} from './notifike';
import {
  loadDelivery,
  noteNotifikeRefusal,
  notifikeConfig,
  smtpConfig,
  type DeliveryRow,
  type SmtpConfig,
} from './settings';

/**
 * The mailer every service uses: sends each message the way its org chose (Yönetim › Bildirim
 * gönderimi): the server's SMTP (`base`), the org's own SMTP server, or Notifike. Org SMTP
 * transports are kept per org until the settings change.
 */
export function createDeliveryMailer(opts: {
  base: Mailer;
  db: Db;
  env: Env;
  logger: Logger;
}): Mailer {
  const { base, db, env, logger } = opts;
  const transports = new Map<string, { stamp: number; mailer: Mailer }>();

  function orgSmtp(row: DeliveryRow, cfg: SmtpConfig): Mailer {
    const stamp = row.updatedAt.getTime();
    const hit = transports.get(row.orgId);
    if (hit?.stamp === stamp) return hit.mailer;
    const mailer = createSmtpMailer(
      {
        host: cfg.host,
        port: cfg.port,
        secure: cfg.security === 'tls',
        requireTLS: cfg.security === 'starttls',
        ignoreTLS: cfg.security === 'none',
        ...(cfg.username ? { auth: { user: cfg.username, pass: cfg.password ?? '' } } : {}),
        connectionTimeout: 15_000,
      },
      cfg.from,
      logger,
    );
    transports.set(row.orgId, { stamp, mailer });
    return mailer;
  }

  async function viaNotifike(orgId: string, cfg: NotifikeConfig, message: MailMessage) {
    try {
      await notifikeSend(cfg, {
        channel: NOTIFIKE_CHANNEL.email,
        recipients: [{ to: message.to }],
        subject: message.subject,
        body: message.html,
        priority: NOTIFIKE_PRIORITY.normal,
        tags: ['crewhall'],
        ...(message.icalEvent
          ? {
              attachments: [
                {
                  fileName: message.icalEvent.filename ?? 'invite.ics',
                  contentType: `text/calendar; method=${message.icalEvent.method}; charset=utf-8`,
                  content: Buffer.from(message.icalEvent.content, 'utf8').toString('base64'),
                },
              ],
            }
          : {}),
      });
      logger.info({ to: message.to, subject: message.subject, orgId }, 'mail sent via notifike');
    } catch (err) {
      if (err instanceof NotifikeError) {
        await noteNotifikeRefusal({ db, logger }, orgId, err);
        throw new AppError(err.code, { status: err.status, key: err.key });
      }
      throw err;
    }
  }

  return {
    get enabled() {
      return base.enabled;
    },
    async enabledFor(orgId) {
      if (!orgId) return base.enabled;
      const row = await loadDelivery(db, orgId);
      switch (row?.emailMode ?? 'env') {
        case 'smtp':
          return !!smtpConfig(env, row);
        case 'notifike':
          return !!notifikeConfig(env, row);
        default:
          return base.enabled;
      }
    },
    async send(message) {
      if (!message.orgId) return base.send(message);
      const row = await loadDelivery(db, message.orgId);
      if (row?.emailMode === 'smtp') {
        const cfg = smtpConfig(env, row);
        if (!cfg) throw new AppError('delivery_not_configured', { channel: 'email' });
        return orgSmtp(row, cfg).send(message);
      }
      if (row?.emailMode === 'notifike') {
        const cfg = notifikeConfig(env, row);
        if (!cfg) throw new AppError('delivery_not_configured', { channel: 'email' });
        return viaNotifike(row.orgId, cfg, message);
      }
      return base.send(message);
    },
    verify: () => base.verify(),
  };
}
