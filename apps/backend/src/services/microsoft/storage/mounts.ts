import { and, asc, eq } from 'drizzle-orm';
import { driveMounts, spaces, type DbOrTx } from '@crewhall/db';
import {
  OneDriveMountConfig,
  SharePointMountConfig,
  SmbMountConfig,
  type CreateDriveMount,
  type DriveMount,
  type MountItem,
  type MountListing,
  type UpdateDriveMount,
} from '@crewhall/shared';
import type { Deps } from '../../../deps';
import { AppError } from '../../../http/errors';
import type { OrgRow, RequestInfo } from '../../../http/types';
import { loadSpace, requireNodeAction, type DriveActor } from '../../drive/access';
import { identityAudit } from '../../identity/audit';
import { decryptSecret, encryptSecret } from '../../identity/crypto';
import { appCredentials, integrationOn, requireIntegration } from '../app';
import { graphAppError, GraphError, type AppCredentials } from '../graph';
import type { MountAdapter } from './adapter';
import { graphDriveAdapter, resolveDriveId } from './graph-drive';
import { smbAdapter } from './smb';

/**
 * External storage (sonraki-isler.md "SharePoint, OneDrive ve SMB dış depolama"): an admin
 * mounts a SharePoint library, a OneDrive or an SMB share into a shared space; members of the
 * space browse it live (nothing is copied), editors upload and create folders unless the
 * mount is read-only, and anyone who can read it can copy a folder into Drive.
 */

export type MountRow = typeof driveMounts.$inferSelect;
type MountDeps = Pick<Deps, 'db' | 'env'>;

function location(row: MountRow) {
  const c = row.config;
  if (row.kind === 'sharepoint') {
    const lib = typeof c.library === 'string' && c.library ? ` › ${c.library}` : '';
    return `${String(c.siteUrl)}${lib}`;
  }
  if (row.kind === 'onedrive') return `OneDrive › ${String(c.user)}`;
  return String(c.share);
}

export const mountView = (row: MountRow, spaceName: string): DriveMount => ({
  id: row.id,
  spaceId: row.spaceId,
  spaceName,
  name: row.name,
  kind: row.kind,
  location: location(row),
  readOnly: row.readOnly,
  lastCheckAt: row.lastCheckAt?.toISOString() ?? null,
  lastOk: row.lastOk,
  lastError: row.lastError,
  createdAt: row.createdAt.toISOString(),
});

/** SMB errors carry NTSTATUS names; Graph ones are mapped by graphAppError. */
export function storageError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof GraphError) return graphAppError(err);
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'STATUS_OBJECT_NAME_NOT_FOUND' || code === 'STATUS_OBJECT_PATH_NOT_FOUND') {
    return new AppError('mount_item_not_found');
  }
  return new AppError('mount_unreachable', { reason: typeof code === 'string' ? code : 'error' });
}

const errorText = (err: unknown) =>
  (err instanceof GraphError
    ? `${err.code}: ${err.message}`
    : err instanceof Error
      ? `${(err as { code?: string }).code ?? ''} ${err.message}`.trim()
      : String(err)
  ).slice(0, 500);

/** The adapter for a mount row (Graph mounts keep their resolved drive id in config). */
export async function adapterOf(deps: MountDeps, row: MountRow, creds?: AppCredentials): Promise<MountAdapter> {
  if (row.kind === 'smb') {
    const c = SmbMountConfig.parse(row.config);
    return smbAdapter({
      share: c.share,
      domain: c.domain,
      username: c.username,
      password: row.secretEnc ? decryptSecret(deps.env.AUTH_SECRET, row.secretEnc) : '',
      rootPath: c.rootPath,
    });
  }
  const driveId = typeof row.config.driveId === 'string' ? row.config.driveId : null;
  if (!driveId) throw new AppError('mount_unreachable', { reason: 'drive_unresolved' });
  const rootPath = typeof row.config.rootPath === 'string' ? row.config.rootPath : '';
  return graphDriveAdapter(creds ?? (await appCredentials(deps, row.orgId)), driveId, rootPath);
}

async function sharedSpace(db: DbOrTx, orgId: string, spaceId: string) {
  const [space] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.orgId, orgId), eq(spaces.kind, 'shared')));
  if (!space || space.archivedAt) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: [{ path: ['spaceId'], code: 'unknown_space', message: spaceId }],
    });
  }
  return space;
}

async function recordCheck(db: DbOrTx, id: string, err: unknown | null) {
  await db
    .update(driveMounts)
    .set({ lastCheckAt: new Date(), lastOk: err === null, lastError: err === null ? null : errorText(err) })
    .where(eq(driveMounts.id, id));
}

// ---- administration --------------------------------------------------------------------------

export async function listAllMounts(db: DbOrTx, orgId: string) {
  const rows = await db
    .select({ mount: driveMounts, spaceName: spaces.name })
    .from(driveMounts)
    .innerJoin(spaces, eq(spaces.id, driveMounts.spaceId))
    .where(eq(driveMounts.orgId, orgId))
    .orderBy(asc(spaces.name), asc(driveMounts.name));
  return rows.map((r) => mountView(r.mount, r.spaceName));
}

export async function createMount(
  deps: MountDeps,
  ctx: { orgId: string; userId: string },
  input: CreateDriveMount,
  req: RequestInfo,
) {
  const space = await sharedSpace(deps.db, ctx.orgId, input.spaceId);
  let config: Record<string, unknown>;
  let secretEnc: string | null = null;
  if (input.kind === 'smb') {
    config = SmbMountConfig.parse(input.config);
    if (input.password) secretEnc = encryptSecret(deps.env.AUTH_SECRET, input.password);
  } else {
    const creds = await appCredentials(deps, ctx.orgId);
    try {
      if (input.kind === 'sharepoint') {
        const parsed = SharePointMountConfig.parse(input.config);
        const driveId = await resolveDriveId(creds, { kind: 'sharepoint', ...parsed });
        config = { ...parsed, driveId };
      } else {
        const parsed = OneDriveMountConfig.parse(input.config);
        const driveId = await resolveDriveId(creds, { kind: 'onedrive', user: parsed.user });
        config = { ...parsed, driveId };
      }
    } catch (err) {
      throw storageError(err);
    }
  }
  const [row] = await deps.db
    .insert(driveMounts)
    .values({
      orgId: ctx.orgId,
      spaceId: space.id,
      name: input.name,
      kind: input.kind,
      config,
      secretEnc,
      readOnly: input.readOnly,
      createdBy: ctx.userId,
    })
    .returning();
  await identityAudit(
    deps.db,
    {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      action: 'microsoft.mount.create',
      targetType: 'drive_mount',
      targetId: row!.id,
      meta: { kind: input.kind, space: space.id, name: input.name },
    },
    req,
  );
  const checked = await checkMount(deps, row!);
  return mountView(checked, space.name);
}

async function mountRow(db: DbOrTx, orgId: string, id: string) {
  const [row] = await db
    .select({ mount: driveMounts, spaceName: spaces.name })
    .from(driveMounts)
    .innerJoin(spaces, eq(spaces.id, driveMounts.spaceId))
    .where(and(eq(driveMounts.id, id), eq(driveMounts.orgId, orgId)));
  if (!row) throw new AppError('not_found');
  return row;
}

export async function updateMount(
  deps: MountDeps,
  ctx: { orgId: string; userId: string },
  id: string,
  input: UpdateDriveMount,
  req: RequestInfo,
) {
  const { mount, spaceName } = await mountRow(deps.db, ctx.orgId, id);
  const [row] = await deps.db
    .update(driveMounts)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.readOnly !== undefined ? { readOnly: input.readOnly } : {}),
      ...(input.password !== undefined && mount.kind === 'smb'
        ? { secretEnc: encryptSecret(deps.env.AUTH_SECRET, input.password) }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(driveMounts.id, id))
    .returning();
  await identityAudit(
    deps.db,
    {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      action: 'microsoft.mount.update',
      targetType: 'drive_mount',
      targetId: id,
      meta: { name: input.name, readOnly: input.readOnly, password: input.password !== undefined },
    },
    req,
  );
  return mountView(row!, spaceName);
}

export async function deleteMount(
  deps: MountDeps,
  ctx: { orgId: string; userId: string },
  id: string,
  req: RequestInfo,
) {
  const { mount } = await mountRow(deps.db, ctx.orgId, id);
  await deps.db.delete(driveMounts).where(eq(driveMounts.id, id));
  await identityAudit(
    deps.db,
    {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      action: 'microsoft.mount.delete',
      targetType: 'drive_mount',
      targetId: id,
      meta: { kind: mount.kind, name: mount.name },
    },
    req,
  );
}

async function checkMount(deps: MountDeps, row: MountRow) {
  let failure: unknown | null = null;
  try {
    await (await adapterOf(deps, row)).check();
  } catch (err) {
    failure = err;
  }
  await recordCheck(deps.db, row.id, failure);
  const [fresh] = await deps.db.select().from(driveMounts).where(eq(driveMounts.id, row.id));
  return fresh!;
}

export async function testMount(deps: MountDeps, orgId: string, id: string) {
  const { mount } = await mountRow(deps.db, orgId, id);
  const fresh = await checkMount(deps, mount);
  return { ok: fresh.lastOk === true, error: fresh.lastError };
}

// ---- members: browse, download, upload ------------------------------------------------------

export async function listSpaceMounts(db: DbOrTx, a: DriveActor, spaceId: string) {
  if (!integrationOn(a.org.settings, 'externalStorage')) return [];
  const { space, role } = await loadSpace(db, a, spaceId);
  if (role === null) throw new AppError('not_found');
  const rows = await db
    .select()
    .from(driveMounts)
    .where(eq(driveMounts.spaceId, space.id))
    .orderBy(asc(driveMounts.name));
  return rows.map((r) => mountView(r, space.name));
}

/** The mount with the caller's rights on it (space role) and whether they may write. */
export async function mountAccess(db: DbOrTx, a: DriveActor & { org: OrgRow }, id: string) {
  requireIntegration(a.org, 'externalStorage');
  const [row] = await db
    .select()
    .from(driveMounts)
    .where(and(eq(driveMounts.id, id), eq(driveMounts.orgId, a.org.id)));
  if (!row) throw new AppError('not_found');
  // Not a member of the space: the mount does not exist for them.
  const { space, role } = await loadSpace(db, a, row.spaceId);
  if (role === null) throw new AppError('not_found');
  let canEdit = true;
  try {
    requireNodeAction(a, role, 'space.edit_content');
  } catch {
    canEdit = false;
  }
  return { mount: row, space, canWrite: canEdit && !row.readOnly && !space.archivedAt };
}

export async function listMountItems(deps: MountDeps, a: DriveActor, id: string, path: string): Promise<MountListing> {
  const { mount, space, canWrite } = await mountAccess(deps.db, a, id);
  let items: MountItem[];
  try {
    items = await (await adapterOf(deps, mount)).list(path);
  } catch (err) {
    throw storageError(err);
  }
  return { mount: mountView(mount, space.name), path, items, canWrite };
}

export async function readMountFile(deps: MountDeps, a: DriveActor, id: string, path: string) {
  const { mount } = await mountAccess(deps.db, a, id);
  if (!path) throw new AppError('mount_item_not_found');
  try {
    return await (await adapterOf(deps, mount)).read(path);
  } catch (err) {
    throw storageError(err);
  }
}

export async function writeMountFile(
  deps: MountDeps,
  a: DriveActor,
  id: string,
  input: { folder: string; name: string; content: Buffer; mime: string | null },
) {
  const { mount, canWrite } = await mountAccess(deps.db, a, id);
  if (mount.readOnly) throw new AppError('mount_read_only');
  if (!canWrite) throw new AppError('forbidden');
  try {
    return await (await adapterOf(deps, mount)).write(input.folder, input.name, input.content, input.mime);
  } catch (err) {
    throw storageError(err);
  }
}

export async function createMountFolder(
  deps: MountDeps,
  a: DriveActor,
  id: string,
  input: { path: string; name: string },
) {
  const { mount, canWrite } = await mountAccess(deps.db, a, id);
  if (mount.readOnly) throw new AppError('mount_read_only');
  if (!canWrite) throw new AppError('forbidden');
  try {
    return await (await adapterOf(deps, mount)).mkdir(input.path, input.name);
  } catch (err) {
    throw storageError(err);
  }
}
