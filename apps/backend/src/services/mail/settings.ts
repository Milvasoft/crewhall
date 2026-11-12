import { eq } from 'drizzle-orm';
import { mailSettings, type DbOrTx } from '@crewhall/db';
import {
  MAIL_RAW_PATHS,
  type MailServerSettings,
  type MailUsernameFormat,
  type UpdateMailServerSettings,
} from '@crewhall/shared';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';
import { sealSecret } from './crypto';

export type MailSettingsRow = typeof mailSettings.$inferSelect;

export async function loadSettings(db: DbOrTx, orgId: string): Promise<MailSettingsRow | null> {
  const [row] = await db.select().from(mailSettings).where(eq(mailSettings.orgId, orgId));
  return row ?? null;
}

/** Settings of an org whose admin finished the form; mail_not_configured otherwise. */
export async function requireSettings(db: DbOrTx, orgId: string): Promise<MailSettingsRow> {
  const row = await loadSettings(db, orgId);
  if (!row) throw new AppError('mail_not_configured');
  return row;
}

export const oauthRedirectUri = (env: Pick<Env, 'API_URL'>) =>
  `${env.API_URL.replace(/\/$/, '')}${MAIL_RAW_PATHS.oauthCallback}`;

export function settingsView(
  env: Pick<Env, 'API_URL'>,
  row: MailSettingsRow | null,
): MailServerSettings {
  return {
    configured: row !== null,
    imapHost: row?.imapHost ?? '',
    imapPort: row?.imapPort ?? 993,
    imapSecurity: row?.imapSecurity ?? 'tls',
    smtpHost: row?.smtpHost ?? '',
    smtpPort: row?.smtpPort ?? 587,
    smtpSecurity: row?.smtpSecurity ?? 'starttls',
    authMode: row?.authMode ?? 'password',
    usernameFormat: (row?.usernameFormat as MailUsernameFormat | undefined) ?? 'email',
    oauthClientId: row?.oauthClientId ?? null,
    hasOauthClientSecret: Boolean(row?.oauthClientSecretEnc),
    oauthTenant: row?.oauthTenant ?? null,
    oauthRedirectUri: oauthRedirectUri(env),
    saveSentCopy: row?.saveSentCopy ?? true,
    allowRemoteImages: row?.allowRemoteImages ?? true,
    pollMinutes: row?.pollMinutes ?? 5,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

export async function updateSettings(
  db: DbOrTx,
  env: Pick<Env, 'API_URL' | 'AUTH_SECRET'>,
  orgId: string,
  userId: string,
  input: UpdateMailServerSettings,
): Promise<MailServerSettings> {
  const current = await loadSettings(db, orgId);
  let secretEnc = current?.oauthClientSecretEnc ?? null;
  if (input.oauthClientSecret === null) secretEnc = null;
  else if (input.oauthClientSecret)
    secretEnc = sealSecret(env.AUTH_SECRET, input.oauthClientSecret);

  const clientId =
    input.oauthClientId === undefined
      ? (current?.oauthClientId ?? null)
      : input.oauthClientId || null;
  if (input.authMode !== 'password' && (!clientId || !secretEnc)) {
    throw new AppError('bad_request', { reason: 'oauth_client_required' });
  }
  const values = {
    imapHost: input.imapHost,
    imapPort: input.imapPort,
    imapSecurity: input.imapSecurity,
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecurity: input.smtpSecurity,
    authMode: input.authMode,
    usernameFormat: input.usernameFormat,
    oauthClientId: clientId,
    oauthClientSecretEnc: secretEnc,
    oauthTenant:
      input.oauthTenant === undefined ? (current?.oauthTenant ?? null) : input.oauthTenant || null,
    saveSentCopy: input.saveSentCopy,
    allowRemoteImages: input.allowRemoteImages,
    pollMinutes: input.pollMinutes,
    updatedBy: userId,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(mailSettings)
    .values({ orgId, ...values })
    .onConflictDoUpdate({ target: mailSettings.orgId, set: values })
    .returning();
  return settingsView(env, row!);
}
