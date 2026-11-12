import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import { verifications, type DbOrTx } from '@crewhall/db';
import {
  isAllowedMobileRedirect,
  OAUTH_HANDOFF_RAW_PATHS,
  OAUTH_HANDOFF_TTL_SECONDS,
  type CreateOAuthHandoff,
  type OAuthHandoff,
  type OAuthHandoffPurpose,
} from '@crewhall/shared';
import { z } from 'zod';
import type { Env } from '../env';
import { AppError } from '../http/errors';

/**
 * Connecting a Google or Microsoft account from the app (schemas/auth.ts). The system browser has
 * no web session, so two short-lived rows in better-auth's `verifications` table carry the person:
 * - the one-time code of the link (2 minutes, deleted when used);
 * - the provider `state` the link started, bound to a cookie set in that same browser, so the
 *   callback runs as that person only in the browser that opened the link (10 minutes, like the
 *   provider states themselves).
 * Only hashes are stored. The callback returns to the app's allowlisted scheme.
 */

const CODE_PREFIX = 'oauth-handoff:';
const STATE_PREFIX = 'oauth-handoff-state:';
const STATE_TTL_MS = 10 * 60_000;
export const HANDOFF_COOKIE = 'crewhall_oauth_handoff';

const sha = (v: string) => createHash('sha256').update(v).digest('base64url');

const Handoff = z.object({
  userId: z.uuid(),
  orgId: z.uuid(),
  purpose: z.enum(['mail', 'calendar']),
  provider: z.enum(['google', 'microsoft']).nullable(),
  redirectUri: z.string(),
});
export type Handoff = z.infer<typeof Handoff>;

const BoundState = z.object({
  userId: z.uuid(),
  orgId: z.uuid(),
  purpose: z.enum(['mail', 'calendar']),
  redirectUri: z.string(),
  cookie: z.string(),
});
export type BoundState = z.infer<typeof BoundState>;

const redirectPolicy = (env: Pick<Env, 'NODE_ENV'>) => ({
  production: env.NODE_ENV === 'production',
});

export async function createHandoff(
  db: DbOrTx,
  env: Pick<Env, 'API_URL' | 'NODE_ENV'>,
  a: { orgId: string; userId: string },
  input: CreateOAuthHandoff,
): Promise<OAuthHandoff> {
  if (!isAllowedMobileRedirect(input.redirectUri, redirectPolicy(env))) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: [
        {
          path: ['redirectUri'],
          code: 'redirect_not_allowed',
          message: 'crewhall: only (exp: outside production)',
        },
      ],
    });
  }
  const code = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + OAUTH_HANDOFF_TTL_SECONDS * 1000);
  await db.delete(verifications).where(lt(verifications.expiresAt, new Date()));
  await db.insert(verifications).values({
    identifier: `${CODE_PREFIX}${sha(code)}`,
    value: JSON.stringify({
      userId: a.userId,
      orgId: a.orgId,
      purpose: input.purpose,
      provider: input.provider ?? null,
      redirectUri: input.redirectUri,
    } satisfies Handoff),
    expiresAt,
  });
  const url = new URL(OAUTH_HANDOFF_RAW_PATHS.open, env.API_URL);
  url.searchParams.set('code', code);
  return { url: url.toString(), expiresAt: expiresAt.toISOString() };
}

/** The hand-off of a link, once: the row is deleted whether or not it is still valid. */
export async function useHandoff(db: DbOrTx, code: string): Promise<Handoff | null> {
  const [row] = await db
    .delete(verifications)
    .where(eq(verifications.identifier, `${CODE_PREFIX}${sha(code)}`))
    .returning();
  if (!row || row.expiresAt.getTime() <= Date.now()) return null;
  const parsed = Handoff.safeParse(JSON.parse(row.value));
  return parsed.success ? parsed.data : null;
}

/** Binds the provider state the link started to this browser; returns the cookie value. */
export async function bindState(db: DbOrTx, state: string, h: Handoff): Promise<string> {
  const cookie = randomBytes(32).toString('base64url');
  await db.insert(verifications).values({
    identifier: `${STATE_PREFIX}${sha(state)}`,
    value: JSON.stringify({
      userId: h.userId,
      orgId: h.orgId,
      purpose: h.purpose,
      redirectUri: h.redirectUri,
      cookie: sha(cookie),
    } satisfies BoundState),
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
  return cookie;
}

/**
 * The person a callback without a session runs as: its state came from a hand-off link and the
 * browser shows that link's cookie. Used once.
 */
export async function boundState(
  db: DbOrTx,
  purpose: OAuthHandoffPurpose,
  state: string | undefined,
  cookie: string | undefined,
): Promise<BoundState | null> {
  if (!state || !cookie) return null;
  const [row] = await db
    .delete(verifications)
    .where(
      and(
        eq(verifications.identifier, `${STATE_PREFIX}${sha(state)}`),
        gt(verifications.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!row) return null;
  const parsed = BoundState.safeParse(JSON.parse(row.value));
  if (!parsed.success || parsed.data.purpose !== purpose || parsed.data.cookie !== sha(cookie)) {
    return null;
  }
  return parsed.data;
}

/** `<redirectUri>?url=<path>`: the app opens the path (checked again: the scheme may only be the app's). */
export function appReturn(env: Pick<Env, 'NODE_ENV'>, redirectUri: string, path: string) {
  if (!isAllowedMobileRedirect(redirectUri, redirectPolicy(env))) {
    throw new Error('redirect not allowed');
  }
  return `${redirectUri}${redirectUri.includes('?') ? '&' : '?'}url=${encodeURIComponent(path)}`;
}
