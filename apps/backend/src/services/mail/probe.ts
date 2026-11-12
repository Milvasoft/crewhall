import net from 'node:net';
import tls from 'node:tls';
import type { MailProbeResult, MailServerTestResult, TestMailServer } from '@crewhall/shared';
import { ImapFlow } from 'imapflow';
import {
  errorDetail,
  imapOptions,
  isAuthError,
  smtpTransport,
  type MailAuth,
  type ServerAddress,
} from './imap';

const ok: MailProbeResult = { ok: true, error: null, detail: null };

function failure(err: unknown): MailProbeResult {
  return {
    ok: false,
    error: isAuthError(err) ? 'mail_auth_failed' : 'mail_server_unreachable',
    detail: errorDetail(err) || null,
  };
}

/** Waits for the IMAP greeting (`* OK`) without signing in. */
function imapGreeting(server: ServerAddress): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket =
      server.security === 'tls'
        ? tls.connect({ host: server.host, port: server.port, servername: server.host })
        : net.connect({ host: server.host, port: server.port });
    const done = (err?: Error) => {
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(10_000, () =>
      done(Object.assign(new Error('greeting timeout'), { code: 'GREETING_TIMEOUT' })),
    );
    socket.once('error', (err) => done(err));
    socket.once('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8');
      if (/^\* (OK|PREAUTH)/i.test(line)) done();
      else done(Object.assign(new Error(line.trim().slice(0, 200)), { code: 'ECONNECTION' }));
    });
  });
}

async function imapLogin(server: ServerAddress, auth: MailAuth) {
  const client = new ImapFlow({ ...imapOptions(server, auth), verifyOnly: true });
  client.on('error', () => undefined);
  try {
    await client.connect();
  } finally {
    client.close();
  }
}

/** Admin's connection test (Yönetim › Posta). Signs in only when credentials are given. */
export async function testServers(input: TestMailServer): Promise<MailServerTestResult> {
  const imap: ServerAddress = {
    host: input.imapHost,
    port: input.imapPort,
    security: input.imapSecurity,
  };
  const smtp: ServerAddress = {
    host: input.smtpHost,
    port: input.smtpPort,
    security: input.smtpSecurity,
  };
  const auth: MailAuth | undefined =
    input.username && input.password ? { user: input.username, pass: input.password } : undefined;

  const [imapResult, smtpResult] = await Promise.all([
    (auth ? imapLogin(imap, auth) : imapGreeting(imap)).then(() => ok, failure),
    (async () => {
      const transport = smtpTransport(smtp, auth);
      try {
        await transport.verify();
        return ok;
      } catch (err) {
        return failure(err);
      } finally {
        transport.close();
      }
    })(),
  ]);
  return { imap: imapResult, smtp: smtpResult };
}
