import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  externalIdentities,
  identityProviders,
  orgMembers,
  scimGroupMembers,
  scimGroups,
  scimTokens,
  scimUsers,
  sessions,
  users,
  type DbOrTx,
} from '@crewhall/db';
import type { CreateScimToken } from '@crewhall/shared';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { AppEnv, RequestInfo } from '../../http/types';
import { identityAudit } from '../identity/audit';
import { newSecret, sha256 } from '../identity/crypto';
import { mappingsOf, type ProviderRow } from '../identity/providers';
import { applyRoles, provisionUser, resolveRoles, userCreatorOf } from '../identity/provision';
import { integrationEnabled } from './app';

/**
 * SCIM 2.0 server (RFC 7643 / 7644) for Entra ID provisioning: Entra creates, updates,
 * deactivates and deletes people and pushes groups; group names (and Entra object ids) feed
 * the role mappings of the token's identity provider. The SCIM id of a user is the Crewhall
 * user id. Deactivation and DELETE suspend the membership and end the person's sessions;
 * nobody is ever deleted from Crewhall, and the org owner is never suspended.
 */

export const SCIM_TOKEN_PREFIX = 'mhscim_';
const SCIM_JSON = 'application/scim+json';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const MAX_RESULTS = 200;

type ProviderLike = ProviderRow;

class ScimFailure extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly scimType?: string,
  ) {
    super(detail);
  }
}

function scimJson(c: Context<AppEnv>, body: unknown, status = 200) {
  return c.body(JSON.stringify(body), status as 200, { 'content-type': SCIM_JSON });
}

function scimError(c: Context<AppEnv>, err: ScimFailure) {
  return scimJson(
    c,
    {
      schemas: [ERROR],
      status: String(err.status),
      detail: err.detail,
      ...(err.scimType ? { scimType: err.scimType } : {}),
    },
    err.status,
  );
}

// ---- tokens --------------------------------------------------------------------------------

export async function createScimToken(
  db: DbOrTx,
  ctx: { orgId: string; userId: string },
  input: CreateScimToken,
  req: RequestInfo,
) {
  const [provider] = await db
    .select()
    .from(identityProviders)
    .where(and(eq(identityProviders.id, input.providerId), eq(identityProviders.orgId, ctx.orgId)));
  if (!provider || provider.kind === 'ldap') throw new AppError('not_found');
  const secret = newSecret(SCIM_TOKEN_PREFIX, 40);
  const [row] = await db
    .insert(scimTokens)
    .values({
      orgId: ctx.orgId,
      providerId: provider.id,
      name: input.name,
      tokenHash: sha256(secret),
      hint: secret.slice(-4),
      createdBy: ctx.userId,
    })
    .returning();
  await identityAudit(
    db,
    {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      action: 'microsoft.scim_token.create',
      targetType: 'scim_token',
      targetId: row!.id,
      meta: { name: input.name, provider: provider.id },
    },
    req,
  );
  return {
    token: {
      id: row!.id,
      name: row!.name,
      providerId: provider.id,
      providerName: provider.name,
      hint: row!.hint,
      createdAt: row!.createdAt.toISOString(),
      lastUsedAt: null,
    },
    secret,
  };
}

export async function revokeScimToken(
  db: DbOrTx,
  ctx: { orgId: string; userId: string },
  tokenId: string,
  req: RequestInfo,
) {
  const [row] = await db
    .update(scimTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(scimTokens.id, tokenId),
        eq(scimTokens.orgId, ctx.orgId),
        isNull(scimTokens.revokedAt),
      ),
    )
    .returning({ id: scimTokens.id });
  if (!row) throw new AppError('not_found');
  await identityAudit(
    db,
    {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      action: 'microsoft.scim_token.revoke',
      targetType: 'scim_token',
      targetId: tokenId,
    },
    req,
  );
}

interface ScimCtx {
  deps: Deps;
  c: Context<AppEnv>;
  provider: ProviderLike;
  orgId: string;
  req: RequestInfo;
}

async function authenticate(deps: Deps, c: Context<AppEnv>, req: RequestInfo): Promise<ScimCtx> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
  if (!bearer.startsWith(SCIM_TOKEN_PREFIX)) throw new ScimFailure(401, 'Missing or invalid token');
  const [row] = await deps.db
    .select({ token: scimTokens, provider: identityProviders })
    .from(scimTokens)
    .innerJoin(identityProviders, eq(identityProviders.id, scimTokens.providerId))
    .where(and(eq(scimTokens.tokenHash, sha256(bearer)), isNull(scimTokens.revokedAt)));
  if (!row) throw new ScimFailure(401, 'Missing or invalid token');
  if (!(await integrationEnabled(deps.db, row.token.orgId, 'entra'))) {
    throw new ScimFailure(403, 'Entra ID provisioning is switched off in Crewhall');
  }
  const last = row.token.lastUsedAt?.getTime() ?? 0;
  if (Date.now() - last > 60_000) {
    await deps.db
      .update(scimTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(scimTokens.id, row.token.id));
  }
  return { deps, c, provider: row.provider, orgId: row.token.orgId, req };
}

// ---- input parsing -------------------------------------------------------------------------

const Email = z.object({
  value: z.string(),
  type: z.string().optional(),
  primary: z.union([z.boolean(), z.string()]).optional(),
});
const ScimUserIn = z.looseObject({
  userName: z.string().trim().min(1).max(320),
  externalId: z.string().max(500).nullish(),
  displayName: z.string().max(200).nullish(),
  name: z
    .looseObject({
      formatted: z.string().max(200).nullish(),
      givenName: z.string().max(200).nullish(),
      familyName: z.string().max(200).nullish(),
    })
    .nullish(),
  emails: z.array(Email).max(20).nullish(),
  active: z.union([z.boolean(), z.string()]).nullish(),
});
type ScimUserIn = z.infer<typeof ScimUserIn>;

const ScimGroupIn = z.looseObject({
  displayName: z.string().trim().min(1).max(256),
  externalId: z.string().max(500).nullish(),
  members: z
    .array(z.looseObject({ value: z.string() }))
    .max(10_000)
    .nullish(),
});

const PatchOp = z.object({
  schemas: z.array(z.string()).optional(),
  Operations: z
    .array(
      z.looseObject({
        op: z.string(),
        path: z.string().optional(),
        value: z.unknown().optional(),
      }),
    )
    .min(1)
    .max(1000),
});

const truthy = (v: unknown) => v === true || (typeof v === 'string' && v.toLowerCase() === 'true');

async function readJson<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = JSON.parse(await c.req.text());
  } catch {
    throw new ScimFailure(400, 'Body is not JSON', 'invalidSyntax');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ScimFailure(
      400,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      'invalidValue',
    );
  }
  return parsed.data;
}

function primaryEmail(input: Pick<ScimUserIn, 'emails' | 'userName'>) {
  const list = input.emails ?? [];
  const chosen =
    list.find((e) => truthy(e.primary)) ?? list.find((e) => e.type === 'work') ?? list[0];
  const value = chosen?.value ?? (input.userName.includes('@') ? input.userName : null);
  return value?.trim().toLowerCase() || null;
}

function displayNameOf(input: Pick<ScimUserIn, 'displayName' | 'name' | 'userName'>) {
  const n = input.name;
  return (
    input.displayName?.trim() ||
    n?.formatted?.trim() ||
    [n?.givenName, n?.familyName].filter(Boolean).join(' ').trim() ||
    input.userName.split('@')[0]!
  );
}

/** `attr eq "value"`; the only filter Entra sends. */
function parseFilter(filter: string | undefined): { attr: string; value: string } | null {
  if (!filter) return null;
  const m = /^\s*([\w.:[\]" ]+?)\s+eq\s+"((?:\\.|[^"\\])*)"\s*$/i.exec(filter);
  if (!m) throw new ScimFailure(400, `Unsupported filter: ${filter}`, 'invalidFilter');
  return { attr: m[1]!.replace(/\s+/g, ' ').toLowerCase(), value: m[2]!.replace(/\\(.)/g, '$1') };
}

function paging(c: Context<AppEnv>) {
  const start = Math.max(1, Number(c.req.query('startIndex') ?? 1) || 1);
  const countRaw = c.req.query('count');
  const n = countRaw === undefined ? MAX_RESULTS : Number(countRaw);
  return { start, count: Math.max(0, Math.min(MAX_RESULTS, Number.isFinite(n) ? n : MAX_RESULTS)) };
}

function listResponse(c: Context<AppEnv>, resources: unknown[], total: number, start: number) {
  return scimJson(c, {
    schemas: [LIST],
    totalResults: total,
    startIndex: start,
    itemsPerPage: resources.length,
    Resources: resources,
  });
}

// ---- users ---------------------------------------------------------------------------------

type ScimUserRow = typeof scimUsers.$inferSelect;
type UserRow = typeof users.$inferSelect;
type MemberRow = typeof orgMembers.$inferSelect;

interface Person {
  user: UserRow;
  member: MemberRow;
  scim: ScimUserRow | null;
}

async function personById(ctx: ScimCtx, userId: string): Promise<Person | null> {
  if (!z.uuid().safeParse(userId).success) return null;
  const [row] = await ctx.deps.db
    .select({ user: users, member: orgMembers, scim: scimUsers })
    .from(users)
    .innerJoin(
      orgMembers,
      and(eq(orgMembers.userId, users.id), eq(orgMembers.organizationId, ctx.orgId)),
    )
    .leftJoin(
      scimUsers,
      and(eq(scimUsers.userId, users.id), eq(scimUsers.providerId, ctx.provider.id)),
    )
    .where(eq(users.id, userId));
  if (!row || row.scim?.deletedAt) return null;
  return row;
}

async function groupsOfUsers(db: DbOrTx, providerId: string, userIds: string[]) {
  const out = new Map<string, { id: string; displayName: string; externalId: string | null }[]>();
  if (!userIds.length) return out;
  const rows = await db
    .select({ userId: scimGroupMembers.userId, group: scimGroups })
    .from(scimGroupMembers)
    .innerJoin(scimGroups, eq(scimGroups.id, scimGroupMembers.groupId))
    .where(and(eq(scimGroups.providerId, providerId), inArray(scimGroupMembers.userId, userIds)));
  for (const r of rows) {
    const list = out.get(r.userId) ?? [];
    list.push({ id: r.group.id, displayName: r.group.displayName, externalId: r.group.externalId });
    out.set(r.userId, list);
  }
  return out;
}

function userResource(ctx: ScimCtx, p: Person, groups: { id: string; displayName: string }[]) {
  const base = ctx.deps.env.API_URL.replace(/\/+$/, '');
  return {
    schemas: [USER],
    id: p.user.id,
    externalId: p.scim?.externalId ?? undefined,
    userName: p.scim?.userName ?? p.user.email,
    displayName: p.user.name,
    name: { formatted: p.user.name },
    emails: [{ value: p.user.email, type: 'work', primary: true }],
    active: p.member.status === 'active' && (p.scim?.active ?? true),
    groups: groups.map((g) => ({ value: g.id, display: g.displayName })),
    meta: {
      resourceType: 'User',
      created: (p.scim?.createdAt ?? p.user.createdAt).toISOString(),
      lastModified: (p.scim?.updatedAt ?? p.user.updatedAt).toISOString(),
      location: `${base}/api/scim/v2/Users/${p.user.id}`,
    },
  };
}

async function sendUser(ctx: ScimCtx, p: Person, status = 200) {
  const groups =
    (await groupsOfUsers(ctx.deps.db, ctx.provider.id, [p.user.id])).get(p.user.id) ?? [];
  const body = userResource(ctx, p, groups);
  if (status === 201) ctx.c.header('Location', body.meta.location);
  return scimJson(ctx.c, body, status);
}

/** Suspends or reactivates the membership the way the directory sync does. */
async function setActive(ctx: ScimCtx, p: Person, active: boolean) {
  const { db } = ctx.deps;
  if (!active && p.member.status === 'active' && p.member.role !== 'owner') {
    await db.transaction(async (tx) => {
      await tx
        .update(orgMembers)
        .set({ status: 'suspended' })
        .where(eq(orgMembers.id, p.member.id));
      await tx
        .update(externalIdentities)
        .set({ directoryStatus: 'disabled', suspendedBySync: true })
        .where(
          and(
            eq(externalIdentities.providerId, ctx.provider.id),
            eq(externalIdentities.userId, p.user.id),
          ),
        );
      // Signed-in devices lose access at once.
      await tx
        .delete(sessions)
        .where(and(eq(sessions.userId, p.user.id), eq(sessions.activeOrganizationId, ctx.orgId)));
      await identityAudit(
        tx,
        {
          orgId: ctx.orgId,
          actorId: null,
          action: 'identity.user.suspend',
          targetType: 'user',
          targetId: p.user.id,
          meta: { provider: ctx.provider.id, reason: 'scim' },
        },
        ctx.req,
      );
    });
    p.member = { ...p.member, status: 'suspended' };
  } else if (active && p.member.status === 'suspended') {
    const [link] = await db
      .select()
      .from(externalIdentities)
      .where(
        and(
          eq(externalIdentities.providerId, ctx.provider.id),
          eq(externalIdentities.userId, p.user.id),
        ),
      );
    // An admin's suspension stands; only what provisioning suspended comes back.
    if (link?.suspendedBySync) {
      await db.transaction(async (tx) => {
        await tx.update(orgMembers).set({ status: 'active' }).where(eq(orgMembers.id, p.member.id));
        await tx
          .update(externalIdentities)
          .set({ directoryStatus: 'active', suspendedBySync: false })
          .where(eq(externalIdentities.id, link.id));
        await identityAudit(
          tx,
          {
            orgId: ctx.orgId,
            actorId: null,
            action: 'identity.user.reactivate',
            targetType: 'user',
            targetId: p.user.id,
            meta: { provider: ctx.provider.id, via: 'scim' },
          },
          ctx.req,
        );
      });
      p.member = { ...p.member, status: 'active' };
    }
  }
}

interface UserChange {
  userName?: string;
  externalId?: string | null;
  displayName?: string;
  email?: string;
  active?: boolean;
}

async function applyUserChange(ctx: ScimCtx, p: Person, change: UserChange) {
  const { db } = ctx.deps;
  if (change.userName && change.userName.toLowerCase() !== p.scim?.userName.toLowerCase()) {
    const [taken] = await db
      .select({ id: scimUsers.id })
      .from(scimUsers)
      .where(
        and(
          eq(scimUsers.providerId, ctx.provider.id),
          sql`lower(${scimUsers.userName}) = ${change.userName.toLowerCase()}`,
          sql`${scimUsers.userId} <> ${p.user.id}`,
        ),
      );
    if (taken) throw new ScimFailure(409, 'userName is already taken', 'uniqueness');
  }
  const scimValues = {
    userName: change.userName ?? p.scim?.userName ?? p.user.email,
    externalId: change.externalId !== undefined ? change.externalId : (p.scim?.externalId ?? null),
    active: change.active ?? p.scim?.active ?? true,
    deletedAt: null,
    updatedAt: new Date(),
  };
  const [scim] = await db
    .insert(scimUsers)
    .values({ orgId: ctx.orgId, providerId: ctx.provider.id, userId: p.user.id, ...scimValues })
    .onConflictDoUpdate({ target: [scimUsers.providerId, scimUsers.userId], set: scimValues })
    .returning();
  p.scim = scim!;
  if (change.displayName && change.displayName !== p.user.name) {
    await db.update(users).set({ name: change.displayName }).where(eq(users.id, p.user.id));
    p.user = { ...p.user, name: change.displayName };
  }
  if (change.email && change.email !== p.user.email.toLowerCase()) {
    // Only when the address is free; the sign-in name never moves onto someone else.
    const [other] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`${users.email} = ${change.email}`);
    if (!other) {
      await db.update(users).set({ email: change.email }).where(eq(users.id, p.user.id));
      p.user = { ...p.user, email: change.email };
    }
  }
  if (change.active !== undefined) await setActive(ctx, p, change.active);
}

/** The person with this e-mail in the org (adopted on first write when SCIM did not create them). */
async function memberByEmail(ctx: ScimCtx, email: string): Promise<Person | null> {
  const [row] = await ctx.deps.db
    .select({ user: users, member: orgMembers, scim: scimUsers })
    .from(users)
    .innerJoin(
      orgMembers,
      and(eq(orgMembers.userId, users.id), eq(orgMembers.organizationId, ctx.orgId)),
    )
    .leftJoin(
      scimUsers,
      and(eq(scimUsers.userId, users.id), eq(scimUsers.providerId, ctx.provider.id)),
    )
    .where(sql`${users.email} = ${email}`);
  return row ?? null;
}

async function createUser(ctx: ScimCtx) {
  const input = await readJson(ctx.c, ScimUserIn);
  const email = primaryEmail(input);
  if (!email) throw new ScimFailure(400, 'An e-mail address is required', 'invalidValue');
  const [taken] = await ctx.deps.db
    .select({ userId: scimUsers.userId, deletedAt: scimUsers.deletedAt })
    .from(scimUsers)
    .where(
      and(
        eq(scimUsers.providerId, ctx.provider.id),
        sql`lower(${scimUsers.userName}) = ${input.userName.toLowerCase()}`,
      ),
    );
  if (taken && !taken.deletedAt)
    throw new ScimFailure(409, 'userName is already taken', 'uniqueness');

  let person = await memberByEmail(ctx, email);
  if (!person) {
    // New to the org: the same path as a first SSO sign-in (JIT, mappings, personal space).
    const provider = { ...ctx.provider, jitProvisioning: true, linkExistingByEmail: true };
    let result;
    try {
      result = await provisionUser(
        ctx.deps,
        userCreatorOf(ctx.deps),
        provider,
        {
          subject: input.externalId ?? input.userName,
          email,
          emailVerified: true,
          name: displayNameOf(input),
          groups: [],
        },
        ctx.req,
        { scim: true },
      );
    } catch (err) {
      if (err instanceof AppError) throw new ScimFailure(409, err.code, 'uniqueness');
      throw err;
    }
    person = await personById(ctx, result.userId);
    if (!person) throw new ScimFailure(500, 'Provisioning failed');
  } else {
    // Already a member: link the provider so SSO and deactivation apply.
    await ctx.deps.db
      .insert(externalIdentities)
      .values({
        orgId: ctx.orgId,
        providerId: ctx.provider.id,
        userId: person.user.id,
        subject: input.externalId ?? input.userName,
        email,
      })
      .onConflictDoNothing();
  }
  await applyUserChange(ctx, person, {
    userName: input.userName,
    externalId: input.externalId ?? null,
    displayName: displayNameOf(input),
    email,
    active: input.active === undefined || input.active === null ? true : truthy(input.active),
  });
  return sendUser(ctx, person, 201);
}

async function replaceUser(ctx: ScimCtx, p: Person) {
  const input = await readJson(ctx.c, ScimUserIn);
  await applyUserChange(ctx, p, {
    userName: input.userName,
    externalId: input.externalId ?? null,
    displayName: displayNameOf(input),
    email: primaryEmail(input) ?? undefined,
    active: input.active === undefined || input.active === null ? true : truthy(input.active),
  });
  return sendUser(ctx, p);
}

/** Entra's PatchOp shapes: path-less value objects, `name.givenName`, `emails[type eq "work"].value`. */
function userPatch(ops: z.infer<typeof PatchOp>['Operations']): UserChange {
  const change: UserChange = {};
  let given: string | null | undefined;
  let family: string | null | undefined;
  let formatted: string | null | undefined;
  const set = (rawPath: string, value: unknown, remove: boolean) => {
    const path = rawPath
      .replace(/^urn:ietf:params:scim:schemas:core:2\.0:User:/i, '')
      .toLowerCase();
    const str = typeof value === 'string' ? value : null;
    if (path === 'active') change.active = remove ? false : truthy(value);
    else if (path === 'username' && str) change.userName = str.trim();
    else if (path === 'externalid') change.externalId = remove ? null : str;
    else if (path === 'displayname' && str) change.displayName = str.trim();
    else if (path === 'name.givenname') given = remove ? null : str;
    else if (path === 'name.familyname') family = remove ? null : str;
    else if (path === 'name.formatted') formatted = remove ? null : str;
    else if (path === 'name' && value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      if (typeof v.givenName === 'string') given = v.givenName;
      if (typeof v.familyName === 'string') family = v.familyName;
      if (typeof v.formatted === 'string') formatted = v.formatted;
    } else if (/^emails(\[.*\])?(\.value)?$/.test(path)) {
      if (str) change.email = str.trim().toLowerCase();
      else if (Array.isArray(value)) {
        const parsed = z.array(Email).safeParse(value);
        const email = parsed.success ? primaryEmail({ emails: parsed.data, userName: '' }) : null;
        if (email) change.email = email;
      }
    }
    // Other attributes (enterprise extension, phone numbers, titles) are not kept.
  };
  for (const op of ops) {
    const kind = op.op.toLowerCase();
    if (!['add', 'replace', 'remove'].includes(kind)) {
      throw new ScimFailure(400, `Unsupported op ${op.op}`, 'invalidSyntax');
    }
    if (op.path) set(op.path, op.value, kind === 'remove');
    else if (op.value && typeof op.value === 'object' && !Array.isArray(op.value)) {
      for (const [k, v] of Object.entries(op.value as Record<string, unknown>)) set(k, v, false);
    }
  }
  if (given !== undefined || family !== undefined || formatted !== undefined) {
    const name = formatted?.trim() || [given, family].filter(Boolean).join(' ').trim() || undefined;
    if (name && !change.displayName) change.displayName = name;
  }
  return change;
}

async function patchUser(ctx: ScimCtx, p: Person) {
  const body = await readJson(ctx.c, PatchOp);
  await applyUserChange(ctx, p, userPatch(body.Operations));
  return sendUser(ctx, p);
}

async function deleteUser(ctx: ScimCtx, p: Person) {
  await setActive(ctx, p, false);
  await ctx.deps.db
    .insert(scimUsers)
    .values({
      orgId: ctx.orgId,
      providerId: ctx.provider.id,
      userId: p.user.id,
      userName: p.scim?.userName ?? p.user.email,
      active: false,
      deletedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [scimUsers.providerId, scimUsers.userId],
      set: { active: false, deletedAt: new Date(), updatedAt: new Date() },
    });
  await ctx.deps.db
    .update(externalIdentities)
    .set({ directoryStatus: 'missing' })
    .where(
      and(
        eq(externalIdentities.providerId, ctx.provider.id),
        eq(externalIdentities.userId, p.user.id),
      ),
    );
  return ctx.c.body(null, 204);
}

async function listUsers(ctx: ScimCtx) {
  const filter = parseFilter(ctx.c.req.query('filter'));
  const { start, count } = paging(ctx.c);
  const { db } = ctx.deps;
  let people: Person[];
  if (!filter) {
    const rows = await db
      .select({ user: users, member: orgMembers, scim: scimUsers })
      .from(scimUsers)
      .innerJoin(users, eq(users.id, scimUsers.userId))
      .innerJoin(
        orgMembers,
        and(eq(orgMembers.userId, users.id), eq(orgMembers.organizationId, ctx.orgId)),
      )
      .where(and(eq(scimUsers.providerId, ctx.provider.id), isNull(scimUsers.deletedAt)))
      .orderBy(asc(scimUsers.createdAt));
    people = rows;
  } else {
    const { attr, value } = filter;
    const lower = value.toLowerCase();
    const base = db
      .select({ user: users, member: orgMembers, scim: scimUsers })
      .from(users)
      .innerJoin(
        orgMembers,
        and(eq(orgMembers.userId, users.id), eq(orgMembers.organizationId, ctx.orgId)),
      )
      .leftJoin(
        scimUsers,
        and(eq(scimUsers.userId, users.id), eq(scimUsers.providerId, ctx.provider.id)),
      );
    let where;
    if (attr === 'username') {
      // A member SCIM did not create yet matches by e-mail (Entra then PATCHes instead of POSTing).
      where = sql`(lower(${scimUsers.userName}) = ${lower} or (${scimUsers.id} is null and ${users.email} = ${lower}))`;
    } else if (attr === 'externalid') {
      where = eq(scimUsers.externalId, value);
    } else if (attr === 'id') {
      where = z.uuid().safeParse(value).success ? eq(users.id, value) : sql`false`;
    } else if (/^emails(\[type eq "?\w+"?\])?(\.value)?$/.test(attr)) {
      where = sql`${users.email} = ${lower}`;
    } else if (attr === 'displayname') {
      where = sql`lower(${users.name}) = ${lower}`;
    } else {
      throw new ScimFailure(400, `Unsupported filter attribute ${attr}`, 'invalidFilter');
    }
    people = (await base.where(where)).filter((r) => !r.scim?.deletedAt);
  }
  const pageRows = people.slice(start - 1, start - 1 + count);
  const groups = await groupsOfUsers(
    db,
    ctx.provider.id,
    pageRows.map((p) => p.user.id),
  );
  return listResponse(
    ctx.c,
    pageRows.map((p) => userResource(ctx, p, groups.get(p.user.id) ?? [])),
    people.length,
    start,
  );
}

// ---- groups --------------------------------------------------------------------------------

type GroupRow = typeof scimGroups.$inferSelect;

async function groupById(ctx: ScimCtx, id: string) {
  if (!z.uuid().safeParse(id).success) return null;
  const [row] = await ctx.deps.db
    .select()
    .from(scimGroups)
    .where(and(eq(scimGroups.id, id), eq(scimGroups.providerId, ctx.provider.id)));
  return row ?? null;
}

async function groupResource(ctx: ScimCtx, g: GroupRow, withMembers: boolean) {
  const base = ctx.deps.env.API_URL.replace(/\/+$/, '');
  const members = withMembers
    ? await ctx.deps.db
        .select({ id: users.id, name: users.name })
        .from(scimGroupMembers)
        .innerJoin(users, eq(users.id, scimGroupMembers.userId))
        .where(eq(scimGroupMembers.groupId, g.id))
    : [];
  return {
    schemas: [GROUP],
    id: g.id,
    displayName: g.displayName,
    externalId: g.externalId ?? undefined,
    ...(withMembers ? { members: members.map((m) => ({ value: m.id, display: m.name })) } : {}),
    meta: {
      resourceType: 'Group',
      created: g.createdAt.toISOString(),
      lastModified: g.updatedAt.toISOString(),
      location: `${base}/api/scim/v2/Groups/${g.id}`,
    },
  };
}

/** Member ids that are people of this org; unknown ids are ignored (Entra may push them first). */
async function orgUserIds(ctx: ScimCtx, ids: string[]) {
  const valid = ids.filter((id) => z.uuid().safeParse(id).success);
  if (!valid.length) return [];
  const rows = await ctx.deps.db
    .select({ id: orgMembers.userId })
    .from(orgMembers)
    .where(and(eq(orgMembers.organizationId, ctx.orgId), inArray(orgMembers.userId, valid)));
  return rows.map((r) => r.id);
}

/**
 * The person's groups for the role mappings: SCIM group names and Entra object ids, together
 * with the groups the last sign-in reported. Re-applies the provider's mappings.
 */
async function resync(ctx: ScimCtx, userIds: string[]) {
  const { db } = ctx.deps;
  if (!userIds.length) return;
  const groups = await groupsOfUsers(db, ctx.provider.id, userIds);
  const mappings = mappingsOf(ctx.provider);
  for (const userId of new Set(userIds)) {
    const list = groups.get(userId) ?? [];
    const names = [
      ...new Set(list.flatMap((g) => [g.displayName, ...(g.externalId ? [g.externalId] : [])])),
    ];
    await db
      .update(externalIdentities)
      .set({ groups: names })
      .where(
        and(
          eq(externalIdentities.providerId, ctx.provider.id),
          eq(externalIdentities.userId, userId),
        ),
      );
    if (!ctx.provider.syncRoles || !mappings.length) continue;
    const [member] = await db
      .select()
      .from(orgMembers)
      .where(and(eq(orgMembers.organizationId, ctx.orgId), eq(orgMembers.userId, userId)));
    if (!member || member.status !== 'active') continue;
    await applyRoles(db, ctx.provider, userId, resolveRoles(mappings, names), member, ctx.req);
  }
}

async function setMembers(
  ctx: ScimCtx,
  g: GroupRow,
  add: string[],
  remove: string[],
  replace?: string[],
) {
  const { db } = ctx.deps;
  const before = (
    await db
      .select({ userId: scimGroupMembers.userId })
      .from(scimGroupMembers)
      .where(eq(scimGroupMembers.groupId, g.id))
  ).map((r) => r.userId);
  const touched = new Set<string>();
  if (replace) {
    const want = new Set(await orgUserIds(ctx, replace));
    const drop = before.filter((u) => !want.has(u));
    if (drop.length) {
      await db
        .delete(scimGroupMembers)
        .where(and(eq(scimGroupMembers.groupId, g.id), inArray(scimGroupMembers.userId, drop)));
    }
    add = [...want];
    drop.forEach((u) => touched.add(u));
  }
  const adding = await orgUserIds(ctx, add);
  if (adding.length) {
    await db
      .insert(scimGroupMembers)
      .values(adding.map((userId) => ({ groupId: g.id, userId })))
      .onConflictDoNothing();
    adding.filter((u) => !before.includes(u)).forEach((u) => touched.add(u));
  }
  const removing = remove.filter((u) => z.uuid().safeParse(u).success);
  if (removing.length) {
    await db
      .delete(scimGroupMembers)
      .where(and(eq(scimGroupMembers.groupId, g.id), inArray(scimGroupMembers.userId, removing)));
    removing.filter((u) => before.includes(u)).forEach((u) => touched.add(u));
  }
  await db.update(scimGroups).set({ updatedAt: new Date() }).where(eq(scimGroups.id, g.id));
  return [...touched];
}

async function allMembers(db: DbOrTx, groupId: string) {
  return (
    await db
      .select({ userId: scimGroupMembers.userId })
      .from(scimGroupMembers)
      .where(eq(scimGroupMembers.groupId, groupId))
  ).map((r) => r.userId);
}

async function createGroup(ctx: ScimCtx) {
  const input = await readJson(ctx.c, ScimGroupIn);
  const { db } = ctx.deps;
  if (input.externalId) {
    const [dup] = await db
      .select({ id: scimGroups.id })
      .from(scimGroups)
      .where(
        and(
          eq(scimGroups.providerId, ctx.provider.id),
          eq(scimGroups.externalId, input.externalId),
        ),
      );
    if (dup) throw new ScimFailure(409, 'Group already exists', 'uniqueness');
  }
  const [g] = await db
    .insert(scimGroups)
    .values({
      orgId: ctx.orgId,
      providerId: ctx.provider.id,
      displayName: input.displayName,
      externalId: input.externalId ?? null,
    })
    .returning();
  const touched = await setMembers(
    ctx,
    g!,
    (input.members ?? []).map((m) => m.value),
    [],
  );
  await resync(ctx, touched);
  await identityAudit(
    db,
    {
      orgId: ctx.orgId,
      actorId: null,
      action: 'identity.scim.group',
      targetType: 'scim_group',
      targetId: g!.id,
      meta: {
        provider: ctx.provider.id,
        op: 'create',
        name: g!.displayName,
        members: touched.length,
      },
    },
    ctx.req,
  );
  ctx.c.header(
    'Location',
    `${ctx.deps.env.API_URL.replace(/\/+$/, '')}/api/scim/v2/Groups/${g!.id}`,
  );
  return scimJson(ctx.c, await groupResource(ctx, g!, true), 201);
}

const memberValues = (value: unknown): string[] => {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .map((m) => (m && typeof m === 'object' ? (m as { value?: unknown }).value : m))
    .filter((v): v is string => typeof v === 'string');
};

async function patchGroup(ctx: ScimCtx, g: GroupRow) {
  const body = await readJson(ctx.c, PatchOp);
  const add: string[] = [];
  const remove: string[] = [];
  let replace: string[] | undefined;
  let displayName: string | undefined;
  let externalId: string | null | undefined;
  for (const op of body.Operations) {
    const kind = op.op.toLowerCase();
    const path = (op.path ?? '').toLowerCase();
    const filtered = /^members\[value eq "([^"]+)"\]$/i.exec(op.path ?? '');
    if (filtered) {
      if (kind === 'remove') remove.push(filtered[1]!);
      else add.push(filtered[1]!);
    } else if (path === 'members') {
      if (kind === 'add') add.push(...memberValues(op.value));
      else if (kind === 'remove') {
        // No value = remove every member.
        if (op.value === undefined) replace = [];
        else remove.push(...memberValues(op.value));
      } else replace = memberValues(op.value);
    } else if (path === 'displayname' && typeof op.value === 'string') {
      displayName = op.value;
    } else if (path === 'externalid') {
      externalId = typeof op.value === 'string' ? op.value : null;
    } else if (!op.path && op.value && typeof op.value === 'object') {
      const v = op.value as Record<string, unknown>;
      if (typeof v.displayName === 'string') displayName = v.displayName;
      if (typeof v.externalId === 'string') externalId = v.externalId;
      if (v.members !== undefined) {
        if (kind === 'add') add.push(...memberValues(v.members));
        else replace = memberValues(v.members);
      }
    } else if (!['add', 'replace', 'remove'].includes(kind)) {
      throw new ScimFailure(400, `Unsupported op ${op.op}`, 'invalidSyntax');
    }
  }
  const renamed = displayName !== undefined || externalId !== undefined;
  if (renamed) {
    const [row] = await ctx.deps.db
      .update(scimGroups)
      .set({
        ...(displayName !== undefined ? { displayName } : {}),
        ...(externalId !== undefined ? { externalId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(scimGroups.id, g.id))
      .returning();
    g = row!;
  }
  const touched = await setMembers(ctx, g, add, remove, replace);
  // A new name changes what every member's mappings see.
  await resync(
    ctx,
    renamed ? [...new Set([...touched, ...(await allMembers(ctx.deps.db, g.id))])] : touched,
  );
  return scimJson(ctx.c, await groupResource(ctx, g, false));
}

async function replaceGroup(ctx: ScimCtx, g: GroupRow) {
  const input = await readJson(ctx.c, ScimGroupIn);
  const [row] = await ctx.deps.db
    .update(scimGroups)
    .set({
      displayName: input.displayName,
      externalId: input.externalId ?? g.externalId,
      updatedAt: new Date(),
    })
    .where(eq(scimGroups.id, g.id))
    .returning();
  const touched = await setMembers(
    ctx,
    row!,
    [],
    [],
    (input.members ?? []).map((m) => m.value),
  );
  await resync(ctx, [...new Set([...touched, ...(await allMembers(ctx.deps.db, g.id))])]);
  return scimJson(ctx.c, await groupResource(ctx, row!, true));
}

async function deleteGroup(ctx: ScimCtx, g: GroupRow) {
  const members = await allMembers(ctx.deps.db, g.id);
  await ctx.deps.db.delete(scimGroups).where(eq(scimGroups.id, g.id));
  await resync(ctx, members);
  await identityAudit(
    ctx.deps.db,
    {
      orgId: ctx.orgId,
      actorId: null,
      action: 'identity.scim.group',
      targetType: 'scim_group',
      targetId: g.id,
      meta: { provider: ctx.provider.id, op: 'delete', name: g.displayName },
    },
    ctx.req,
  );
  return ctx.c.body(null, 204);
}

async function listGroups(ctx: ScimCtx) {
  const filter = parseFilter(ctx.c.req.query('filter'));
  const { start, count } = paging(ctx.c);
  const excluded = (ctx.c.req.query('excludedAttributes') ?? '').toLowerCase().split(',');
  const conds = [eq(scimGroups.providerId, ctx.provider.id)];
  if (filter) {
    if (filter.attr === 'displayname')
      conds.push(sql`lower(${scimGroups.displayName}) = ${filter.value.toLowerCase()}`);
    else if (filter.attr === 'externalid') conds.push(eq(scimGroups.externalId, filter.value));
    else if (filter.attr === 'id') {
      conds.push(
        z.uuid().safeParse(filter.value).success ? eq(scimGroups.id, filter.value) : sql`false`,
      );
    } else
      throw new ScimFailure(400, `Unsupported filter attribute ${filter.attr}`, 'invalidFilter');
  }
  const rows = await ctx.deps.db
    .select()
    .from(scimGroups)
    .where(and(...conds))
    .orderBy(asc(scimGroups.createdAt));
  const pageRows = rows.slice(start - 1, start - 1 + count);
  const withMembers = !excluded.includes('members');
  return listResponse(
    ctx.c,
    await Promise.all(pageRows.map((g) => groupResource(ctx, g, withMembers))),
    rows.length,
    start,
  );
}

// ---- discovery -----------------------------------------------------------------------------

function serviceProviderConfig(ctx: ScimCtx) {
  return scimJson(ctx.c, {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: `${ctx.deps.env.HUB_URL}/admin/integrations/microsoft`,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_RESULTS },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'OAuth Bearer Token',
        description: 'Crewhall SCIM token (Yönetim › Entegrasyonlar › Microsoft › Entra ID)',
        primary: true,
      },
    ],
  });
}

function resourceTypes(ctx: ScimCtx) {
  return listResponse(
    ctx.c,
    [
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        id: 'User',
        name: 'User',
        endpoint: '/Users',
        schema: USER,
      },
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        id: 'Group',
        name: 'Group',
        endpoint: '/Groups',
        schema: GROUP,
      },
    ],
    2,
    1,
  );
}

function schemasList(ctx: ScimCtx) {
  const attr = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    type: 'string',
    multiValued: false,
    required: false,
    mutability: 'readWrite',
    returned: 'default',
    ...extra,
  });
  return listResponse(
    ctx.c,
    [
      {
        id: USER,
        name: 'User',
        attributes: [
          attr('userName', { required: true, uniqueness: 'server' }),
          attr('externalId'),
          attr('displayName'),
          attr('name', { type: 'complex' }),
          attr('emails', { type: 'complex', multiValued: true }),
          attr('active', { type: 'boolean' }),
          attr('groups', { type: 'complex', multiValued: true, mutability: 'readOnly' }),
        ],
      },
      {
        id: GROUP,
        name: 'Group',
        attributes: [
          attr('displayName', { required: true }),
          attr('externalId'),
          attr('members', { type: 'complex', multiValued: true }),
        ],
      },
    ],
    2,
    1,
  );
}

// ---- routing -------------------------------------------------------------------------------

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** One entry point for every SCIM path (`/api/scim/v2/...`). */
export async function handleScim(deps: Deps, c: Context<AppEnv>, req: RequestInfo) {
  try {
    const ctx = await authenticate(deps, c, req);
    const rest = new URL(c.req.url).pathname.replace(/^\/api\/scim\/v2\/?/, '').replace(/\/+$/, '');
    const [resource, id, extra] = rest.split('/');
    const method = c.req.method as Method;
    if (extra !== undefined) throw new ScimFailure(404, 'Not found');
    if (resource === 'ServiceProviderConfig' && method === 'GET') return serviceProviderConfig(ctx);
    if (resource === 'ResourceTypes' && method === 'GET') return resourceTypes(ctx);
    if (resource === 'Schemas' && method === 'GET') return schemasList(ctx);
    if (resource === 'Users') {
      if (!id) {
        if (method === 'GET') return await listUsers(ctx);
        if (method === 'POST') return await createUser(ctx);
        throw new ScimFailure(405, 'Method not allowed');
      }
      const p = await personById(ctx, id);
      if (!p) throw new ScimFailure(404, `User ${id} not found`);
      if (method === 'GET') return await sendUser(ctx, p);
      if (method === 'PUT') return await replaceUser(ctx, p);
      if (method === 'PATCH') return await patchUser(ctx, p);
      if (method === 'DELETE') return await deleteUser(ctx, p);
      throw new ScimFailure(405, 'Method not allowed');
    }
    if (resource === 'Groups') {
      if (!id) {
        if (method === 'GET') return await listGroups(ctx);
        if (method === 'POST') return await createGroup(ctx);
        throw new ScimFailure(405, 'Method not allowed');
      }
      const g = await groupById(ctx, id);
      if (!g) throw new ScimFailure(404, `Group ${id} not found`);
      const excluded = (c.req.query('excludedAttributes') ?? '').toLowerCase().split(',');
      if (method === 'GET')
        return scimJson(c, await groupResource(ctx, g, !excluded.includes('members')));
      if (method === 'PATCH') return await patchGroup(ctx, g);
      if (method === 'PUT') return await replaceGroup(ctx, g);
      if (method === 'DELETE') return await deleteGroup(ctx, g);
      throw new ScimFailure(405, 'Method not allowed');
    }
    throw new ScimFailure(404, 'Not found');
  } catch (err) {
    if (err instanceof ScimFailure) return scimError(c, err);
    deps.logger.error({ err }, 'scim request failed');
    return scimError(c, new ScimFailure(500, 'Internal error'));
  }
}

/**
 * Entra sends group object ids in the token; SCIM knows their names. Mappings may use either,
 * so both are offered to resolveRoles.
 */
export async function expandGroupIds(db: DbOrTx, providerId: string, groups: string[]) {
  if (!groups.length) return groups;
  const rows = await db
    .select({ name: scimGroups.displayName })
    .from(scimGroups)
    .where(and(eq(scimGroups.providerId, providerId), inArray(scimGroups.externalId, groups)));
  return [...new Set([...groups, ...rows.map((r) => r.name)])];
}
