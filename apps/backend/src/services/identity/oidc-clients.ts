import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { oidcClients, spaces, users, type DbOrTx } from '@crewhall/db';
import {
  IDENTITY_RAW_PATHS,
  type CreateOidcClient,
  type OidcClient,
  type OidcProviderInfo,
  type OidcScope,
  type UpdateOidcClient,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { identityAudit } from './audit';
import { OIDC_PREFIX, newSecret, sha256 } from './crypto';
import { activeKey, ensureKey, rotateKey } from './oidc-keys';
import { issuerOf, loginCounts } from './oidc-provider';
import { oidcSettings } from './policy';

type ClientRow = typeof oidcClients.$inferSelect;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:']);

/**
 * 9.13: exact match, no wildcards, no fragment; https, or http only for loopback hosts.
 * Native apps may also use a private-use scheme (`com.example.app:/callback`).
 */
export function validRedirectUri(uri: string, type: ClientRow['type']) {
  if (uri.includes('*')) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname);
  if (type === 'native')
    return !FORBIDDEN_SCHEMES.has(url.protocol) && /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
  return false;
}

function checkUris(list: string[], type: ClientRow['type']) {
  const bad = list.filter((u) => !validRedirectUri(u, type));
  if (bad.length) throw new AppError('oidc_redirect_uri_invalid', { uris: bad });
}

const TR_MAP: Record<string, string> = { ç: 'c', ğ: 'g', ı: 'i', İ: 'i', ö: 'o', ş: 's', ü: 'u' };

export function slugifyClientId(name: string) {
  const base = name
    .replace(/[çğıİöşü]/gi, (ch) => TR_MAP[ch] ?? TR_MAP[ch.toLowerCase()] ?? ch)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50)
    .replace(/^-|-$/g, '');
  return base.length >= 2 ? base : `app-${base || 'client'}`;
}

async function uniqueClientId(db: DbOrTx, wanted: string) {
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? wanted : `${wanted}-${i + 1}`;
    const [taken] = await db
      .select({ id: oidcClients.id })
      .from(oidcClients)
      .where(eq(oidcClients.clientId, candidate));
    if (!taken) return candidate;
  }
  throw new AppError('oidc_client_id_taken');
}

const withOpenid = (scopes: OidcScope[]) => [...new Set<OidcScope>(['openid', ...scopes])];

function newClientSecret() {
  const secret = newSecret(OIDC_PREFIX.secret, 40);
  return { secret, hash: sha256(secret), hint: secret.slice(-4) };
}

const monthsFromNow = (months: number) => {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d;
};

async function checkSpace(db: DbOrTx, orgId: string, spaceId: string) {
  const [row] = await db
    .select({ id: spaces.id, name: spaces.name })
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.orgId, orgId), eq(spaces.kind, 'shared')));
  if (!row) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: [{ path: ['access', 'spaceId'], code: 'unknown_space', message: spaceId }],
    });
  }
  return row;
}

export async function toClientViews(
  db: DbOrTx,
  orgId: string,
  rows: ClientRow[],
): Promise<OidcClient[]> {
  const spaceIds = [...new Set(rows.map((r) => r.accessSpaceId).filter((s): s is string => !!s))];
  const userIds = [...new Set(rows.map((r) => r.lastLoginUserId).filter((s): s is string => !!s))];
  const spaceNames = new Map(
    spaceIds.length
      ? (
          await db
            .select({ id: spaces.id, name: spaces.name })
            .from(spaces)
            .where(inArray(spaces.id, spaceIds))
        ).map((s) => [s.id, s.name])
      : [],
  );
  const userNames = new Map(
    userIds.length
      ? (
          await db
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(inArray(users.id, userIds))
        ).map((u) => [u.id, u.name])
      : [],
  );
  const counts = await loginCounts(
    db,
    orgId,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    name: r.name,
    type: r.type,
    homepageUrl: r.homepageUrl,
    logoUrl: r.logoUrl,
    redirectUris: r.redirectUris,
    postLogoutRedirectUris: r.postLogoutRedirectUris,
    scopes: r.scopes as OidcScope[],
    skipConsent: r.skipConsent,
    access: r.accessSpaceId
      ? {
          kind: 'space' as const,
          spaceId: r.accessSpaceId,
          spaceName: spaceNames.get(r.accessSpaceId) ?? '',
        }
      : { kind: 'all' as const },
    guestsAllowed: r.guestsAllowed,
    enabled: r.enabled,
    secretHint: r.secretHint,
    secretExpiresAt: r.secretExpiresAt?.toISOString() ?? null,
    lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
    lastLoginUser: r.lastLoginUserId
      ? { id: r.lastLoginUserId, name: userNames.get(r.lastLoginUserId) ?? '' }
      : null,
    logins7d: counts.get(r.id) ?? 0,
    createdAt: r.createdAt.toISOString(),
  }));
}

async function getClient(db: DbOrTx, orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(oidcClients)
    // Built-in clients of the Microsoft integrations are managed by their wizard only.
    .where(
      and(eq(oidcClients.orgId, orgId), eq(oidcClients.id, id), isNull(oidcClients.integration)),
    );
  if (!row) throw new AppError('not_found');
  return row;
}

export async function providerInfo(deps: Deps, orgId: string): Promise<OidcProviderInfo> {
  const key = await ensureKey(deps.db, deps.env, orgId);
  const rows = await deps.db
    .select()
    .from(oidcClients)
    .where(and(eq(oidcClients.orgId, orgId), isNull(oidcClients.integration)))
    .orderBy(asc(oidcClients.name));
  const iss = issuerOf(deps.env);
  return {
    issuer: iss,
    discoveryUrl: `${iss}${IDENTITY_RAW_PATHS.oidcDiscovery}`,
    jwksUrl: `${iss}${IDENTITY_RAW_PATHS.oidcJwks}`,
    signingKey: { kid: key.kid, alg: key.alg, createdAt: key.createdAt.toISOString() },
    settings: await oidcSettings(deps.db, orgId),
    clients: await toClientViews(deps.db, orgId, rows),
  };
}

export async function createClient(
  deps: Deps,
  ctx: { orgId: string; userId: string },
  input: CreateOidcClient,
  req: RequestInfo,
) {
  checkUris(input.redirectUris, input.type);
  checkUris(input.postLogoutRedirectUris, input.type);
  if (input.access.kind === 'space') await checkSpace(deps.db, ctx.orgId, input.access.spaceId);
  let clientId: string;
  if (input.clientId) {
    const [taken] = await deps.db
      .select({ id: oidcClients.id })
      .from(oidcClients)
      .where(eq(oidcClients.clientId, input.clientId));
    if (taken) throw new AppError('oidc_client_id_taken');
    clientId = input.clientId;
  } else {
    clientId = await uniqueClientId(deps.db, slugifyClientId(input.name));
  }
  const secret = input.type === 'web' ? newClientSecret() : null;
  const [row] = await deps.db
    .insert(oidcClients)
    .values({
      orgId: ctx.orgId,
      clientId,
      clientSecretHash: secret?.hash ?? null,
      secretHint: secret?.hint ?? null,
      secretExpiresAt: secret ? monthsFromNow(input.secretMonths) : null,
      name: input.name,
      type: input.type,
      homepageUrl: input.homepageUrl,
      logoUrl: input.logoUrl,
      redirectUris: [...new Set(input.redirectUris)],
      postLogoutRedirectUris: [...new Set(input.postLogoutRedirectUris)],
      scopes: withOpenid(input.scopes),
      skipConsent: input.skipConsent,
      accessSpaceId: input.access.kind === 'space' ? input.access.spaceId : null,
      guestsAllowed: input.guestsAllowed,
      createdBy: ctx.userId,
    })
    .returning();
  if (!row) throw new AppError('internal');
  await ensureKey(deps.db, deps.env, ctx.orgId);
  await identityAudit(
    deps.db,
    {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      action: 'oidc.client.create',
      targetType: 'oidc_client',
      targetId: row.id,
      meta: {
        name: row.name,
        clientId,
        type: row.type,
        redirectUris: row.redirectUris,
        scopes: row.scopes,
      },
    },
    req,
  );
  const [view] = await toClientViews(deps.db, ctx.orgId, [row]);
  return { client: view!, clientSecret: secret?.secret ?? null };
}

export async function updateClient(
  deps: Deps,
  ctx: { orgId: string; userId: string },
  id: string,
  input: UpdateOidcClient,
  req: RequestInfo,
) {
  const row = await getClient(deps.db, ctx.orgId, id);
  if (input.redirectUris) checkUris(input.redirectUris, row.type);
  if (input.postLogoutRedirectUris) checkUris(input.postLogoutRedirectUris, row.type);
  if (input.access?.kind === 'space') await checkSpace(deps.db, ctx.orgId, input.access.spaceId);
  const patch: Partial<typeof oidcClients.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.homepageUrl !== undefined) patch.homepageUrl = input.homepageUrl;
  if (input.logoUrl !== undefined) patch.logoUrl = input.logoUrl;
  if (input.redirectUris) patch.redirectUris = [...new Set(input.redirectUris)];
  if (input.postLogoutRedirectUris)
    patch.postLogoutRedirectUris = [...new Set(input.postLogoutRedirectUris)];
  if (input.scopes) patch.scopes = withOpenid(input.scopes);
  if (input.skipConsent !== undefined) patch.skipConsent = input.skipConsent;
  if (input.access)
    patch.accessSpaceId = input.access.kind === 'space' ? input.access.spaceId : null;
  if (input.guestsAllowed !== undefined) patch.guestsAllowed = input.guestsAllowed;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  const [updated] = await deps.db
    .update(oidcClients)
    .set(patch)
    .where(eq(oidcClients.id, row.id))
    .returning();
  if (!updated) throw new AppError('not_found');
  await identityAudit(
    deps.db,
    {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      action: 'oidc.client.update',
      targetType: 'oidc_client',
      targetId: row.id,
      meta: {
        changed: Object.keys(patch),
        before: { enabled: row.enabled, redirectUris: row.redirectUris, scopes: row.scopes },
        after: {
          enabled: updated.enabled,
          redirectUris: updated.redirectUris,
          scopes: updated.scopes,
        },
      },
    },
    req,
  );
  const [view] = await toClientViews(deps.db, ctx.orgId, [updated]);
  return view!;
}

export async function deleteClient(
  deps: Deps,
  ctx: { orgId: string; userId: string },
  id: string,
  req: RequestInfo,
) {
  const row = await getClient(deps.db, ctx.orgId, id);
  await deps.db.delete(oidcClients).where(eq(oidcClients.id, row.id));
  await identityAudit(
    deps.db,
    {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      action: 'oidc.client.delete',
      targetType: 'oidc_client',
      targetId: row.id,
      meta: { name: row.name, clientId: row.clientId },
    },
    req,
  );
}

export async function rotateClientSecret(
  deps: Deps,
  ctx: { orgId: string; userId: string },
  id: string,
  req: RequestInfo,
) {
  const row = await getClient(deps.db, ctx.orgId, id);
  if (row.type !== 'web') {
    throw new AppError('validation_failed', {
      in: 'params',
      issues: [
        { path: ['oidcClientId'], code: 'public_client', message: 'public clients have no secret' },
      ],
    });
  }
  const secret = newClientSecret();
  const expiresAt = monthsFromNow(12);
  await deps.db
    .update(oidcClients)
    .set({ clientSecretHash: secret.hash, secretHint: secret.hint, secretExpiresAt: expiresAt })
    .where(eq(oidcClients.id, row.id));
  await identityAudit(
    deps.db,
    {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      action: 'oidc.client.secret_rotate',
      targetType: 'oidc_client',
      targetId: row.id,
      meta: { clientId: row.clientId },
    },
    req,
  );
  return { clientSecret: secret.secret, expiresAt: expiresAt.toISOString() };
}

export async function rotateSigningKey(
  deps: Deps,
  ctx: { orgId: string; userId: string },
  req: RequestInfo,
) {
  const before = await activeKey(deps.db, ctx.orgId);
  const key = await rotateKey(deps.db, deps.env, ctx.orgId);
  await identityAudit(
    deps.db,
    {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      action: 'oidc.key.rotate',
      targetType: 'oidc_key',
      targetId: key.id,
      meta: { from: before?.kid ?? null, to: key.kid },
    },
    req,
  );
}
