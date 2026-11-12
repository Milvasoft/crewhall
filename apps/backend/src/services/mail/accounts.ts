import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { mailAccounts, mailFolderState, mailHeaders, type DbOrTx } from '@crewhall/db';
import {
  MAIL_MAX_ATTACHMENT_BYTES,
  type ConnectMailAccount,
  type MailAccount,
  type MailAccountState,
  type UpdateMailAccount,
} from '@crewhall/shared';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';
import type { Logger } from '../../logger';
import type { Bus } from '../../realtime/bus';
import { openSecret, sealSecret } from './crypto';
import {
  closeAccountConnections,
  imapAddress,
  verifyImapLogin,
  withImap,
  type ImapSession,
  type MailAuth,
} from './imap';
import { forgetFolders } from './folders';
import { refreshTokens, type OauthTokens } from './oauth';
import { sanitizeHtml } from './sanitize';
import { loadSettings, requireSettings, type MailSettingsRow } from './settings';

export type MailAccountRow = typeof mailAccounts.$inferSelect;

export interface MailDeps {
  db: DbOrTx;
  env: Pick<Env, 'AUTH_SECRET' | 'API_URL' | 'HUB_URL'>;
  logger: Logger;
  /** Pushes `mail.changed` to the user's WebSocket (absent in scripts). */
  bus?: Bus | undefined;
}

/** Everything a mailbox call needs: the org's servers, the account, its IMAP session. */
export interface MailContext {
  settings: MailSettingsRow;
  account: MailAccountRow;
  imap: ImapSession;
  auth: () => Promise<MailAuth>;
}

export function accountView(row: MailAccountRow): MailAccount {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    username: row.username,
    authMode: row.authMode,
    status: row.status,
    signatureHtml: row.signatureHtml,
    notify: row.notify,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function loadAccount(db: DbOrTx, orgId: string, userId: string) {
  const [row] = await db
    .select()
    .from(mailAccounts)
    .where(
      and(
        eq(mailAccounts.orgId, orgId),
        eq(mailAccounts.userId, userId),
        eq(mailAccounts.kind, 'personal'),
      ),
    );
  return row ?? null;
}

export async function accountState(
  db: DbOrTx,
  orgId: string,
  userId: string,
): Promise<MailAccountState> {
  const settings = await loadSettings(db, orgId);
  const account = await loadAccount(db, orgId, userId);
  return {
    server: {
      configured: settings !== null,
      authMode: settings?.authMode ?? 'password',
      allowRemoteImages: settings?.allowRemoteImages ?? true,
      maxAttachmentBytes: MAIL_MAX_ATTACHMENT_BYTES,
    },
    account: account ? accountView(account) : null,
  };
}

function loginName(settings: MailSettingsRow, email: string, given: string | undefined) {
  if (given) return given;
  return settings.usernameFormat === 'local' ? email.split('@')[0]! : email;
}

/** Credentials of an account, renewing an OAuth access token that expires within a minute. */
export async function accountAuth(
  deps: MailDeps,
  settings: MailSettingsRow,
  account: MailAccountRow,
): Promise<MailAuth> {
  // A shared inbox signs in with its own app password whatever the org's mode is.
  if (account.kind === 'personal' && account.authMode !== settings.authMode) {
    throw new AppError('mail_auth_mode_mismatch');
  }
  if (account.authMode === 'password') {
    const pass = openSecret(deps.env.AUTH_SECRET, account.passwordEnc);
    if (!pass) throw new AppError('mail_auth_failed');
    return { user: account.username, pass };
  }
  const valid = (row: MailAccountRow) => {
    const token = openSecret(deps.env.AUTH_SECRET, row.oauthAccessEnc);
    return token && row.oauthExpiresAt && row.oauthExpiresAt.getTime() > Date.now() + 60_000
      ? token
      : null;
  };
  const access = valid(account);
  if (access) return { user: account.username, accessToken: access };
  // One refresh per account at a time: the request and the background connection may both
  // find the token expired, and Microsoft retires a refresh token once it was used.
  const running = refreshing.get(account.id);
  if (running) return running;
  const job = refreshAccount(deps, settings, account.id, valid).finally(() =>
    refreshing.delete(account.id),
  );
  refreshing.set(account.id, job);
  return job;
}

const refreshing = new Map<string, Promise<MailAuth>>();

async function refreshAccount(
  deps: MailDeps,
  settings: MailSettingsRow,
  accountId: string,
  valid: (row: MailAccountRow) => string | null,
): Promise<MailAuth> {
  // The row the caller holds may be older than the last refresh.
  const [account] = await deps.db.select().from(mailAccounts).where(eq(mailAccounts.id, accountId));
  if (!account) throw new AppError('mail_account_required');
  const access = valid(account);
  if (access) return { user: account.username, accessToken: access };
  const refresh = openSecret(deps.env.AUTH_SECRET, account.oauthRefreshEnc);
  if (!refresh) throw new AppError('mail_auth_failed');
  let tokens: OauthTokens;
  try {
    tokens = await refreshTokens(deps.env, settings, refresh);
  } catch (err) {
    if (err instanceof AppError && err.code === 'mail_auth_failed') {
      await deps.db
        .update(mailAccounts)
        .set({ status: 'auth_failed' })
        .where(eq(mailAccounts.id, account.id));
    }
    throw err;
  }
  await deps.db
    .update(mailAccounts)
    .set({
      oauthAccessEnc: sealSecret(deps.env.AUTH_SECRET, tokens.accessToken),
      oauthExpiresAt: tokens.expiresAt,
      // Microsoft rotates refresh tokens; Google keeps the old one.
      ...(tokens.refreshToken
        ? { oauthRefreshEnc: sealSecret(deps.env.AUTH_SECRET, tokens.refreshToken) }
        : {}),
    })
    .where(eq(mailAccounts.id, account.id));
  return { user: account.username, accessToken: tokens.accessToken };
}

export function contextFor(
  deps: MailDeps,
  settings: MailSettingsRow,
  account: MailAccountRow,
): MailContext {
  const auth = () => accountAuth(deps, settings, account);
  // New credentials (fresh ciphertext) or server settings change the stamp, so a connection
  // signed in with the old ones is not reused.
  const stamp = createHash('sha256')
    .update(
      [
        account.username,
        account.passwordEnc ?? '',
        account.oauthRefreshEnc ?? '',
        settings.updatedAt.getTime(),
      ].join('\n'),
    )
    .digest('hex')
    .slice(0, 16);
  return {
    settings,
    account,
    auth,
    imap: {
      key: `${account.id}:${stamp}`,
      accountId: account.id,
      server: imapAddress(settings),
      auth,
    },
  };
}

/** The caller's mailbox: 409 mail_not_configured / mail_account_required before it exists. */
export async function requireMailbox(deps: MailDeps, orgId: string, userId: string) {
  const settings = await requireSettings(deps.db, orgId);
  const account = await loadAccount(deps.db, orgId, userId);
  if (!account) throw new AppError('mail_account_required');
  if (account.authMode !== settings.authMode) throw new AppError('mail_auth_mode_mismatch');
  return contextFor(deps, settings, account);
}

export const imapOf = <T>(
  deps: MailDeps,
  ctx: MailContext,
  fn: Parameters<typeof withImap<T>>[3],
) => withImap(deps.db, deps.logger, ctx.imap, fn);

/** App password sign-in: checked on IMAP before anything is stored. */
export async function connectPassword(
  deps: MailDeps,
  orgId: string,
  user: { id: string; name: string },
  input: ConnectMailAccount,
): Promise<MailAccount> {
  const settings = await requireSettings(deps.db, orgId);
  if (settings.authMode !== 'password') throw new AppError('mail_auth_mode_mismatch');
  const email = input.email.toLowerCase();
  const username = loginName(settings, email, input.username);
  await verifyImapLogin(imapAddress(settings), { user: username, pass: input.password });
  return saveAccount(deps, orgId, user.id, {
    email,
    username,
    displayName: input.displayName ?? user.name,
    authMode: 'password',
    passwordEnc: sealSecret(deps.env.AUTH_SECRET, input.password),
    oauthAccessEnc: null,
    oauthRefreshEnc: null,
    oauthExpiresAt: null,
  });
}

/** OAuth2 sign-in result: the token's e-mail claim is the mailbox. */
export async function connectOauth(
  deps: MailDeps,
  settings: MailSettingsRow,
  user: { id: string; name: string; email: string },
  tokens: OauthTokens,
): Promise<MailAccount> {
  if (settings.authMode === 'password') throw new AppError('mail_auth_mode_mismatch');
  if (!tokens.refreshToken) throw new AppError('mail_oauth_failed', { reason: 'no_refresh_token' });
  const email = tokens.email ?? user.email.toLowerCase();
  await verifyImapLogin(imapAddress(settings), { user: email, accessToken: tokens.accessToken });
  const existing = await loadAccount(deps.db, settings.orgId, user.id);
  return saveAccount(deps, settings.orgId, user.id, {
    email,
    username: email,
    displayName: existing?.displayName || user.name,
    authMode: settings.authMode,
    passwordEnc: null,
    oauthAccessEnc: sealSecret(deps.env.AUTH_SECRET, tokens.accessToken),
    oauthRefreshEnc: sealSecret(deps.env.AUTH_SECRET, tokens.refreshToken),
    oauthExpiresAt: tokens.expiresAt,
  });
}

type Credentials = Pick<
  MailAccountRow,
  | 'email'
  | 'username'
  | 'displayName'
  | 'authMode'
  | 'passwordEnc'
  | 'oauthAccessEnc'
  | 'oauthRefreshEnc'
  | 'oauthExpiresAt'
>;

async function saveAccount(deps: MailDeps, orgId: string, userId: string, values: Credentials) {
  const existing = await loadAccount(deps.db, orgId, userId);
  // A different mailbox starts a new new-mail watermark.
  const sameMailbox = existing?.email === values.email;
  const set = {
    ...values,
    status: 'ok' as const,
    updatedAt: new Date(),
    ...(sameMailbox
      ? {}
      : { inboxUidValidity: null, inboxLastUid: null, folders: null, foldersAt: null }),
  };
  const [row] = await deps.db
    .insert(mailAccounts)
    .values({ orgId, userId, ...set })
    .onConflictDoUpdate({
      target: [mailAccounts.orgId, mailAccounts.userId],
      targetWhere: sql`${mailAccounts.kind} = 'personal'`,
      set,
    })
    .returning();
  if (existing) {
    closeAccountConnections(existing.id);
    // Another mailbox behind the same account row: its folders start from scratch.
    if (!sameMailbox) {
      await deps.db.delete(mailHeaders).where(eq(mailHeaders.accountId, existing.id));
      await deps.db.delete(mailFolderState).where(eq(mailFolderState.accountId, existing.id));
      forgetFolders(existing.id, { names: true });
    }
  }
  return accountView(row!);
}

export async function updateAccount(
  deps: MailDeps,
  orgId: string,
  userId: string,
  input: UpdateMailAccount,
): Promise<MailAccount> {
  const account = await loadAccount(deps.db, orgId, userId);
  if (!account) throw new AppError('mail_account_required');
  const set: Partial<MailAccountRow> = {};
  if (input.displayName !== undefined) set.displayName = input.displayName;
  if (input.signatureHtml !== undefined) {
    set.signatureHtml = sanitizeHtml(input.signatureHtml, { remoteImages: true }).html;
  }
  if (input.notify !== undefined) set.notify = input.notify;
  if (input.password !== undefined) {
    const settings = await requireSettings(deps.db, orgId);
    if (settings.authMode !== 'password' || account.authMode !== 'password') {
      throw new AppError('mail_auth_mode_mismatch');
    }
    await verifyImapLogin(imapAddress(settings), { user: account.username, pass: input.password });
    set.passwordEnc = sealSecret(deps.env.AUTH_SECRET, input.password);
    set.status = 'ok';
    set.updatedAt = new Date();
    closeAccountConnections(account.id);
  }
  if (Object.keys(set).length === 0) return accountView(account);
  const [row] = await deps.db
    .update(mailAccounts)
    .set(set)
    .where(eq(mailAccounts.id, account.id))
    .returning();
  return accountView(row!);
}

export async function disconnectAccount(db: DbOrTx, orgId: string, userId: string) {
  const [row] = await db
    .delete(mailAccounts)
    .where(
      and(
        eq(mailAccounts.orgId, orgId),
        eq(mailAccounts.userId, userId),
        eq(mailAccounts.kind, 'personal'),
      ),
    )
    .returning({ id: mailAccounts.id });
  if (row) closeAccountConnections(row.id);
}
