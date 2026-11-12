import { and, eq } from 'drizzle-orm';
import { accounts, mcpReauth } from '@crewhall/db';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { AuthSession } from '../../http/types';
import { take } from './rate-limit';

/** A passkey/password check counts for this long (design 18.7: "son 10 dakikada"). */
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

/**
 * A recent verification: the session itself is fresh (just signed in, e.g. with a
 * passkey) or the password was confirmed through mcpReauth for this session.
 */
export async function verifiedUntil(deps: Pick<Deps, 'db'>, session: AuthSession) {
  const fromSession = new Date(session.createdAt).getTime() + REAUTH_WINDOW_MS;
  const [row] = await deps.db
    .select({ at: mcpReauth.verifiedAt })
    .from(mcpReauth)
    .where(eq(mcpReauth.sessionId, session.id));
  const fromReauth = row ? row.at.getTime() + REAUTH_WINDOW_MS : 0;
  return Math.max(fromSession, fromReauth);
}

export async function isFresh(deps: Pick<Deps, 'db'>, session: AuthSession) {
  return (await verifiedUntil(deps, session)) > Date.now();
}

export async function requireFresh(deps: Pick<Deps, 'db'>, session: AuthSession) {
  if (!(await isFresh(deps, session))) throw new AppError('mcp_reauth_required');
}

export async function reauthWithPassword(
  deps: Deps,
  ctx: { orgId: string; userId: string; session: AuthSession },
  password: string,
) {
  const limit = await take(deps.db, ctx.userId, { kind: 'reauth', perMinute: 5 }, ctx.orgId);
  if (!limit.allowed) throw new AppError('rate_limited', { retryAfter: limit.retryAfter });
  const [account] = await deps.db
    .select({ hash: accounts.password })
    .from(accounts)
    .where(and(eq(accounts.userId, ctx.userId), eq(accounts.providerId, 'credential')));
  if (!account?.hash) throw new AppError('mcp_password_invalid');
  const auth = await deps.auth.$context;
  const ok = await auth.password.verify({ hash: account.hash, password });
  if (!ok) throw new AppError('mcp_password_invalid');
  const now = new Date();
  await deps.db
    .insert(mcpReauth)
    .values({ sessionId: ctx.session.id, orgId: ctx.orgId, userId: ctx.userId, verifiedAt: now })
    .onConflictDoUpdate({ target: mcpReauth.sessionId, set: { verifiedAt: now } });
  return new Date(now.getTime() + REAUTH_WINDOW_MS);
}
