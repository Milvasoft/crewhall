import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { mobileConnectTokens, mobileHandoffs, organizations, users } from '@crewhall/db';
import {
  browserExtensionOf,
  buildConnectUrl,
  isAllowedHandoffRedirect,
  MOBILE_CONNECT_TTL_SECONDS,
  MOBILE_HANDOFF_TTL_SECONDS,
  type MobileConnectPreview,
  type MobileConnectTicket,
  type MobileHandoffCode,
  type MobileHandoffSession,
} from '@crewhall/shared';
import { makeSignature } from 'better-auth/crypto';
import type { Deps } from '../deps';
import { AppError } from '../http/errors';
import type { AuthSession, RequestInfo } from '../http/types';
import { audit } from './audit';
import { primaryOrg } from './brand';
import { resolveActiveOrg } from './membership';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const newSecret = () => randomBytes(32).toString('base64url');

/**
 * Mobile connect QR (design 12.3): carries the server address and a token that only
 * pre-fills the e-mail on the phone. 5 minutes, single use, stored as sha256.
 */
export async function createConnectTicket(
  deps: Deps,
  userId: string,
  session: AuthSession,
  req: RequestInfo,
): Promise<MobileConnectTicket> {
  const active = await resolveActiveOrg(deps.db, userId, session);
  const token = newSecret();
  const expiresAt = new Date(Date.now() + MOBILE_CONNECT_TTL_SECONDS * 1000);
  const [row] = await deps.db
    .insert(mobileConnectTokens)
    .values({ userId, orgId: active?.org.id ?? null, tokenHash: sha256(token), expiresAt })
    .returning({ id: mobileConnectTokens.id });
  await audit(
    deps.db,
    {
      orgId: active?.org.id ?? null,
      actorId: userId,
      action: 'mobile.connect.create',
      targetType: 'mobile_connect',
      targetId: row?.id,
    },
    req,
  );
  return { url: buildConnectUrl(deps.env.HUB_URL, token), expiresAt: expiresAt.toISOString() };
}

/** Reading the token consumes it; expired or used tokens answer 410 mobile_connect_invalid. */
export async function useConnectTicket(
  deps: Deps,
  token: string,
  req: RequestInfo,
): Promise<MobileConnectPreview> {
  const now = new Date();
  const [row] = await deps.db
    .update(mobileConnectTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(mobileConnectTokens.tokenHash, sha256(token)),
        isNull(mobileConnectTokens.consumedAt),
        gt(mobileConnectTokens.expiresAt, now),
      ),
    )
    .returning();
  if (!row) throw new AppError('mobile_connect_invalid');
  const [user] = await deps.db.select().from(users).where(eq(users.id, row.userId));
  if (!user) throw new AppError('mobile_connect_invalid');
  const org = row.orgId
    ? ((await deps.db.select().from(organizations).where(eq(organizations.id, row.orgId)))[0] ??
      null)
    : await primaryOrg(deps.db);
  await audit(
    deps.db,
    {
      orgId: row.orgId,
      actorId: user.id,
      action: 'mobile.connect.use',
      targetType: 'mobile_connect',
      targetId: row.id,
    },
    req,
  );
  return {
    email: user.email,
    name: user.name,
    orgName: org?.branding.orgName ?? org?.name ?? '',
  };
}

/**
 * Browser → app handoff (docs/contracts/faz-0-kapanis.md §4): a one-time code bound to the
 * app's PKCE S256 challenge, valid for 60 seconds, delivered only to the app's own schemes.
 */
export async function createHandoff(
  deps: Deps,
  userId: string,
  session: AuthSession,
  input: { codeChallenge: string; redirectUri: string },
): Promise<MobileHandoffCode> {
  if (
    !isAllowedHandoffRedirect(input.redirectUri, { production: deps.env.NODE_ENV === 'production' })
  ) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: [
        {
          path: ['redirectUri'],
          code: 'redirect_not_allowed',
          message: 'crewhall: or a listed extension only (exp: outside production)',
        },
      ],
    });
  }
  const active = await resolveActiveOrg(deps.db, userId, session);
  const code = newSecret();
  const expiresAt = new Date(Date.now() + MOBILE_HANDOFF_TTL_SECONDS * 1000);
  await deps.db.insert(mobileHandoffs).values({
    userId,
    orgId: active?.org.id ?? null,
    codeHash: sha256(code),
    codeChallenge: input.codeChallenge,
    redirectUri: input.redirectUri,
    expiresAt,
  });
  return { code, expiresAt: expiresAt.toISOString() };
}

function challengeMatches(challenge: string, verifier: string) {
  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

/**
 * Code + verifier → a new better-auth session for the device and its bearer token
 * (the same value the bearer plugin sends as `set-auth-token`). Any failure, including
 * a wrong verifier, burns the code.
 */
export async function exchangeHandoff(
  deps: Deps,
  input: { code: string; codeVerifier: string },
  req: RequestInfo,
): Promise<MobileHandoffSession> {
  const now = new Date();
  const [row] = await deps.db
    .update(mobileHandoffs)
    .set({ consumedAt: now })
    .where(
      and(
        eq(mobileHandoffs.codeHash, sha256(input.code)),
        isNull(mobileHandoffs.consumedAt),
        gt(mobileHandoffs.expiresAt, now),
      ),
    )
    .returning();
  if (!row || !challengeMatches(row.codeChallenge, input.codeVerifier)) {
    throw new AppError('mobile_handoff_invalid');
  }

  const ctx = await deps.auth.$context;
  const session = await ctx.internalAdapter.createSession(row.userId, false, {
    ipAddress: req.ip,
    userAgent: req.userAgent,
    activeOrganizationId: row.orgId,
  });
  if (!session) throw new AppError('internal');
  const signature = await makeSignature(session.token, ctx.secret);
  await audit(
    deps.db,
    {
      orgId: row.orgId,
      actorId: row.userId,
      action: 'auth.session.new_device',
      targetType: 'session',
      targetId: session.id,
      meta: {
        via: browserExtensionOf(row.redirectUri) ? 'browser_extension' : 'mobile_handoff',
        redirectUri: row.redirectUri,
      },
    },
    req,
  );
  return {
    token: encodeURIComponent(`${session.token}.${signature}`),
    expiresAt: session.expiresAt.toISOString(),
  };
}
