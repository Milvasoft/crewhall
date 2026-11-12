import { symmetricEncrypt } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { twoFactors, users, type Db } from '@crewhall/db';
import type { Auth } from './auth';
import { signupBypass } from './auth';

/**
 * Creates an e-mail + password account through better-auth's own adapter (same hashing
 * and hooks as sign-up) without opening a session. Used by setup and the seed.
 */
export async function createCredentialUser(
  auth: Auth,
  input: { email: string; name: string; password: string; locale: 'tr' | 'en' },
) {
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(input.password);
  const user = await signupBypass.run(true, () =>
    ctx.internalAdapter.createUser(
      { email: input.email.toLowerCase(), name: input.name, locale: input.locale },
      { method: 'email-password' },
    ),
  );
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: 'credential',
    accountId: user.id,
    password: hash,
  });
  return user;
}

/**
 * Enables TOTP with a known secret, encrypted exactly as better-auth's two-factor
 * plugin stores it. Development seed only: real users enrol through /api/auth/two-factor.
 */
export async function enableTotpWithSecret(
  auth: Auth,
  db: Db,
  userId: string,
  secret: string,
  backupCodes: string[],
) {
  const ctx = await auth.$context;
  await db.insert(twoFactors).values({
    userId,
    secret: await symmetricEncrypt({ key: ctx.secretConfig, data: secret }),
    backupCodes: await symmetricEncrypt({
      key: ctx.secretConfig,
      data: JSON.stringify(backupCodes),
    }),
    verified: true,
  });
  await db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, userId));
}
