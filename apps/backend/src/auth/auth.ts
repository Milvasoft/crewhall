import { AsyncLocalStorage } from 'node:async_hooks';
import { expo } from '@better-auth/expo';
import { passkey } from '@better-auth/passkey';
import { resolveLocale, type AppLocale } from '@crewhall/i18n';
import {
  accounts,
  invitations,
  newId,
  organizations,
  orgMembers,
  passkeys,
  sessions,
  twoFactors,
  users,
  verifications,
} from '@crewhall/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { bearer, organization, twoFactor } from 'better-auth/plugins';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { BaseDeps } from '../deps';
import { resetMail, verifyMail } from '../mail/templates';
import { mailBrandForUser } from '../services/brand';
import { clearLockout } from '../services/lockout';
import { generateBackupCodes } from './backup-codes';
import { lockoutHooks } from './lockout-hooks';
import { identityAuthPlugin } from '../services/identity/auth-plugin';
import { paths, withQuery } from '@crewhall/shared';

/** Lets the setup wizard create the owner while sign-up is otherwise invite-only. */
export const signupBypass = new AsyncLocalStorage<true>();

const orgPlugin = organization();
/**
 * Organization management goes through /api/v1 only, so can() and the audit log
 * always apply. The plugin stays for its schema and session.activeOrganizationId.
 */
const ORG_PLUGIN_PATHS = Object.values(orgPlugin.endpoints)
  .map((e) => e.path)
  .filter((p): p is string => typeof p === 'string' && p.length > 0);

const ip = (request: Request | undefined) =>
  request?.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
  request?.headers.get('x-real-ip') ??
  null;

export function createAuth(deps: BaseDeps) {
  const { env, db, mailer, logger } = deps;
  const hub = new URL(env.HUB_URL);
  const webOrigins = [env.HUB_URL, ...env.WEB_ORIGINS].map((o) => new URL(o).origin);
  const isTest = env.NODE_ENV === 'test';

  const localeOf = (user: object): AppLocale => {
    const locale = 'locale' in user ? user.locale : null;
    return resolveLocale(typeof locale === 'string' ? locale : null);
  };

  async function hasPendingInvitation(email: string) {
    const [row] = await db
      .select({ id: invitations.id })
      .from(invitations)
      .where(
        and(
          sql`${invitations.email} = ${email}`,
          eq(invitations.status, 'pending'),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  return betterAuth({
    appName: 'Crewhall',
    baseURL: env.API_URL,
    basePath: '/api/auth',
    secret: env.AUTH_SECRET,
    trustedOrigins: [...webOrigins, ...env.TRUSTED_ORIGINS],
    telemetry: { enabled: false },
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        twoFactor: twoFactors,
        passkey: passkeys,
        organization: organizations,
        member: orgMembers,
        invitation: invitations,
      },
    }),
    advanced: {
      database: {
        generateId: () => newId(),
        // organizations and invitations carry required Crewhall columns (branding, settings,
        // token_hash) that better-auth never writes: rows are created only by our services
        // because the organization plugin's endpoints are disabled. Auth flows are covered
        // by integration tests instead of this startup check.
        validateSchema: false,
      },
      cookiePrefix: 'crewhall',
      useSecureCookies: env.API_URL.startsWith('https://'),
      ipAddress: { ipAddressHeaders: ['x-forwarded-for', 'x-real-ip'] },
    },
    user: {
      additionalFields: {
        locale: { type: 'string', required: false, defaultValue: 'tr', input: false },
      },
    },
    session: {
      // 30 days with "keep me signed in"; without it the cookie ends with the browser session.
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 12,
      freshAge: 60 * 60 * 12,
      // Lifetimes are absolute and capped by the org policy (identity module, design 01 "Oturum").
      disableSessionRefresh: true,
    },
    emailAndPassword: {
      enabled: true,
      // The org password policy (identity module) sets the real minimum, 12 by default.
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: true,
      // Invited people prove their address with the invitation link (marked verified on accept).
      requireEmailVerification: false,
      resetPasswordTokenExpiresIn: 30 * 60,
      revokeSessionsOnPasswordReset: true,
      // Resetting the password is the self-service way out of a lock (design 1.16).
      async onPasswordReset({ user }) {
        await clearLockout(db, user.email);
      },
      async sendResetPassword({ user, token }, request) {
        const brand = await mailBrandForUser(db, env.HUB_URL, user.id);
        const locale = localeOf(user);
        const url = `${env.HUB_URL}${withQuery(paths.resetPassword(), { t: token })}`;
        const now = new Date();
        const mail = resetMail(brand, {
          locale,
          name: user.name,
          url,
          requestedAt: now,
          expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
          userAgent: request?.headers.get('user-agent') ?? null,
          ip: ip(request),
        });
        await mailer.send({
          orgId: brand.orgId ?? null,
          to: user.email,
          fromName: brand.branding.orgName,
          ...mail,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: false,
      expiresIn: 60 * 60 * 24,
      async sendVerificationEmail({ user, token }) {
        const brand = await mailBrandForUser(db, env.HUB_URL, user.id);
        const callback = encodeURIComponent(`${env.HUB_URL}/`);
        const url = `${env.API_URL}/api/auth/verify-email?token=${encodeURIComponent(token)}&callbackURL=${callback}`;
        const mail = verifyMail(brand, {
          locale: localeOf(user),
          name: user.name,
          to: user.email,
          url,
        });
        await mailer.send({
          orgId: brand.orgId ?? null,
          to: user.email,
          fromName: brand.branding.orgName,
          ...mail,
        });
      },
    },
    databaseHooks: {
      user: {
        create: {
          async before(user, ctx) {
            // Sign-up is invite-only (1.1: "ask an admin for an invitation").
            if (!signupBypass.getStore() && !env.SIGNUP_OPEN) {
              if (!(await hasPendingInvitation(user.email))) {
                throw new APIError('FORBIDDEN', {
                  code: 'SIGNUP_REQUIRES_INVITATION',
                  message: 'Sign-up requires an invitation',
                });
              }
            }
            const locale = resolveLocale(ctx?.request?.headers.get('accept-language') ?? null);
            return { data: { ...user, locale: user.locale ?? locale } };
          },
        },
      },
    },
    hooks: lockoutHooks(deps),
    disabledPaths: ORG_PLUGIN_PATHS,
    rateLimit: {
      enabled: !isTest,
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/two-factor/*': { window: 60, max: 10 },
        '/request-password-reset': { window: 60 * 60, max: 5 },
        '/sign-up/email': { window: 60, max: 5 },
      },
    },
    plugins: [
      twoFactor({
        issuer: env.TOTP_ISSUER,
        // Our per-e-mail counter (lockout-hooks.ts) covers password, TOTP and backup codes.
        accountLockout: { enabled: false },
        // Directory and SSO accounts have no local password; those with one must still give it.
        allowPasswordless: true,
        // Design 1.4: 8 characters, upper case and digits, shown as XXXX-XXXX.
        backupCodeOptions: { amount: 10, customBackupCodesGenerate: generateBackupCodes },
      }),
      passkey({
        rpID: hub.hostname,
        rpName: 'Crewhall',
        origin: webOrigins,
      }),
      orgPlugin,
      bearer(),
      expo(),
      identityAuthPlugin(deps),
    ],
    logger: {
      log: (level, message, ...args) => {
        const fn = level === 'error' ? logger.error : level === 'warn' ? logger.warn : logger.debug;
        fn.call(logger, { args }, `better-auth: ${message}`);
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
