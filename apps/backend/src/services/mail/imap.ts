import { eq } from 'drizzle-orm';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import nodemailer from 'nodemailer';
import { mailAccounts, type DbOrTx } from '@crewhall/db';
import type { MailSecurity } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { Logger } from '../../logger';
import type { MailSettingsRow } from './settings';
import { timed } from './timing';

/** Credentials for one sign-in: an app password or an OAuth2 access token (XOAUTH2). */
export type MailAuth = { user: string; pass: string } | { user: string; accessToken: string };

export interface ServerAddress {
  host: string;
  port: number;
  security: MailSecurity;
}

const CONNECT_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 120_000;
/** Pooled connections are closed after this long without use. */
const IDLE_CLOSE_MS = 90_000;

export const imapAddress = (s: MailSettingsRow): ServerAddress => ({
  host: s.imapHost,
  port: s.imapPort,
  security: s.imapSecurity,
});
export const smtpAddress = (s: MailSettingsRow): ServerAddress => ({
  host: s.smtpHost,
  port: s.smtpPort,
  security: s.smtpSecurity,
});

export function imapOptions(server: ServerAddress, auth: MailAuth | undefined): ImapFlowOptions {
  return {
    host: server.host,
    port: server.port,
    secure: server.security === 'tls',
    // `starttls` refuses a server without STARTTLS instead of falling back to plain text.
    doSTARTTLS:
      server.security === 'starttls' ? true : server.security === 'none' ? false : undefined,
    auth,
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    clientInfo: { name: 'Crewhall' },
  };
}

export function smtpTransport(server: ServerAddress, auth: MailAuth | undefined) {
  return nodemailer.createTransport({
    host: server.host,
    port: server.port,
    secure: server.security === 'tls',
    requireTLS: server.security === 'starttls',
    ignoreTLS: server.security === 'none',
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    auth: !auth
      ? undefined
      : 'pass' in auth
        ? { user: auth.user, pass: auth.pass }
        : { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken },
  });
}

interface ErrorShape {
  code?: unknown;
  authenticationFailed?: unknown;
  tlsFailed?: unknown;
  responseCode?: unknown;
  responseText?: unknown;
  response?: unknown;
  message?: unknown;
}

const UNREACHABLE = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
  'ETIMEOUT',
  'NoConnection',
  'EConnectionClosed',
  'ClosedAfterConnectText',
  'ClosedAfterConnectTLS',
  'ESOCKET',
  'ECONNECTION',
  'EDNS',
  'ETLS',
]);

/** True when the server refused the credentials (IMAP NO on LOGIN/AUTHENTICATE, SMTP 535). */
export function isAuthError(err: unknown) {
  if (err instanceof AppError) return err.code === 'mail_auth_failed';
  const e = (err ?? {}) as ErrorShape;
  return e.authenticationFailed === true || e.code === 'EAUTH' || e.responseCode === 535;
}

export function isUnreachable(err: unknown) {
  if (err instanceof AppError) return err.code === 'mail_server_unreachable';
  const e = (err ?? {}) as ErrorShape;
  return e.tlsFailed === true || (typeof e.code === 'string' && UNREACHABLE.has(e.code));
}

/** The server's own words for the admin's connection test (never for other users). */
export function errorDetail(err: unknown): string {
  const e = (err ?? {}) as ErrorShape;
  const parts = [e.code, e.responseText ?? e.response ?? e.message].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  return parts.join(': ').slice(0, 500);
}

/** IMAP/SMTP failures as contract errors; anything else stays as it is (a 500). */
export function toMailError(err: unknown): unknown {
  if (err instanceof AppError) return err;
  if (isAuthError(err)) return new AppError('mail_auth_failed');
  if (isUnreachable(err)) return new AppError('mail_server_unreachable');
  return err;
}

/** Signs in once and logs out: used before credentials are saved. */
export async function verifyImapLogin(server: ServerAddress, auth: MailAuth) {
  const client = new ImapFlow({ ...imapOptions(server, auth), verifyOnly: true });
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (err) {
    throw toMailError(err);
  } finally {
    client.close();
  }
}

/* --------------------------------- connection pool --------------------------------- */

interface Pooled {
  key: string;
  client: Promise<ImapFlow>;
  timer: NodeJS.Timeout | null;
  users: number;
}

const pool = new Map<string, Pooled>();

function scheduleClose(entry: Pooled) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    if (entry.users > 0) return;
    void drop(entry);
  }, IDLE_CLOSE_MS);
  entry.timer.unref();
}

function drop(entry: Pooled): Promise<void> {
  if (pool.get(entry.key) === entry) pool.delete(entry.key);
  if (entry.timer) clearTimeout(entry.timer);
  return entry.client.then((c) => c.logout().catch(() => c.close())).catch(() => undefined);
}

export interface ImapSession {
  /** Pool key: account id plus credential stamp, so new credentials get a new connection. */
  key: string;
  server: ServerAddress;
  auth: () => Promise<MailAuth>;
  accountId: string;
}

/**
 * Runs `fn` on the account's pooled IMAP connection (one per account, closed after 90 s idle).
 * imapflow queues commands and mailbox locks itself, so parallel requests of one user share it.
 * A refused password marks the account `auth_failed` so the client can ask for a new one.
 */
export async function withImap<T>(
  db: DbOrTx,
  logger: Logger,
  session: ImapSession,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const { entry, client } = await timed('connect', () => acquire(db, logger, session));
  try {
    return await timed('imap', () => fn(client));
  } catch (err) {
    if (isAuthError(err) || isUnreachable(err)) void drop(entry);
    throw await failed(db, session, err);
  } finally {
    release(entry);
  }
}

async function failed(db: DbOrTx, session: ImapSession, err: unknown) {
  if (isAuthError(err)) {
    await db
      .update(mailAccounts)
      .set({ status: 'auth_failed' })
      .where(eq(mailAccounts.id, session.accountId));
  }
  return toMailError(err);
}

function create(logger: Logger, session: ImapSession): Pooled {
  for (const other of pool.values()) {
    if (other.key.startsWith(`${session.accountId}:`)) void drop(other);
  }
  const entry: Pooled = {
    key: session.key,
    timer: null,
    users: 0,
    client: (async () => {
      const client = new ImapFlow(imapOptions(session.server, await session.auth()));
      client.on('error', (err: unknown) => {
        logger.debug({ err, accountId: session.accountId }, 'imap connection error');
      });
      client.on('close', () => {
        if (pool.get(entry.key) === entry) pool.delete(entry.key);
      });
      await client.connect();
      return client;
    })(),
  };
  pool.set(session.key, entry);
  return entry;
}

/** A live pooled connection; a stale one (server closed it) is replaced once. */
async function acquire(db: DbOrTx, logger: Logger, session: ImapSession) {
  const pooled = pool.get(session.key);
  if (pooled) {
    pooled.users += 1;
    const client = await pooled.client.catch(() => null);
    if (client?.usable) return { entry: pooled, client };
    release(pooled);
    void drop(pooled);
  }
  const entry = create(logger, session);
  entry.users += 1;
  try {
    return { entry, client: await entry.client };
  } catch (err) {
    release(entry);
    void drop(entry);
    throw await failed(db, session, err);
  }
}

function release(entry: Pooled) {
  entry.users -= 1;
  if (entry.users <= 0) scheduleClose(entry);
}

/** Closes every pooled connection of an account (credentials removed or replaced). */
export function closeAccountConnections(accountId: string) {
  for (const entry of [...pool.values()]) {
    if (entry.key.startsWith(`${accountId}:`)) void drop(entry);
  }
  for (const fn of closers) void fn(accountId);
}

const closers = new Set<(accountId?: string) => Promise<void>>();
/**
 * Other long-lived mail connections (the background watcher) close with the pool: for one
 * account (`accountId`) or all of them (no argument).
 */
export function onCloseAll(fn: (accountId?: string) => Promise<void>) {
  closers.add(fn);
}

/**
 * Shutdown and tests: closes every mail connection and resolves once nothing of the mail
 * module writes to the database any more (call it before ending the pool).
 */
export async function closeAllMailConnections() {
  // A server that never answers LOGOUT must not hold the shutdown.
  const loggedOut = Promise.race([
    Promise.all([...pool.values()].map(drop)),
    new Promise((r) => setTimeout(r, 3_000).unref()),
  ]);
  await Promise.all([loggedOut, ...[...closers].map((fn) => fn())]);
}
