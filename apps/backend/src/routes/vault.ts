import type { Router } from '../http/route';
import { AppError } from '../http/errors';
import type { OrgCtx } from '../http/types';
import { can as canDo, type EndpointName } from '@crewhall/shared';
import { orgContext } from '../services/membership';
import { assertVaultUser, type VaultActor } from '../services/vault/common';
import * as attachments from '../services/vault/attachments';
import { breachRange } from '../services/vault/breach';
import * as events from '../services/vault/events';
import * as items from '../services/vault/items';
import * as keys from '../services/vault/keys';
import * as policy from '../services/vault/policy';
import * as shares from '../services/vault/shares';
import * as vaults from '../services/vault/vaults';

/**
 * Vault module routes (design 08, doc 17 §7). All org-scoped: vaults belong to an org and
 * guests have none. Unlock and proof checks run outside transactions so a failed attempt
 * is counted even though the request fails.
 */

function actor<N extends EndpointName>(ctx: OrgCtx<N>): VaultActor {
  assertVaultUser(ctx.actor.orgRole);
  return { org: ctx.org, userId: ctx.user.id, req: ctx.req };
}

export function registerVault(r: Router): void {
  /* ---------------------------------- keys ---------------------------------- */
  r.org('vaultKeys', async (ctx) => {
    actor(ctx);
    return keys.keyStatus(ctx.deps.db, ctx.user.id);
  });
  r.org(
    'vaultSetupKeys',
    async (ctx) => {
      const a = actor(ctx);
      return ctx.deps.db.transaction((tx) => keys.setupKeys(tx, a, ctx.body));
    },
    { status: 201 },
  );
  r.org('vaultUnlock', async (ctx) => keys.unlock(ctx.deps.db, actor(ctx), ctx.body));
  r.org('vaultChangePassword', async (ctx) =>
    keys.changePassword(ctx.deps.db, actor(ctx), ctx.body),
  );
  r.org('vaultRotateRecovery', async (ctx) =>
    keys.rotateRecovery(ctx.deps.db, actor(ctx), ctx.body),
  );
  r.org(
    'vaultAddUnlockMethod',
    async (ctx) => keys.addUnlockMethod(ctx.deps.db, actor(ctx), ctx.body),
    { status: 201 },
  );
  r.org('vaultRemoveUnlockMethod', async (ctx) => {
    await keys.removeUnlockMethod(ctx.deps.db, actor(ctx), ctx.params.unlockId);
    return {};
  });
  r.org('vaultGetSettings', async (ctx) => keys.getSettings(ctx.deps.db, actor(ctx)));
  r.org('vaultUpdateSettings', async (ctx) => {
    await keys.updateSettings(ctx.deps.db, actor(ctx), ctx.body.settings);
    return {};
  });
  r.org('vaultPublicKey', async (ctx) =>
    keys.publicKeyOf(ctx.deps.db, actor(ctx), ctx.params.userId),
  );

  /* ---------------------------------- vaults ---------------------------------- */
  r.org('vaultList', async (ctx) => ({ items: await vaults.listVaults(ctx.deps.db, actor(ctx)) }));
  r.org(
    'vaultCreate',
    async (ctx) => {
      const a = actor(ctx);
      return ctx.deps.db.transaction((tx) => vaults.createVault(tx, a, ctx.body));
    },
    { status: 201 },
  );
  r.org('vaultGet', async (ctx) => vaults.getVault(ctx.deps.db, actor(ctx), ctx.params.vaultId));
  r.org('vaultUpdate', async (ctx) =>
    vaults.renameVault(ctx.deps.db, actor(ctx), ctx.params.vaultId, ctx.body.name),
  );
  r.org('vaultDelete', async (ctx) => {
    const a = actor(ctx);
    await ctx.deps.db.transaction((tx) => vaults.deleteVault(tx, a, ctx.params.vaultId));
    return {};
  });
  r.org('vaultMembers', async (ctx) => ({
    items: await vaults.listMembers(ctx.deps.db, actor(ctx), ctx.params.vaultId),
  }));
  r.org('vaultCandidates', async (ctx) => ({
    items: await vaults.listCandidates(ctx.deps.db, actor(ctx), ctx.params.vaultId, ctx.query.q),
  }));
  r.org(
    'vaultGrant',
    async (ctx) => {
      const a = actor(ctx);
      return ctx.deps.db.transaction((tx) =>
        vaults.grantAccess(tx, a, ctx.params.vaultId, ctx.body),
      );
    },
    { status: 201 },
  );
  r.org('vaultUpdateMember', async (ctx) => {
    const a = actor(ctx);
    return ctx.deps.db.transaction((tx) =>
      vaults.updateMemberRole(tx, a, ctx.params.vaultId, ctx.params.userId, ctx.body.role),
    );
  });
  // One snapshot: items from before a rotation with the key from after it would not open, and a
  // device could not tell that from items that are really broken.
  r.org('vaultRotationData', async (ctx) => {
    const a = actor(ctx);
    return ctx.deps.db.transaction((tx) => vaults.rotationData(tx, a, ctx.params.vaultId), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  });
  r.org('vaultRotate', async (ctx) => {
    const a = actor(ctx);
    return ctx.deps.db.transaction((tx) => vaults.rotateVault(tx, a, ctx.params.vaultId, ctx.body));
  });

  /* ---------------------------------- items ---------------------------------- */
  r.org('vaultItems', async (ctx) =>
    items.listItems(ctx.deps.db, actor(ctx), ctx.params.vaultId, ctx.query),
  );
  r.org(
    'vaultCreateItem',
    async (ctx) => {
      const a = actor(ctx);
      return ctx.deps.db.transaction((tx) => items.createItem(tx, a, ctx.params.vaultId, ctx.body));
    },
    { status: 201 },
  );
  r.org('vaultEmptyTrash', async (ctx) => {
    const a = actor(ctx);
    return ctx.deps.db.transaction((tx) => items.emptyTrash(tx, a, ctx.params.vaultId));
  });
  r.org('vaultGetItem', async (ctx) => items.getItem(ctx.deps.db, actor(ctx), ctx.params.itemId));
  r.org('vaultUpdateItem', async (ctx) => {
    const a = actor(ctx);
    return ctx.deps.db.transaction((tx) => items.updateItem(tx, a, ctx.params.itemId, ctx.body));
  });
  r.org('vaultTrashItem', async (ctx) => {
    const a = actor(ctx);
    return ctx.deps.db.transaction((tx) => items.trashItem(tx, a, ctx.params.itemId));
  });
  r.org('vaultRestoreItem', async (ctx) => {
    const a = actor(ctx);
    return ctx.deps.db.transaction((tx) => items.restoreItem(tx, a, ctx.params.itemId));
  });
  r.org('vaultPurgeItem', async (ctx) => {
    const a = actor(ctx);
    await ctx.deps.db.transaction((tx) => items.purgeItem(tx, a, ctx.params.itemId));
    return {};
  });
  r.org(
    'vaultMoveItem',
    async (ctx) => {
      const a = actor(ctx);
      return ctx.deps.db.transaction((tx) => items.moveItem(tx, a, ctx.params.itemId, ctx.body));
    },
    { status: 201 },
  );
  r.org('vaultItemRevisions', async (ctx) => ({
    items: await items.listRevisions(ctx.deps.db, actor(ctx), ctx.params.itemId),
  }));
  r.org('vaultDeleteItemRevision', async (ctx) => {
    const a = actor(ctx);
    const revision = Number(ctx.params.revision);
    if (!Number.isInteger(revision) || revision < 1) throw new AppError('not_found');
    await ctx.deps.db.transaction((tx) => items.purgeRevision(tx, a, ctx.params.itemId, revision));
    return {};
  });
  r.org(
    'vaultImport',
    async (ctx) => {
      const a = actor(ctx);
      return ctx.deps.db.transaction((tx) => items.importItems(tx, a, ctx.body));
    },
    { status: 201 },
  );

  /* ---------------------------------- attachments ---------------------------------- */
  r.org(
    'vaultCreateAttachment',
    async (ctx) => attachments.createAttachment(ctx.deps, actor(ctx), ctx.params.itemId, ctx.body),
    { status: 201 },
  );
  r.org('vaultCompleteAttachment', async (ctx) =>
    attachments.completeAttachment(
      ctx.deps,
      actor(ctx),
      ctx.params.itemId,
      ctx.params.attachmentId,
      ctx.body.parts,
    ),
  );
  r.org('vaultAttachmentUrl', async (ctx) =>
    attachments.attachmentUrl(ctx.deps, actor(ctx), ctx.params.itemId, ctx.params.attachmentId),
  );
  r.org('vaultDeleteAttachment', async (ctx) => {
    await attachments.deleteAttachment(
      ctx.deps,
      actor(ctx),
      ctx.params.itemId,
      ctx.params.attachmentId,
    );
    return {};
  });

  /* ---------------------------------- access log ---------------------------------- */
  r.org('vaultReportEvents', async (ctx) => {
    await events.reportEvents(ctx.deps.db, actor(ctx), ctx.body);
    return {};
  });
  r.org('vaultEvents', async (ctx) => events.listEvents(ctx.deps.db, actor(ctx), ctx.query));

  /* ------------------------- roadmap 20: policy, breach check, links ------------------------- */
  const policyEditor = <N extends EndpointName>(ctx: OrgCtx<N>) =>
    canDo(ctx.actor, 'org.update_settings', { type: 'org', org: orgContext(ctx.org) });
  r.org('vaultPolicy', async (ctx) => {
    actor(ctx);
    return { ...(await policy.getPolicy(ctx.deps.db, ctx.org.id)), canEdit: policyEditor(ctx) };
  });
  r.org('vaultUpdatePolicy', async (ctx) =>
    policy.updatePolicy(ctx.deps.db, actor(ctx), policyEditor(ctx), ctx.body),
  );
  r.org('vaultBreachRange', async (ctx) => {
    actor(ctx);
    return breachRange(ctx.deps.db, ctx.org.id, ctx.params.prefix);
  });
  r.org(
    'vaultCreateShare',
    async (ctx) => shares.createShare(ctx.deps.db, actor(ctx), ctx.params.itemId, ctx.body),
    { status: 201 },
  );
  r.org('vaultShares', async (ctx) => ({
    items: await shares.listShares(ctx.deps.db, actor(ctx), ctx.query),
  }));
  r.org('vaultRevokeShare', async (ctx) => {
    await shares.revokeShare(ctx.deps.db, actor(ctx), ctx.params.shareId);
    return {};
  });
  r.public('vaultPublicShare', async (ctx) => shares.publicShare(ctx.deps.db, ctx.params.token));
  r.public('vaultOpenShare', async (ctx) =>
    shares.openShare(ctx.deps.db, ctx.params.token, ctx.req),
  );
}
