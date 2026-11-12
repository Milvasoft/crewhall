import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

/**
 * A real mail server for the mail tests: GreenMail standalone (Apache-2.0) with plain IMAP
 * on 3143 and SMTP on 3025. Mailboxes are created from GREENMAIL_OPTS; logins are full
 * addresses. Started per test file and stopped in afterAll.
 */

export const MAIL_DOMAIN = 'crewhall.test';
export const MAILBOXES = {
  elif: { address: `elif@${MAIL_DOMAIN}`, password: 'elif-app-password' },
  deniz: { address: `deniz@${MAIL_DOMAIN}`, password: 'deniz-app-password' },
  destek: { address: `destek@${MAIL_DOMAIN}`, password: 'destek-app-password' },
} as const;

export interface GreenMail {
  container: StartedTestContainer;
  host: string;
  imapPort: number;
  smtpPort: number;
}

export async function startGreenMail(): Promise<GreenMail> {
  const users = Object.values(MAILBOXES)
    .map((m) => `${m.address.split('@')[0]}:${m.password}@${MAIL_DOMAIN}`)
    .join(',');
  const container = await new GenericContainer('greenmail/standalone:2.1.5')
    .withEnvironment({
      GREENMAIL_OPTS: [
        '-Dgreenmail.setup.test.smtp',
        '-Dgreenmail.setup.test.imap',
        '-Dgreenmail.hostname=0.0.0.0',
        `-Dgreenmail.users=${users}`,
        '-Dgreenmail.users.login=email',
      ].join(' '),
    })
    .withExposedPorts(3025, 3143)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(120_000)
    .start();
  return {
    container,
    host: container.getHost(),
    imapPort: container.getMappedPort(3143),
    smtpPort: container.getMappedPort(3025),
  };
}

/** Delivers a message as an outside sender would (unauthenticated SMTP to GreenMail). */
export async function deliver(gm: GreenMail, message: Mail.Options) {
  const transport = nodemailer.createTransport({
    host: gm.host,
    port: gm.smtpPort,
    secure: false,
    ignoreTLS: true,
  });
  try {
    return await transport.sendMail(message);
  } finally {
    transport.close();
  }
}

/** Direct IMAP access to a test mailbox, for checks behind Crewhall's back. */
export async function withMailbox<T>(
  gm: GreenMail,
  box: { address: string; password: string },
  fn: (c: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = new ImapFlow({
    host: gm.host,
    port: gm.imapPort,
    secure: false,
    doSTARTTLS: false,
    auth: { user: box.address, pass: box.password },
    logger: false,
  });
  client.on('error', () => undefined);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}
