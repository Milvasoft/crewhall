import { and, desc, eq, inArray, lt, max, sql } from 'drizzle-orm';
import { nodeVersions, pages, pageSnapshots, users, type DbOrTx } from '@crewhall/db';
import {
  PAGE_VERSION_INTERVAL_MINUTES,
  pagePath,
  type PageVersion,
  type PageVersionDetail,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { DriveActor } from '../drive/access';
import { canEditBody, loadPage, requirePage } from './access';
import { docFromState, docToJson } from './doc';
import { editPage, notifyCollab, type EditSource, type LiveDeps } from './live';
import { docToMarkdown } from './markdown';
import { sendPageNotice } from './notify';

type VersionRow = typeof nodeVersions.$inferSelect;
type SnapshotRow = typeof pageSnapshots.$inferSelect;
type UserRow = { id: string; name: string; email: string; image: string | null };

const summary = (u: UserRow) => ({ id: u.id, name: u.name, email: u.email, imageUrl: u.image });

/**
 * Takes a version of the stored state (doc 17 §6 "Sürüm"): a node_versions row (shared with
 * Drive's history) plus its Yjs snapshot. Clears the "edited since" list.
 */
export async function createPageVersion(
  db: DbOrTx,
  nodeId: string,
  by: {
    userId: string | null;
    source: EditSource;
    label?: string | null;
    restoredFrom?: number | null;
  },
) {
  return db.transaction(async (tx) => {
    const [page] = await tx.select().from(pages).where(eq(pages.nodeId, nodeId)).for('update');
    if (!page) throw new AppError('not_found');
    const state = page.ydoc ?? Buffer.alloc(0);
    const markdown = docToMarkdown(docToJson(docFromState(state)));
    const [last] = await tx
      .select({ v: max(nodeVersions.version) })
      .from(nodeVersions)
      .where(eq(nodeVersions.nodeId, nodeId));
    const editors = [...new Set([...page.pendingEditors, ...(by.userId ? [by.userId] : [])])];
    const [version] = await tx
      .insert(nodeVersions)
      .values({
        orgId: page.orgId,
        nodeId,
        version: (last?.v ?? 0) + 1,
        sizeBytes: 0,
        label: by.label ?? null,
        source: by.source,
        createdBy: by.userId,
      })
      .returning();
    await tx.insert(pageSnapshots).values({
      versionId: version!.id,
      nodeId,
      orgId: page.orgId,
      ydoc: state,
      markdown,
      editorIds: editors,
      restoredFrom: by.restoredFrom ?? null,
    });
    await tx
      .update(pages)
      .set({ versionedRev: page.snapshotRev, pendingEditors: sql`'{}'::uuid[]` })
      .where(eq(pages.nodeId, nodeId));
    return version!;
  });
}

/** During active editing: a version at most every 10 minutes, only when something changed. */
export async function maybeAutoVersion(db: DbOrTx, nodeId: string) {
  const [page] = await db.select().from(pages).where(eq(pages.nodeId, nodeId));
  if (!page || page.snapshotRev <= page.versionedRev) return null;
  const [last] = await db
    .select({ at: nodeVersions.createdAt })
    .from(nodeVersions)
    .where(eq(nodeVersions.nodeId, nodeId))
    .orderBy(desc(nodeVersions.version))
    .limit(1);
  const due = !last || Date.now() - last.at.getTime() >= PAGE_VERSION_INTERVAL_MINUTES * 60_000;
  if (!due) return null;
  return createPageVersion(db, nodeId, {
    userId: page.editedBy,
    source: page.lastSource ?? 'web',
  });
}

async function toVersions(db: DbOrTx, rows: { v: VersionRow; s: SnapshotRow | null }[]) {
  const ids = [
    ...new Set(
      rows
        .flatMap((r) => [r.v.createdBy, ...(r.s?.editorIds ?? [])])
        .filter((x): x is string => !!x),
    ),
  ];
  const people = new Map(
    (ids.length
      ? await db
          .select({ id: users.id, name: users.name, email: users.email, image: users.image })
          .from(users)
          .where(inArray(users.id, ids))
      : []
    ).map((u) => [u.id, u]),
  );
  const newest = Math.max(0, ...rows.map((r) => r.v.version));
  return rows.map(({ v, s }): PageVersion => ({
    id: v.id,
    version: v.version,
    label: v.label,
    source: v.source,
    createdBy: v.createdBy && people.has(v.createdBy) ? summary(people.get(v.createdBy)!) : null,
    editors: (s?.editorIds ?? [])
      .map((id) => people.get(id))
      .filter((u): u is UserRow => !!u)
      .map(summary),
    restoredFrom: s?.restoredFrom ?? null,
    current: v.version === newest,
    createdAt: v.createdAt.toISOString(),
  }));
}

export async function listPageVersions(db: DbOrTx, a: DriveActor, nodeId: string) {
  await loadPage(db, a, nodeId);
  const rows = await db
    .select({ v: nodeVersions, s: pageSnapshots })
    .from(nodeVersions)
    .leftJoin(pageSnapshots, eq(pageSnapshots.versionId, nodeVersions.id))
    .where(eq(nodeVersions.nodeId, nodeId))
    .orderBy(desc(nodeVersions.version));
  return toVersions(db, rows);
}

async function versionOut(db: DbOrTx, nodeId: string, versionId: string) {
  const all = await listPageVersionsRaw(db, nodeId);
  const found = all.find((v) => v.id === versionId);
  if (!found) throw new AppError('not_found');
  return found;
}

async function listPageVersionsRaw(db: DbOrTx, nodeId: string) {
  const rows = await db
    .select({ v: nodeVersions, s: pageSnapshots })
    .from(nodeVersions)
    .leftJoin(pageSnapshots, eq(pageSnapshots.versionId, nodeVersions.id))
    .where(eq(nodeVersions.nodeId, nodeId))
    .orderBy(desc(nodeVersions.version));
  return toVersions(db, rows);
}

export async function getPageVersion(
  db: DbOrTx,
  a: DriveActor,
  nodeId: string,
  versionId: string,
): Promise<PageVersionDetail> {
  await loadPage(db, a, nodeId);
  const [row] = await db
    .select({ v: nodeVersions, s: pageSnapshots })
    .from(nodeVersions)
    .innerJoin(pageSnapshots, eq(pageSnapshots.versionId, nodeVersions.id))
    .where(and(eq(nodeVersions.id, versionId), eq(nodeVersions.nodeId, nodeId)));
  if (!row) throw new AppError('not_found');
  const [prev] = await db
    .select({ v: nodeVersions, s: pageSnapshots })
    .from(nodeVersions)
    .innerJoin(pageSnapshots, eq(pageSnapshots.versionId, nodeVersions.id))
    .where(and(eq(nodeVersions.nodeId, nodeId), lt(nodeVersions.version, row.v.version)))
    .orderBy(desc(nodeVersions.version))
    .limit(1);
  const [base] = await toVersions(db, [row]);
  const newest = await db
    .select({ v: max(nodeVersions.version) })
    .from(nodeVersions)
    .where(eq(nodeVersions.nodeId, nodeId));
  return {
    ...base!,
    current: row.v.version === (newest[0]?.v ?? 0),
    markdown: row.s.markdown,
    doc: docToJson(docFromState(row.s.ydoc)),
    previous: prev
      ? {
          id: prev.v.id,
          version: prev.v.version,
          markdown: prev.s.markdown,
          doc: docToJson(docFromState(prev.s.ydoc)),
        }
      : null,
  };
}

/** "Sürüm kaydet" / "Şu anki sürümü adlandır". Unchanged since the last version: names it. */
export async function savePageVersion(
  deps: LiveDeps,
  a: DriveActor,
  nodeId: string,
  label: string | null,
  source: EditSource,
) {
  const access = await loadPage(deps.db, a, nodeId);
  requirePage(a, access, 'space.edit_content');
  await notifyCollab(deps, nodeId, 'flush');
  const [page] = await deps.db.select().from(pages).where(eq(pages.nodeId, nodeId));
  const [last] = await deps.db
    .select()
    .from(nodeVersions)
    .where(eq(nodeVersions.nodeId, nodeId))
    .orderBy(desc(nodeVersions.version))
    .limit(1);
  if (last && page && page.snapshotRev <= page.versionedRev) {
    if (label !== null) {
      await deps.db.update(nodeVersions).set({ label }).where(eq(nodeVersions.id, last.id));
    }
    return versionOut(deps.db, nodeId, last.id);
  }
  const created = await createPageVersion(deps.db, nodeId, { userId: a.userId, source, label });
  return versionOut(deps.db, nodeId, created.id);
}

export async function updatePageVersion(
  db: DbOrTx,
  a: DriveActor,
  nodeId: string,
  versionId: string,
  label: string | null,
) {
  const access = await loadPage(db, a, nodeId);
  requirePage(a, access, 'space.edit_content');
  const updated = await db
    .update(nodeVersions)
    .set({ label })
    .where(and(eq(nodeVersions.id, versionId), eq(nodeVersions.nodeId, nodeId)))
    .returning({ id: nodeVersions.id });
  if (!updated.length) throw new AppError('not_found');
  return versionOut(db, nodeId, versionId);
}

/**
 * "Bu sürüme geri dön" (design 5.10, doc 17 §6): the current state is kept as a version, the
 * old content is applied as a new Yjs update (open editors stay connected), and the result
 * becomes a version that records what it restored.
 */
export async function restorePageVersion(
  deps: LiveDeps,
  a: DriveActor,
  nodeId: string,
  versionId: string,
  source: EditSource,
) {
  const access = await loadPage(deps.db, a, nodeId);
  requirePage(a, access, 'space.edit_content');
  if (!canEditBody(a, access)) throw new AppError('page_locked');
  const [old] = await deps.db
    .select({ v: nodeVersions, s: pageSnapshots })
    .from(nodeVersions)
    .innerJoin(pageSnapshots, eq(pageSnapshots.versionId, nodeVersions.id))
    .where(and(eq(nodeVersions.id, versionId), eq(nodeVersions.nodeId, nodeId)));
  if (!old) throw new AppError('not_found');

  await notifyCollab(deps, nodeId, 'flush');
  const [page] = await deps.db.select().from(pages).where(eq(pages.nodeId, nodeId));
  if (page && page.snapshotRev > page.versionedRev) {
    await createPageVersion(deps.db, nodeId, {
      userId: page.editedBy,
      source: page.lastSource ?? 'web',
    });
  }
  await editPage(deps, nodeId, {
    op: 'replace',
    doc: docToJson(docFromState(old.s.ydoc)),
    userId: a.userId,
    source,
    notice: 'restored',
  });
  const created = await createPageVersion(deps.db, nodeId, {
    userId: a.userId,
    source,
    restoredFrom: old.v.version,
  });
  await deps.jobs.send('page.snapshot', { nodeId });

  // People who edited recently hear about it (design 5.10).
  const recent = await deps.db
    .select({ ids: pageSnapshots.editorIds })
    .from(pageSnapshots)
    .where(eq(pageSnapshots.nodeId, nodeId))
    .orderBy(desc(pageSnapshots.createdAt))
    .limit(5);
  await sendPageNotice(
    {
      type: 'page.restored',
      orgId: access.node.orgId,
      spaceId: access.node.spaceId,
      nodeId,
      pageName: access.node.name,
      actorId: a.userId,
      userIds: recent.flatMap((r) => r.ids),
      url: pagePath(access.node),
    },
    deps.logger,
  );
  return versionOut(deps.db, nodeId, created.id);
}

/**
 * Retention (design 05 "Sürümler ve geri yükleme"): every version of the last 30 days, then
 * one a day; named versions are never removed.
 */
export async function prunePageVersions(db: DbOrTx) {
  await db.execute(sql`
    delete from ${nodeVersions} v
    using ${pageSnapshots} s
    where s.version_id = v.id
      and v.label is null
      and v.created_at < now() - interval '30 days'
      and exists (
        select 1 from ${nodeVersions} newer
        where newer.node_id = v.node_id
          and newer.version > v.version
          and date_trunc('day', newer.created_at) = date_trunc('day', v.created_at)
      )`);
}
