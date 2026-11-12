import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { importJobs, organizations, orgMembers, users, type Db } from '@crewhall/db';
import {
  can,
  type ImportJob,
  type StartImport,
  type StartOneDriveMove,
} from '@crewhall/shared';
import type { Deps } from '../../../deps';
import { AppError } from '../../../http/errors';
import type { OrgRow, RequestInfo } from '../../../http/types';
import type { DriveActor } from '../../drive/access';
import { orgLimits } from '../../drive/quota';
import { identityAudit } from '../../identity/audit';
import { orgContext, toActor } from '../../membership';
import { ensureFolder } from '../../portal/nodes';
import { ensurePersonalSpace } from '../../spaces';
import { appCredentials, requireIntegration } from '../app';
import { storeBytes, writableTarget, type StoreDeps } from '../drive-store';
import { joinPath, type MountAdapter } from './adapter';
import { graphDriveAdapter, resolveDriveId } from './graph-drive';
import { adapterOf, mountAccess, storageError } from './mounts';

/**
 * Copies into Drive (a mount folder, or a whole OneDrive in the admin's move tool). Runs as a
 * worker job with the rights of the person it copies for; folders are mirrored, files above
 * the org's single-file limit are skipped and counted. The source is never changed.
 */

type JobRow = typeof importJobs.$inferSelect;
type ImportDeps = StoreDeps & Pick<Deps, 'env' | 'logger'>;

/** Hard stop for one job, so a mistaken root cannot copy a whole tenant. */
const MAX_ITEMS = 50_000;

const jobView = (r: JobRow): ImportJob => ({
  id: r.id,
  source: r.sourceLabel,
  status: r.status,
  files: r.files,
  bytes: r.bytes,
  skipped: r.skipped,
  error: r.error,
  targetSpaceId: r.targetSpaceId,
  targetFolderId: r.targetFolderId,
  createdAt: r.createdAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
});

const isAdmin = (a: DriveActor) =>
  can(a.actor, 'org.update_settings', { type: 'org', org: orgContext(a.org) });

export async function startMountImport(
  deps: Pick<Deps, 'db' | 'env' | 'jobs'>,
  a: DriveActor & { userName: string },
  input: StartImport,
  req: RequestInfo,
) {
  requireIntegration(a.org, 'externalStorage');
  if (input.source.kind === 'onedrive') {
    if (!isAdmin(a)) throw new AppError('forbidden');
    const [job] = await startOneDriveMove(deps, a, { users: [input.source.user], folderName: 'OneDrive' }, req);
    return job!;
  }
  if (!input.target) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: [{ path: ['target'], code: 'required', message: 'target' }],
    });
  }
  const { mount } = await mountAccess(deps.db, a, input.source.mountId);
  await writableTarget(deps, a, input.target.spaceId, input.target.parentId);
  const [row] = await deps.db
    .insert(importJobs)
    .values({
      orgId: a.org.id,
      userId: a.userId,
      source: input.source,
      sourceLabel: [mount.name, input.source.path].filter(Boolean).join(' › '),
      targetSpaceId: input.target.spaceId,
      targetFolderId: input.target.parentId,
    })
    .returning();
  await identityAudit(
    deps.db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'microsoft.import.start',
      targetType: 'drive_mount',
      targetId: mount.id,
      meta: { job: row!.id, path: input.source.path, space: input.target.spaceId },
    },
    req,
  );
  await deps.jobs.send('microsoft.import', { jobId: row!.id });
  return jobView(row!);
}

/** Admin move tool: each listed person's OneDrive into a folder of their personal space. */
export async function startOneDriveMove(
  deps: Pick<Deps, 'db' | 'env' | 'jobs'>,
  a: DriveActor,
  input: StartOneDriveMove,
  req: RequestInfo,
) {
  requireIntegration(a.org, 'externalStorage');
  if (!isAdmin(a)) throw new AppError('forbidden');
  await appCredentials(deps, a.org.id);
  const emails = [...new Set(input.users.map((u) => u.trim().toLowerCase()))];
  const people = await deps.db
    .select({ user: users })
    .from(users)
    .innerJoin(
      orgMembers,
      and(eq(orgMembers.userId, users.id), eq(orgMembers.organizationId, a.org.id), eq(orgMembers.status, 'active')),
    )
    .where(inArray(sql`lower(${users.email})`, emails));
  const known = new Map(people.map((p) => [p.user.email.toLowerCase(), p.user]));
  const unknown = emails.filter((e) => !known.has(e));
  if (unknown.length) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: unknown.map((u) => ({ path: ['users'], code: 'person_not_found', message: u })),
    });
  }
  const created: ImportJob[] = [];
  for (const email of emails) {
    const person = known.get(email)!;
    const space = await ensurePersonalSpace(deps.db, a.org.id, person);
    const folderId = await ensureFolder(deps.db, {
      orgId: a.org.id,
      spaceId: space.id,
      parentId: null,
      name: input.folderName,
      userId: person.id,
    });
    const [row] = await deps.db
      .insert(importJobs)
      .values({
        orgId: a.org.id,
        userId: a.userId,
        ownerId: person.id,
        source: { kind: 'onedrive', user: email },
        sourceLabel: `OneDrive › ${email}`,
        targetSpaceId: space.id,
        targetFolderId: folderId,
      })
      .returning();
    await identityAudit(
      deps.db,
      {
        orgId: a.org.id,
        actorId: a.userId,
        action: 'microsoft.import.start',
        targetType: 'user',
        targetId: person.id,
        meta: { job: row!.id, onedrive: email },
      },
      req,
    );
    await deps.jobs.send('microsoft.import', { jobId: row!.id });
    created.push(jobView(row!));
  }
  return created;
}

export async function listImportJobs(db: Db, a: DriveActor) {
  const rows = await db
    .select()
    .from(importJobs)
    .where(
      isAdmin(a)
        ? eq(importJobs.orgId, a.org.id)
        : and(eq(importJobs.orgId, a.org.id), eq(importJobs.userId, a.userId)),
    )
    .orderBy(desc(importJobs.createdAt))
    .limit(100);
  return rows.map(jobView);
}

// ---- the worker side ----------------------------------------------------------------------------

/** The person the files are copied for: the starter, or for OneDrive moves its owner. */
async function actorOf(db: Db, job: JobRow): Promise<DriveActor | null> {
  const [row] = await db
    .select({ org: organizations, member: orgMembers })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.organizationId))
    .where(and(eq(orgMembers.organizationId, job.orgId), eq(orgMembers.userId, job.ownerId ?? job.userId)));
  if (!row || row.member.status !== 'active') return null;
  return { org: row.org as OrgRow, actor: toActor(row.member), userId: row.member.userId };
}

async function sourceAdapter(deps: ImportDeps, job: JobRow, a: DriveActor) {
  const source = job.source as { kind: 'mount'; mountId: string; path: string } | { kind: 'onedrive'; user: string };
  if (source.kind === 'onedrive') {
    const creds = await appCredentials(deps, job.orgId);
    const driveId = await resolveDriveId(creds, { kind: 'onedrive', user: source.user });
    return { adapter: graphDriveAdapter(creds, driveId, ''), root: '' };
  }
  // The starter must still see the mount (rights are checked again at run time).
  const { mount } = await mountAccess(deps.db, a, source.mountId);
  return { adapter: await adapterOf(deps, mount), root: source.path };
}

export async function runImportJob(deps: ImportDeps, jobId: string) {
  const { db } = deps;
  const [job] = await db.select().from(importJobs).where(eq(importJobs.id, jobId));
  if (!job || job.status !== 'queued') return;
  const finish = (set: Partial<JobRow>) =>
    db.update(importJobs).set({ ...set, finishedAt: new Date() }).where(eq(importJobs.id, jobId));
  await db.update(importJobs).set({ status: 'running' }).where(eq(importJobs.id, jobId));
  const a = await actorOf(db, job);
  if (!a) {
    await finish({ status: 'failed', error: 'person_inactive' });
    return;
  }
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  let seen = 0;
  const progress = () =>
    db.update(importJobs).set({ files, bytes, skipped }).where(eq(importJobs.id, jobId));
  try {
    const { adapter, root } = await sourceAdapter(deps, job, a);
    const { maxFileBytes } = orgLimits(a.org);
    const queue: { path: string; parentId: string | null }[] = [
      { path: root, parentId: job.targetFolderId },
    ];
    while (queue.length) {
      const { path, parentId } = queue.shift()!;
      const items = await listSafe(adapter, path);
      for (const item of items) {
        if (++seen > MAX_ITEMS) throw new AppError('validation_failed', { reason: 'too_many_items' });
        if (item.type === 'folder') {
          const folderId = await ensureFolder(db, {
            orgId: a.org.id,
            spaceId: job.targetSpaceId,
            parentId,
            name: item.name.slice(0, 255),
            userId: a.userId,
          });
          queue.push({ path: joinPath(path, item.name), parentId: folderId });
          continue;
        }
        if (item.sizeBytes !== null && item.sizeBytes > maxFileBytes) {
          skipped++;
          continue;
        }
        const file = await adapter.read(item.path);
        if (file.body.length > maxFileBytes) {
          skipped++;
          continue;
        }
        await storeBytes(deps, a, {
          spaceId: job.targetSpaceId,
          parentId,
          name: item.name,
          content: file.body,
          mime: file.mime,
        });
        files++;
        bytes += file.body.length;
        if (files % 20 === 0) await progress();
      }
    }
    await finish({ status: 'done', files, bytes, skipped, error: null });
  } catch (err) {
    deps.logger.warn({ err, jobId }, 'import job failed');
    const code = err instanceof AppError ? err.code : storageError(err).code;
    await finish({ status: 'failed', files, bytes, skipped, error: code });
  }
}

async function listSafe(adapter: MountAdapter, path: string) {
  try {
    return await adapter.list(path);
  } catch (err) {
    throw storageError(err);
  }
}
