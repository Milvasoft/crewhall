import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type { Logger } from '../logger';

export interface MailMessage {
  /**
   * Whose delivery settings send it (services/delivery); null for mail before an org exists
   * (setup wizard), which always uses the server's SMTP.
   */
  orgId: string | null;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Display name for the From header (the org name); the address comes from MAIL_FROM. */
  fromName?: string;
  /** Calendar invitation (meet module): sent as text/calendar so mail clients show RSVP. */
  icalEvent?: { method: 'REQUEST' | 'CANCEL'; content: string; filename?: string };
}

export interface Mailer {
  /** The server's own SMTP (SMTP_URL) is configured. */
  readonly enabled: boolean;
  /**
   * This org can send mail (its own SMTP or Notifike, else the server's). False: invitations are
   * shared as links.
   */
  enabledFor(orgId: string | null): Promise<boolean>;
  send(message: MailMessage): Promise<void>;
  verify(): Promise<boolean>;
}

const DEFAULT_FROM = 'crewhall@localhost';

function fromAddress(mailFrom: string | undefined) {
  const raw = mailFrom ?? DEFAULT_FROM;
  const match = /<([^>]+)>/.exec(raw);
  return match?.[1] ?? raw;
}

/** `smtp` is SMTP_URL, or the options of an org's own server (services/delivery). */
export function createSmtpMailer(
  smtp: string | SMTPTransport.Options,
  mailFrom: string | undefined,
  logger: Logger,
): Mailer {
  const transport = nodemailer.createTransport(smtp);
  const address = fromAddress(mailFrom);
  return {
    enabled: true,
    enabledFor: async () => true,
    async send(message) {
      await transport.sendMail({
        from: message.fromName ? { name: message.fromName, address } : (mailFrom ?? address),
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        icalEvent: message.icalEvent,
      });
      logger.info({ to: message.to, subject: message.subject }, 'mail sent');
    },
    async verify() {
      try {
        await transport.verify();
        return true;
      } catch (err) {
        logger.warn({ err }, 'smtp verify failed');
        return false;
      }
    },
  };
}

export function createDisabledMailer(logger: Logger): Mailer {
  return {
    enabled: false,
    enabledFor: async () => false,
    async send(message) {
      logger.warn(
        { to: message.to, subject: message.subject },
        'SMTP not configured, mail dropped',
      );
    },
    async verify() {
      return false;
    },
  };
}

/** Collects messages in memory; used by tests. */
export function createMemoryMailer(): Mailer & { outbox: MailMessage[] } {
  const outbox: MailMessage[] = [];
  return {
    enabled: true,
    enabledFor: async () => true,
    outbox,
    async send(message) {
      outbox.push(message);
    },
    async verify() {
      return true;
    },
  };
}
