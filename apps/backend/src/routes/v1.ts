import { and, eq } from 'drizzle-orm';
import { spaceMembers, spaces, users } from '@crewhall/db';
import {
  can,
  canGrantSpaceRole,
  CLIENT_HEADER,
  type Action,
  type Actor,
  type Resource,
  type SpaceRole,
} from '@crewhall/shared';
import type { Deps } from '../deps';
import { AppError } from '../http/errors';
import type { Router } from '../http/route';
import type { OrgCtx } from '../http/types';
import { audit } from '../services/audit';
import { serverCompat } from '../services/compat';
import * as invitationsSvc from '../services/invitations';
import { orgContext } from '../services/membership';
import * as me from '../services/me';
import * as mobile from '../services/mobile';
import * as members from '../services/members';
import * as orgSvc from '../services/org';
import * as uiPrefs from '../services/ui-prefs';
import { bootstrap, runSetup, smtpTest } from '../services/setup';
import { recordModuleChange } from '../services/identity/modules';
import { invalidatePolicy } from '../services/identity/policy';
import * as spacesSvc from '../services/spaces';
import { emitPluginEvent } from '../services/plugins/events';

const SPACE_RANK: Record<SpaceRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

function requireCan(actor: Actor, action: Action, resource: Resource) {
  if (!can(actor, action, resource)) throw new AppError('forbidden');
}

async function userRow(ctx: { deps: { db: Deps['db'] }; user: { id: string } }) {
  const [row] = await ctx.deps.db.select().from(users).where(eq(users.id, ctx.user.id));
  if (!row) throw new AppError('unauthenticated');
  return row;
}

/** Loads a space of the active org with the caller's role in it; 404 when it does not exist. */
async function spaceFor<N extends Parameters<Router['org']>[0]>(ctx: OrgCtx<N>, spaceId: string) {
  const loaded = await spacesSvc.loadSpace(ctx.deps.db, ctx.org.id, spaceId, ctx.user.id);
  if (!loaded || loaded.row.deletedAt) throw new AppError('not_found');
  const resource: Resource = {
    type: 'space',
    org: orgContext(ctx.org),
    myRole: loaded.myRole,
    editorsCanShareLinks: loaded.row.settings.editorsCanShareLinks === true,
  };
  const orgResource: Resource = { type: 'org', org: orgContext(ctx.org) };
  /** Org admins manage shared-space memberships without seeing content (design doc 17 §5). */
  const orgManages =
    loaded.row.kind === 'shared' && can(ctx.actor, 'org.manage_spaces', orgResource);
  return { ...loaded, resource, orgManages };
}

export function registerV1(r: Router) {
  // ---- public -------------------------------------------------------------
  r.public('bootstrap', async ({ deps, c }) => bootstrap(deps, c.req.header(CLIENT_HEADER)));
  r.public('getCompat', async ({ deps }) => serverCompat(deps.env));

  r.public('setup', async ({ deps, body, req }) => runSetup(deps, body, req), { status: 201 });

  r.public('setupSmtpTest', async ({ deps, body, req }) => {
    await smtpTest(deps, body.to, body.setupToken, req.locale);
    return {};
  });

  r.public('getInvitation', async ({ deps, params }) =>
    invitationsSvc.previewInvitation(deps.db, params.token),
  );

  // ---- me (no org needed, 2FA policy does not apply) ------------------------
  r.user('me', async ({ deps, user, session }) => me.getMe(deps.db, user.id, session));

  r.user('updateMe', async ({ deps, user, session, body }) => {
    await me.updateMe(deps.db, user, body);
    return me.getMe(deps.db, user.id, session);
  });

  r.user('switchOrg', async ({ deps, user, session, body }) => {
    await me.switchOrg(deps.db, user.id, session.id, body.orgId);
    return me.getMe(deps.db, user.id, { ...session, activeOrganizationId: body.orgId });
  });

  r.user('listSessions', async ({ deps, user, session }) => ({
    items: await me.listSessions(deps.db, user.id, session.id),
  }));

  r.user('revokeSession', async ({ deps, user, params, req }) => {
    await me.revokeSession(deps.db, user.id, params.sessionId, req);
    return {};
  });

  r.user('acceptInvitation', async ({ deps, user, session, params, req }) => {
    const orgId = await deps.db.transaction((tx) =>
      invitationsSvc.acceptInvitation(tx, params.token, user, session.id, req),
    );
    await emitPluginEvent(deps, orgId, 'member.joined', { userId: user.id });
    return me.getMe(deps.db, user.id, { ...session, activeOrganizationId: orgId });
  });

  // ---- mobile linking (docs/contracts/faz-0-kapanis.md) ---------------------
  r.user(
    'createMobileConnect',
    async ({ deps, user, session, req }) => mobile.createConnectTicket(deps, user.id, session, req),
    { status: 201 },
  );

  r.public('getMobileConnect', async ({ deps, params, req }) =>
    mobile.useConnectTicket(deps, params.token, req),
  );

  r.user(
    'createMobileHandoff',
    async ({ deps, user, session, body }) => mobile.createHandoff(deps, user.id, session, body),
    { status: 201 },
  );

  r.public('exchangeMobileHandoff', async ({ deps, body, req }) =>
    mobile.exchangeHandoff(deps, body, req),
  );

  // ---- organization ---------------------------------------------------------
  r.org('getUiPrefs', ({ deps, org, user }) => uiPrefs.getUiPrefs(deps.db, org.id, user.id));
  r.org('updateUiPrefs', ({ deps, org, user, body }) =>
    uiPrefs.updateUiPrefs(deps.db, org.id, user.id, body),
  );

  r.org('getOrg', async ({ org }) => orgSvc.toOrganization(org));

  r.org('updateOrg', async ({ deps, org, actor, body, req }) => {
    requireCan(actor, 'org.update_settings', { type: 'org', org: orgContext(org) });
    const updated = await deps.db.transaction(async (tx) => {
      const row = await orgSvc.updateOrganization(tx, org, body);
      await audit(
        tx,
        {
          orgId: org.id,
          actorId: actor.userId,
          action: 'org.update',
          targetType: 'org',
          targetId: org.id,
          meta: { name: body.name, settings: body.settings },
        },
        req,
      );
      if (body.settings?.modules) await recordModuleChange(tx, org, row, actor.userId, req);
      return row;
    });
    invalidatePolicy(org.id);
    return orgSvc.toOrganization(updated);
  });

  r.org('updateBranding', async ({ deps, org, actor, body, req }) => {
    requireCan(actor, 'org.update_branding', { type: 'org', org: orgContext(org) });
    return deps.db.transaction(async (tx) => {
      const branding = await orgSvc.updateBranding(tx, org, body);
      await audit(
        tx,
        {
          orgId: org.id,
          actorId: actor.userId,
          action: 'org.branding.update',
          targetType: 'org',
          targetId: org.id,
          meta: { fields: Object.keys(body) },
        },
        req,
      );
      return branding;
    });
  });

  r.org('getTheme', async ({ deps, org }) => orgSvc.currentTheme(deps.db, org.id));

  r.org('publishTheme', async ({ deps, org, actor, body, req }) => {
    requireCan(actor, 'org.update_branding', { type: 'org', org: orgContext(org) });
    return deps.db.transaction(async (tx) => {
      const theme = await orgSvc.publishTheme(tx, org.id, actor.userId, body);
      await audit(
        tx,
        {
          orgId: org.id,
          actorId: actor.userId,
          action: 'org.theme.publish',
          targetType: 'org',
          targetId: org.id,
          meta: { version: theme.version },
        },
        req,
      );
      return theme;
    });
  });

  r.org('listMembers', async ({ deps, org, actor, query }) => {
    requireCan(actor, 'org.view_directory', { type: 'org', org: orgContext(org) });
    // Sign-in locks are security information: only people who can lift them see them.
    const showLocks = can(actor, 'org.manage_members', { type: 'org', org: orgContext(org) });
    return members.listMembers(deps.db, org.id, actor, query, showLocks);
  });

  r.org('updateMember', async ({ deps, org, actor, params, body, req }) => {
    requireCan(actor, 'org.manage_members', { type: 'org', org: orgContext(org) });
    return deps.db.transaction((tx) =>
      members.updateMember(tx, org.id, actor.userId, params.userId, body, req),
    );
  });

  r.org('unlockMember', async ({ deps, org, actor, params, req }) => {
    requireCan(actor, 'org.manage_members', { type: 'org', org: orgContext(org) });
    return deps.db.transaction((tx) =>
      members.unlockMember(tx, org.id, actor.userId, params.userId, req),
    );
  });

  r.org('listOrgSpaces', async ({ deps, org, actor, query }) => {
    requireCan(actor, 'org.manage_spaces', { type: 'org', org: orgContext(org) });
    return {
      items: await spacesSvc.listOrgSharedSpaces(
        deps.db,
        org.id,
        actor.userId,
        query.archived ?? false,
      ),
    };
  });

  r.org('listInvitations', async ({ deps, org, actor }) => {
    requireCan(actor, 'org.invite', { type: 'org', org: orgContext(org) });
    return { items: await invitationsSvc.listInvitations(deps.db, org.id) };
  });

  r.org(
    'createInvitation',
    async (ctx) => {
      const { deps, org, actor, body, req } = ctx;
      requireCan(actor, 'org.invite', { type: 'org', org: orgContext(org) });
      return invitationsSvc.createInvitation(deps, org, await userRow(ctx), body, req);
    },
    { status: 201 },
  );

  r.org('revokeInvitation', async ({ deps, org, actor, params, req }) => {
    requireCan(actor, 'org.invite', { type: 'org', org: orgContext(org) });
    await invitationsSvc.revokeInvitation(deps.db, org.id, actor.userId, params.invitationId, req);
    return {};
  });

  // ---- spaces ---------------------------------------------------------------
  r.org('listSpaces', async ({ deps, org, user, query }) => ({
    items: await spacesSvc.listMySpaces(
      deps.db,
      org.id,
      user.id,
      query.archived ?? false,
      query.deleted ?? false,
    ),
  }));

  r.org(
    'createSpace',
    async ({ deps, org, actor, body, req }) => {
      requireCan(actor, 'org.create_space', { type: 'org', org: orgContext(org) });
      return deps.db.transaction(async (tx) => {
        const space = await spacesSvc.createSharedSpace(tx, org.id, actor.userId, body);
        for (const m of body.members) {
          if (m.userId === actor.userId) continue;
          if (!(await spacesSvc.activeOrgMember(tx, org.id, m.userId))) {
            throw new AppError('member_not_found', { userId: m.userId });
          }
          await tx
            .insert(spaceMembers)
            .values({
              spaceId: space.id,
              userId: m.userId,
              orgId: org.id,
              role: m.role,
              addedBy: actor.userId,
            })
            .onConflictDoNothing();
        }
        await audit(
          tx,
          {
            orgId: org.id,
            actorId: actor.userId,
            action: 'space.create',
            targetType: 'space',
            targetId: space.id,
            meta: { name: space.name, members: body.members.length },
          },
          req,
        );
        const loaded = await spacesSvc.loadSpace(tx, org.id, space.id, actor.userId);
        return spacesSvc.toSpace(space, 'owner', loaded?.count ?? 1);
      });
    },
    { status: 201 },
  );

  r.org('getSpace', async (ctx) => {
    const s = await spaceFor(ctx, ctx.params.spaceId);
    if (!s.myRole || !can(ctx.actor, 'space.view', s.resource)) throw new AppError('not_found');
    return spacesSvc.toSpace(s.row, s.myRole, s.count);
  });

  r.org('updateSpace', async (ctx) => {
    const { deps, org, actor, body, req } = ctx;
    const s = await spaceFor(ctx, ctx.params.spaceId);
    if (!s.myRole) throw new AppError('not_found');
    const touchesSettings =
      body.name !== undefined ||
      body.color !== undefined ||
      body.icon !== undefined ||
      body.description !== undefined ||
      body.visibility !== undefined;
    if (touchesSettings) requireCan(actor, 'space.update_settings', s.resource);
    // Quotas are an org decision (design doc 17 §8), not the space owner's.
    if (body.quotaBytes !== undefined) {
      requireCan(actor, 'org.manage_spaces', { type: 'org', org: orgContext(org) });
    }
    if (
      s.row.kind === 'personal' &&
      body.color !== undefined &&
      body.color !== spacesSvc.PERSONAL_COLOR
    ) {
      throw new AppError('forbidden', { reason: 'personal_color' });
    }
    if (s.row.kind === 'shared' && body.color === spacesSvc.PERSONAL_COLOR) {
      throw new AppError('validation_failed', {
        in: 'body',
        issues: [
          { path: ['color'], code: 'reserved', message: 's6 is reserved for personal spaces' },
        ],
      });
    }
    const myRole = s.myRole;
    return deps.db.transaction(async (tx) => {
      const [row] = await tx
        .update(spaces)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.color !== undefined ? { color: body.color } : {}),
          ...(body.icon !== undefined ? { icon: body.icon } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
          ...(body.quotaBytes !== undefined ? { quotaBytes: body.quotaBytes } : {}),
        })
        .where(eq(spaces.id, s.row.id))
        .returning();
      if (!row) throw new AppError('not_found');
      await audit(
        tx,
        {
          orgId: org.id,
          actorId: actor.userId,
          action: 'space.update',
          targetType: 'space',
          targetId: row.id,
          meta: { ...body },
        },
        req,
      );
      return spacesSvc.toSpace(row, myRole, s.count);
    });
  });

  r.org('archiveSpace', async (ctx) => {
    const { deps, org, actor, req } = ctx;
    const s = await spaceFor(ctx, ctx.params.spaceId);
    if (!s.myRole) throw new AppError('not_found');
    if (s.row.kind === 'personal') throw new AppError('forbidden', { reason: 'personal_space' });
    requireCan(actor, 'space.archive', s.resource);
    if (s.row.archivedAt) return spacesSvc.toSpace(s.row, s.myRole, s.count);
    const myRole = s.myRole;
    return deps.db.transaction(async (tx) => {
      const [row] = await tx
        .update(spaces)
        .set({ archivedAt: new Date(), isDefault: false })
        .where(eq(spaces.id, s.row.id))
        .returning();
      if (!row) throw new AppError('not_found');
      await audit(
        tx,
        {
          orgId: org.id,
          actorId: actor.userId,
          action: 'space.archive',
          targetType: 'space',
          targetId: row.id,
        },
        req,
      );
      return spacesSvc.toSpace(row, myRole, s.count);
    });
  });

  // Design 03: deleting waits 30 days (restorable); the trash.purge job removes it for good.
  r.org('deleteSpace', async (ctx) => {
    const { deps, org, actor, req } = ctx;
    const s = await spaceFor(ctx, ctx.params.spaceId);
    if (!s.myRole) throw new AppError('not_found');
    if (s.row.kind === 'personal') throw new AppError('forbidden', { reason: 'personal_space' });
    requireCan(actor, 'space.delete', s.resource);
    const myRole = s.myRole;
    return deps.db.transaction(async (tx) => {
      const [row] = await tx
        .update(spaces)
        .set({ deletedAt: new Date(), deletedBy: actor.userId, isDefault: false })
        .where(eq(spaces.id, s.row.id))
        .returning();
      if (!row) throw new AppError('not_found');
      await audit(
        tx,
        {
          orgId: org.id,
          actorId: actor.userId,
          action: 'space.delete',
          targetType: 'space',
          targetId: row.id,
          meta: { name: row.name },
        },
        req,
      );
      return spacesSvc.toSpace(row, myRole, s.count);
    });
  });

  r.org('restoreSpace', async (ctx) => {
    const { deps, org, actor, req } = ctx;
    const loaded = await spacesSvc.loadSpace(deps.db, org.id, ctx.params.spaceId, actor.userId);
    if (!loaded || loaded.myRole !== 'owner') throw new AppError('not_found');
    if (!loaded.row.deletedAt) return spacesSvc.toSpace(loaded.row, 'owner', loaded.count);
    return deps.db.transaction(async (tx) => {
      const [row] = await tx
        .update(spaces)
        .set({ deletedAt: null, deletedBy: null })
        .where(eq(spaces.id, loaded.row.id))
        .returning();
      if (!row) throw new AppError('not_found');
      await audit(
        tx,
        {
          orgId: org.id,
          actorId: actor.userId,
          action: 'space.restore',
          targetType: 'space',
          targetId: row.id,
        },
        req,
      );
      return spacesSvc.toSpace(row, 'owner', loaded.count);
    });
  });

  r.org('listSpaceMembers', async (ctx) => {
    const s = await spaceFor(ctx, ctx.params.spaceId);
    const allowed = (s.myRole && can(ctx.actor, 'space.view', s.resource)) || s.orgManages;
    if (!allowed) throw new AppError('not_found');
    return { items: await spacesSvc.listSpaceMembers(ctx.deps.db, s.row.id) };
  });

  r.org(
    'addSpaceMember',
    async (ctx) => {
      const { deps, org, actor, body, req } = ctx;
      const s = await spaceFor(ctx, ctx.params.spaceId);
      if (!s.myRole && !s.orgManages) throw new AppError('not_found');
      if (s.row.kind === 'personal') throw new AppError('forbidden', { reason: 'personal_space' });
      if (s.row.archivedAt) throw new AppError('forbidden', { reason: 'archived' });

      const selfAdd = body.userId === actor.userId && !s.myRole && s.orgManages;
      const manages = can(actor, 'space.manage_members', s.resource) || s.orgManages;
      if (!manages) throw new AppError('forbidden');
      const granter: SpaceRole | null =
        s.orgManages && (!s.myRole || SPACE_RANK[s.myRole] < SPACE_RANK.admin) ? 'admin' : s.myRole;
      if (!canGrantSpaceRole(granter, body.role))
        throw new AppError('forbidden', { reason: 'role_too_high' });
      if (!(await spacesSvc.activeOrgMember(deps.db, org.id, body.userId))) {
        throw new AppError('member_not_found');
      }
      if (await spacesSvc.myRoleIn(deps.db, s.row.id, body.userId)) {
        throw new AppError('conflict', { reason: 'already_member' });
      }
      return deps.db.transaction(async (tx) => {
        await tx.insert(spaceMembers).values({
          spaceId: s.row.id,
          userId: body.userId,
          orgId: org.id,
          role: body.role,
          addedBy: actor.userId,
        });
        // An org admin entering a space's content is always on record (design doc 17 §5).
        await audit(
          tx,
          {
            orgId: org.id,
            actorId: actor.userId,
            action: selfAdd ? 'space.member.self_add' : 'space.member.add',
            targetType: 'space',
            targetId: s.row.id,
            meta: { userId: body.userId, role: body.role },
          },
          req,
        );
        const added = await spacesSvc.spaceMember(tx, s.row.id, body.userId);
        if (!added) throw new AppError('internal');
        return added;
      });
    },
    { status: 201 },
  );

  r.org('updateSpaceMember', async (ctx) => {
    const { deps, org, actor, body, req, params } = ctx;
    const s = await spaceFor(ctx, params.spaceId);
    if (!s.myRole && !s.orgManages) throw new AppError('not_found');
    if (s.row.kind === 'personal') throw new AppError('forbidden', { reason: 'personal_space' });
    if (!can(actor, 'space.manage_members', s.resource) && !s.orgManages)
      throw new AppError('forbidden');
    const current = await spacesSvc.myRoleIn(deps.db, s.row.id, params.userId);
    if (!current) throw new AppError('member_not_found');
    if (current === 'owner') throw new AppError('cannot_change_owner');
    const granter: SpaceRole | null =
      s.orgManages && (!s.myRole || SPACE_RANK[s.myRole] < SPACE_RANK.admin) ? 'admin' : s.myRole;
    if (
      !granter ||
      SPACE_RANK[granter] < SPACE_RANK[current] ||
      !canGrantSpaceRole(granter, body.role)
    ) {
      throw new AppError('forbidden', { reason: 'role_too_high' });
    }
    return deps.db.transaction(async (tx) => {
      await tx
        .update(spaceMembers)
        .set({ role: body.role })
        .where(and(eq(spaceMembers.spaceId, s.row.id), eq(spaceMembers.userId, params.userId)));
      await audit(
        tx,
        {
          orgId: org.id,
          actorId: actor.userId,
          action: 'space.member.role',
          targetType: 'space',
          targetId: s.row.id,
          meta: { userId: params.userId, from: current, to: body.role },
        },
        req,
      );
      const updated = await spacesSvc.spaceMember(tx, s.row.id, params.userId);
      if (!updated) throw new AppError('member_not_found');
      return updated;
    });
  });

  r.org('removeSpaceMember', async (ctx) => {
    const { deps, org, actor, req, params } = ctx;
    const s = await spaceFor(ctx, params.spaceId);
    if (!s.myRole && !s.orgManages) throw new AppError('not_found');
    if (s.row.kind === 'personal') throw new AppError('forbidden', { reason: 'personal_space' });
    const current = await spacesSvc.myRoleIn(deps.db, s.row.id, params.userId);
    if (!current) throw new AppError('member_not_found');
    if (current === 'owner') throw new AppError('cannot_change_owner');
    const leaving = params.userId === actor.userId;
    if (!leaving) {
      if (!can(actor, 'space.manage_members', s.resource) && !s.orgManages)
        throw new AppError('forbidden');
      const granter: SpaceRole | null =
        s.orgManages && (!s.myRole || SPACE_RANK[s.myRole] < SPACE_RANK.admin) ? 'admin' : s.myRole;
      if (!granter || SPACE_RANK[granter] < SPACE_RANK[current]) {
        throw new AppError('forbidden', { reason: 'role_too_high' });
      }
    }
    await deps.db.transaction(async (tx) => {
      await tx
        .delete(spaceMembers)
        .where(and(eq(spaceMembers.spaceId, s.row.id), eq(spaceMembers.userId, params.userId)));
      await audit(
        tx,
        {
          orgId: org.id,
          actorId: actor.userId,
          action: 'space.member.remove',
          targetType: 'space',
          targetId: s.row.id,
          meta: { userId: params.userId, role: current, leaving },
        },
        req,
      );
    });
    return {};
  });
}
