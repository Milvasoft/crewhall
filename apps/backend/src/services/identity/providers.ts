import { and, asc, count, desc, eq, inArray, max, sql } from 'drizzle-orm';
import {
  externalIdentities,
  identityProviders,
  orgMembers,
  spaces,
  users,
  type DbOrTx,
} from '@crewhall/db';
import {
  IDENTITY_RAW_PATHS,
  IdpRoleMapping,
  LdapConfig,
  OidcIdpConfig,
  SamlIdpConfig,
  type CreateIdentityProvider,
  type IdentityProvider,
  type IdpKind,
  type LinkedIdentity,
  type UpdateIdentityProvider,
} from '@crewhall/shared';
import { z } from 'zod';
import type { Deps } from '../../deps';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { identityAudit } from './audit';
import { decryptSecret, encryptSecret } from './crypto';

export type ProviderRow = typeof identityProviders.$inferSelect;

export type ProviderConfig<K extends IdpKind> = K extends 'oidc'
  ? OidcIdpConfig
  : K extends 'saml'
    ? SamlIdpConfig
    : LdapConfig;

const CONFIG_SCHEMA = { oidc: OidcIdpConfig, saml: SamlIdpConfig, ldap: LdapConfig } as const;

export function parseConfig<K extends IdpKind>(kind: K, value: unknown): ProviderConfig<K> {
  const parsed = CONFIG_SCHEMA[kind].safeParse(value);
  if (!parsed.success) {
    throw new AppError('validation_failed', { in: 'body', issues: parsed.error.issues });
  }
  return parsed.data as ProviderConfig<K>;
}

/** The stored config of a row; rows are written only through parseConfig. */
export const configOf = <K extends IdpKind>(row: ProviderRow & { kind: K }) =>
  CONFIG_SCHEMA[row.kind].parse(row.config) as ProviderConfig<K>;

export const mappingsOf = (row: ProviderRow) =>
  z.array(IdpRoleMapping).catch([]).parse(row.roleMappings);

export function secretOf(env: Env, row: Pick<ProviderRow, 'secretEnc'>): string | null {
  if (!row.secretEnc) return null;
  try {
    return decryptSecret(env.AUTH_SECRET, row.secretEnc);
  } catch {
    return null;
  }
}

const apiBase = (env: Env) => env.API_URL.replace(/\/+$/, '');

export function callbackUrl(env: Env, row: Pick<ProviderRow, 'id' | 'kind'>) {
  if (row.kind === 'oidc') return `${apiBase(env)}${IDENTITY_RAW_PATHS.ssoCallback(row.id)}`;
  if (row.kind === 'saml') return `${apiBase(env)}${IDENTITY_RAW_PATHS.samlAcs(row.id)}`;
  return null;
}

export const samlMetadataUrl = (env: Env, id: string) =>
  `${apiBase(env)}${IDENTITY_RAW_PATHS.samlMetadata(id)}`;
/** SP entity ID: the metadata URL, unique per provider. */
export const samlEntityId = samlMetadataUrl;

export async function toView(db: DbOrTx, env: Env, row: ProviderRow): Promise<IdentityProvider> {
  const [stats] = await db
    .select({ users: count(), lastLoginAt: max(externalIdentities.lastLoginAt) })
    .from(externalIdentities)
    .where(eq(externalIdentities.providerId, row.id));
  return {
    id: row.id,
    kind: row.kind,
    preset: row.preset as IdentityProvider['preset'],
    name: row.name,
    enabled: row.enabled,
    domains: row.domains,
    enforceSso: row.enforceSso,
    jitProvisioning: row.jitProvisioning,
    defaultRole: row.defaultRole,
    linkExistingByEmail: row.linkExistingByEmail,
    trustIdpMfa: row.trustIdpMfa,
    syncRoles: row.syncRoles,
    syncEnabled: row.syncEnabled,
    roleMappings: mappingsOf(row),
    config: configOf(row),
    hasSecret: Boolean(row.secretEnc),
    callbackUrl: callbackUrl(env, row),
    spMetadataUrl: row.kind === 'saml' ? samlMetadataUrl(env, row.id) : null,
    spEntityId: row.kind === 'saml' ? samlEntityId(env, row.id) : null,
    status: {
      linkedUsers: stats?.users ?? 0,
      lastLoginAt: stats?.lastLoginAt?.toISOString() ?? null,
      lastTestAt: row.lastTestAt?.toISOString() ?? null,
      lastTestOk: row.lastTestOk,
      lastError: row.lastError,
      lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
      lastSyncOk: row.lastSyncOk,
      lastSync: row.lastSync
        ? {
            checked: row.lastSync.checked ?? 0,
            updated: row.lastSync.updated ?? 0,
            suspended: row.lastSync.suspended ?? 0,
            reactivated: row.lastSync.reactivated ?? 0,
          }
        : null,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listProviders(db: DbOrTx, orgId: string) {
  return db
    .select()
    .from(identityProviders)
    .where(eq(identityProviders.orgId, orgId))
    .orderBy(asc(identityProviders.position), asc(identityProviders.createdAt));
}

export async function getProvider(db: DbOrTx, orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(identityProviders)
    .where(and(eq(identityProviders.orgId, orgId), eq(identityProviders.id, id)));
  if (!row) throw new AppError('not_found');
  return row;
}

/** Provider by id regardless of org (SSO callbacks carry only the id). */
export async function findProvider(db: DbOrTx, id: string) {
  const [row] = await db.select().from(identityProviders).where(eq(identityProviders.id, id));
  return row ?? null;
}

async function checkMappings(db: DbOrTx, orgId: string, mappings: IdpRoleMapping[]) {
  const spaceIds = [...new Set(mappings.map((m) => m.spaceId).filter((s): s is string => !!s))];
  if (!spaceIds.length) return;
  const rows = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.orgId, orgId), eq(spaces.kind, 'shared'), inArray(spaces.id, spaceIds)));
  const found = new Set(rows.map((r) => r.id));
  const missing = spaceIds.filter((s) => !found.has(s));
  if (missing.length) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: [{ path: ['roleMappings'], code: 'unknown_space', message: missing.join(',') }],
    });
  }
}

export async function createProvider(
  deps: Deps,
  ctx: { orgId: string; userId: string },
  input: CreateIdentityProvider,
  req: RequestInfo,
) {
  const config = parseConfig(input.kind, input.config);
  await checkMappings(deps.db, ctx.orgId, input.roleMappings);
  const secret =
    input.kind === 'oidc'
      ? input.clientSecret
      : input.kind === 'ldap'
        ? input.bindPassword
        : undefined;
  // A public OIDC client (PKCE only) is allowed; an LDAP service account needs its password.
  if (input.kind === 'ldap' && (config as LdapConfig).bindDn && !secret) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: [
        { path: ['bindPassword'], code: 'required', message: 'bindPassword required with bindDn' },
      ],
    });
  }
  const [last] = await deps.db
    .select({ p: max(identityProviders.position) })
    .from(identityProviders)
    .where(eq(identityProviders.orgId, ctx.orgId));
  const [row] = await deps.db
    .insert(identityProviders)
    .values({
      orgId: ctx.orgId,
      kind: input.kind,
      preset: input.preset,
      name: input.name,
      enabled: input.enabled,
      domains: [...new Set(input.domains)],
      enforceSso: input.kind === 'ldap' ? false : input.enforceSso,
      jitProvisioning: input.jitProvisioning,
      defaultRole: input.defaultRole,
      linkExistingByEmail: input.linkExistingByEmail,
      trustIdpMfa: input.kind === 'ldap' ? false : input.trustIdpMfa,
      syncRoles: input.syncRoles,
      syncEnabled: input.kind === 'ldap' ? input.syncEnabled : false,
      roleMappings: input.roleMappings,
      config,
      secretEnc: secret ? encryptSecret(deps.env.AUTH_SECRET, secret) : null,
      position: (last?.p ?? -1) + 1,
      createdBy: ctx.userId,
    })
    .returning();
  if (!row) throw new AppError('internal');
  await identityAudit(
    deps.db,
    {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      action: 'identity.provider.create',
      targetType: 'identity_provider',
      targetId: row.id,
      meta: { kind: row.kind, name: row.name, domains: row.domains, enforceSso: row.enforceSso },
    },
    req,
  );
  return row;
}

export async function updateProvider(
  deps: Deps,
  ctx: { orgId: string; userId: string },
  id: string,
  input: UpdateIdentityProvider,
  req: RequestInfo,
) {
  const row = await getProvider(deps.db, ctx.orgId, id);
  const config = input.config !== undefined ? parseConfig(row.kind, input.config) : undefined;
  if (input.config !== undefined && !CONFIG_SCHEMA[row.kind].safeParse(input.config).success) {
    throw new AppError('idp_kind_mismatch');
  }
  if (input.roleMappings) await checkMappings(deps.db, ctx.orgId, input.roleMappings);
  const secret =
    row.kind === 'oidc' ? input.clientSecret : row.kind === 'ldap' ? input.bindPassword : undefined;
  const patch: Partial<typeof identityProviders.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.domains !== undefined) patch.domains = [...new Set(input.domains)];
  if (input.enforceSso !== undefined && row.kind !== 'ldap') patch.enforceSso = input.enforceSso;
  if (input.jitProvisioning !== undefined) patch.jitProvisioning = input.jitProvisioning;
  if (input.defaultRole !== undefined) patch.defaultRole = input.defaultRole;
  if (input.linkExistingByEmail !== undefined)
    patch.linkExistingByEmail = input.linkExistingByEmail;
  if (input.trustIdpMfa !== undefined && row.kind !== 'ldap') patch.trustIdpMfa = input.trustIdpMfa;
  if (input.syncRoles !== undefined) patch.syncRoles = input.syncRoles;
  if (input.syncEnabled !== undefined && row.kind === 'ldap') patch.syncEnabled = input.syncEnabled;
  if (input.roleMappings !== undefined) patch.roleMappings = input.roleMappings;
  if (config !== undefined) patch.config = config;
  if (secret !== undefined) {
    patch.secretEnc = secret ? encryptSecret(deps.env.AUTH_SECRET, secret) : null;
  }
  const [updated] = await deps.db
    .update(identityProviders)
    .set(patch)
    .where(eq(identityProviders.id, row.id))
    .returning();
  if (!updated) throw new AppError('not_found');
  await identityAudit(
    deps.db,
    {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      action: 'identity.provider.update',
      targetType: 'identity_provider',
      targetId: row.id,
      meta: {
        changed: Object.keys(patch).map((k) => (k === 'secretEnc' ? 'secret' : k)),
        before: { enabled: row.enabled, domains: row.domains, enforceSso: row.enforceSso },
        after: {
          enabled: updated.enabled,
          domains: updated.domains,
          enforceSso: updated.enforceSso,
        },
      },
    },
    req,
  );
  return updated;
}

export async function deleteProvider(
  deps: Deps,
  ctx: { orgId: string; userId: string },
  id: string,
  req: RequestInfo,
) {
  const row = await getProvider(deps.db, ctx.orgId, id);
  await deps.db.delete(identityProviders).where(eq(identityProviders.id, row.id));
  await identityAudit(
    deps.db,
    {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      action: 'identity.provider.delete',
      targetType: 'identity_provider',
      targetId: row.id,
      meta: { kind: row.kind, name: row.name },
    },
    req,
  );
}

export async function recordTest(db: DbOrTx, id: string, ok: boolean, error: string | null) {
  await db
    .update(identityProviders)
    .set({ lastTestAt: new Date(), lastTestOk: ok, lastError: ok ? null : error })
    .where(eq(identityProviders.id, id));
}

export async function listLinked(
  db: DbOrTx,
  orgId: string,
  providerId: string,
  query: { cursor?: string | undefined; limit: number },
): Promise<{ items: LinkedIdentity[]; nextCursor: string | null }> {
  await getProvider(db, orgId, providerId);
  const offset = query.cursor ? Math.max(0, Number.parseInt(query.cursor, 10) || 0) : 0;
  const rows = await db
    .select({ ext: externalIdentities, user: users, status: orgMembers.status })
    .from(externalIdentities)
    .innerJoin(users, eq(users.id, externalIdentities.userId))
    .leftJoin(
      orgMembers,
      and(eq(orgMembers.userId, users.id), eq(orgMembers.organizationId, orgId)),
    )
    .where(eq(externalIdentities.providerId, providerId))
    .orderBy(desc(externalIdentities.lastLoginAt), asc(users.name))
    .limit(query.limit + 1)
    .offset(offset);
  return {
    items: rows.slice(0, query.limit).map(({ ext, user, status }) => ({
      userId: user.id,
      name: user.name,
      email: user.email,
      subject: ext.subject,
      groups: ext.groups,
      directoryStatus: ext.directoryStatus,
      memberStatus: status,
      lastLoginAt: ext.lastLoginAt?.toISOString() ?? null,
      createdAt: ext.createdAt.toISOString(),
    })),
    nextCursor: rows.length > query.limit ? String(offset + query.limit) : null,
  };
}

/** Enabled SSO providers mapped to an e-mail's domain (first wins). */
export function domainOf(email: string) {
  const at = email.lastIndexOf('@');
  return at > 0
    ? email
        .slice(at + 1)
        .trim()
        .toLowerCase()
    : null;
}

export async function providersForDomain(db: DbOrTx, domain: string) {
  return db
    .select()
    .from(identityProviders)
    .where(
      and(eq(identityProviders.enabled, true), sql`${domain} = any(${identityProviders.domains})`),
    )
    .orderBy(asc(identityProviders.position), asc(identityProviders.createdAt));
}
