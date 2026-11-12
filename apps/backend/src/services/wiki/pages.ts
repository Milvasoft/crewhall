import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  newId,
  nodes,
  nodeUserState,
  pageComments,
  pageRefs,
  pages,
  users,
  type DbOrTx,
} from '@crewhall/db';
import {
  COLLAB_TOKEN_TTL_SECONDS,
  PAGE_MARKDOWN_MAX,
  can,
  importLinkResolver,
  pageDocumentName,
  pagePath,
  type Backlink,
  type PageCollabToken,
  type Page,
  type PageTreeItem,
} from '@crewhall/shared';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';
import {
  loadSpace,
  nodeResource,
  roleForPath,
  spaceRoleOf,
  toDriveNodes,
  userSharePaths,
  type DriveActor,
} from '../drive/access';
import { container } from '../drive/nodes';
import { childPath, freeName, nameTakenFrom, positionIn, rewriteSubtree } from '../drive/tree';
import { canDo, canEditBody, loadPage, requirePage, type PageAccess } from './access';
import { clientCollabUrl, collabConfig } from './config';
import { derivePage, type WikiJobDeps } from './derive';
import {
  docFromState,
  docToJson,
  emptyPageDoc,
  readingMinutes,
  stateFromJson,
  type PMDoc,
  type PMNode,
} from './doc';
import {
  editPage,
  notifyCollab,
  setPageTask,
  storedDoc,
  type EditSource,
  type LiveDeps,
} from './live';
import { docToMarkdown, markdownToDoc } from './markdown';
import { templateMarkdown } from './templates';
import { signCollabToken } from './token';
import { createPageVersion } from './versions';

type UserRow = { id: string; name: string; email: string; image: string | null };
const summary = (u: UserRow | undefined | null) =>
  u ? { id: u.id, name: u.name, email: u.email, imageUrl: u.image } : null;

/* ----------------------------------- tree ----------------------------------- */

/** Pages of a space the caller can see, each under its nearest page ancestor. */
export async function pageTree(db: DbOrTx, a: DriveActor, spaceId: string) {
  const { space, role: spaceRole } = await loadSpace(db, a, spaceId);
  const sharePaths = await userSharePaths(db, space.id, a.userId);
  if (spaceRole === null && sharePaths.length === 0) throw new AppError('not_found');
  const rows = await db
    .select({ node: nodes, icon: pages.icon })
    .from(nodes)
    .leftJoin(pages, eq(pages.nodeId, nodes.id))
    .where(and(eq(nodes.spaceId, space.id), eq(nodes.type, 'page'), isNull(nodes.deletedAt)))
    .orderBy(nodes.position, nodes.id)
    .limit(5000);
  const byLabel = new Map(rows.map((r) => [r.node.path.split('.').at(-1)!, r.node.id]));
  const favorites = new Set(
    rows.length
      ? (
          await db
            .select({ id: nodeUserState.nodeId })
            .from(nodeUserState)
            .where(
              and(
                eq(nodeUserState.userId, a.userId),
                eq(nodeUserState.favorite, true),
                inArray(
                  nodeUserState.nodeId,
                  rows.map((r) => r.node.id),
                ),
              ),
            )
        ).map((r) => r.id)
      : [],
  );
  const visible: PageTreeItem[] = [];
  for (const { node, icon } of rows) {
    const role = roleForPath(spaceRole, sharePaths, node.path);
    if (!role || !can(a.actor, 'space.view', nodeResource(a, role))) continue;
    const labels = node.path.split('.').slice(0, -1);
    let parentId: string | null = null;
    for (let i = labels.length - 1; i >= 0; i--) {
      const id = byLabel.get(labels[i]!);
      if (id) {
        parentId = id;
        break;
      }
    }
    visible.push({
      id: node.id,
      parentId,
      name: node.name,
      icon: icon ?? null,
      position: node.position,
      hasChildren: false,
      myRole: role,
      favorite: favorites.has(node.id),
      updatedAt: node.updatedAt.toISOString(),
    });
  }
  const ids = new Set(visible.map((v) => v.id));
  const parents = new Set(visible.map((v) => v.parentId));
  for (const v of visible) {
    v.hasChildren = parents.has(v.id);
    // A parent the caller cannot see: show the page at the top.
    if (v.parentId && !ids.has(v.parentId)) v.parentId = null;
  }
  return {
    items: visible,
    canCreate: !space.archivedAt && can(a.actor, 'space.edit_content', nodeResource(a, spaceRole)),
  };
}

/* ------------------------------- page details -------------------------------- */

export async function toPage(db: DbOrTx, a: DriveActor, access: PageAccess): Promise<Page> {
  const { node, page, space } = access;
  const [base] = await toDriveNodes(db, a.userId, [node], new Map([[node.id, access.role!]]));
  const [personal] = await db
    .select({
      following: nodeUserState.following,
      descendants: nodeUserState.followDescendants,
    })
    .from(nodeUserState)
    .where(and(eq(nodeUserState.userId, a.userId), eq(nodeUserState.nodeId, node.id)));
  const labels = node.path.split('.').slice(0, -1);
  const ancestors = labels.length
    ? await db
        .select({ id: nodes.id, name: nodes.name })
        .from(nodes)
        .where(sql`${nodes.path} @> ${node.path}::ltree and ${nodes.id} <> ${node.id}`)
        .orderBy(sql`nlevel(${nodes.path})`)
    : [];
  const [open] = await db
    .select({ n: count() })
    .from(pageComments)
    .where(
      and(
        eq(pageComments.nodeId, node.id),
        isNull(pageComments.rootId),
        isNull(pageComments.resolvedAt),
      ),
    );
  const [editor] = page.editedBy
    ? await db
        .select({ id: users.id, name: users.name, email: users.email, image: users.image })
        .from(users)
        .where(eq(users.id, page.editedBy))
    : [];
  const editedAt = page.editedAt ?? node.updatedAt;
  return {
    id: node.id,
    spaceId: node.spaceId,
    parentId: node.parentId,
    name: node.name,
    icon: page.icon,
    cover: page.cover,
    fullWidth: page.fullWidth,
    smallText: page.smallText,
    locked: page.locked,
    empty: page.wordCount === 0 && page.derivedRev === page.snapshotRev && !page.bodyText,
    myRole: access.role!,
    canEdit: canEditBody(a, access),
    canComment: canDo(a, access.role, 'space.comment'),
    favorite: base!.favorite,
    following: personal?.following ?? false,
    followingDescendants: Boolean(personal?.following && personal.descendants),
    shared: base!.shared,
    wordCount: page.wordCount,
    readingMinutes: readingMinutes(page.wordCount),
    openCommentCount: open?.n ?? 0,
    editedAt: editedAt.toISOString(),
    editedBy: summary(editor) ?? base!.updatedBy,
    lastSource: page.lastSource,
    createdBy: base!.createdBy,
    createdAt: node.createdAt.toISOString(),
    updatedAt: node.updatedAt.toISOString(),
    deletedAt: node.deletedAt ? node.deletedAt.toISOString() : null,
    path: ancestors,
    space: { id: space.id, name: space.name, slug: space.slug, color: space.color },
  };
}

export async function getPage(db: DbOrTx, a: DriveActor, nodeId: string) {
  return toPage(db, a, await loadPage(db, a, nodeId, { includeTrashed: true }));
}

/* --------------------------------- create ------------------------------------ */

export interface CreatePageInput {
  parentId: string | null;
  name: string;
  icon?: string | null | undefined;
  templateId?: string | undefined;
  markdown?: string | undefined;
  afterId?: string | null | undefined;
  beforeId?: string | null | undefined;
}

/** A new page node with its body (design 5.14); version 1 is "sayfa oluşturuldu". */
export async function createPage(
  deps: WikiJobDeps,
  a: DriveActor,
  spaceId: string,
  input: CreatePageInput,
  opts: { source: EditSource; locale: 'tr' | 'en' },
): Promise<Page> {
  const { db } = deps;
  const { space, parent, role } = await container(db, a, spaceId, input.parentId);
  if (!can(a.actor, 'space.edit_content', nodeResource(a, role))) {
    throw new AppError(role === null ? 'not_found' : 'forbidden');
  }
  if (space.archivedAt) throw new AppError('forbidden', { reason: 'archived' });

  let doc: PMDoc = emptyPageDoc();
  if (input.templateId) {
    const md = await templateMarkdown(db, a, input.templateId, opts.locale, space.id);
    doc = markdownToDoc(md);
  } else if (input.markdown !== undefined) {
    if (input.markdown.length > PAGE_MARKDOWN_MAX) throw new AppError('page_too_large');
    doc = markdownToDoc(input.markdown);
  }

  const id = newId();
  const name = await freeName(db, space.id, parent?.id ?? null, input.name);
  await db.transaction(async (tx) => {
    await tx
      .insert(nodes)
      .values({
        id,
        orgId: a.org.id,
        spaceId: space.id,
        parentId: parent?.id ?? null,
        type: 'page',
        name,
        position: await positionIn(tx, space.id, parent?.id ?? null, {
          afterId: input.afterId,
          beforeId: input.beforeId,
        }),
        path: childPath(parent?.path ?? null, id),
        createdBy: a.userId,
        updatedBy: a.userId,
      })
      .catch(nameTakenFrom);
    await tx.insert(pages).values({
      nodeId: id,
      orgId: a.org.id,
      ydoc: stateFromJson(doc),
      icon: input.icon ?? null,
      lastSource: opts.source,
    });
  });
  // Derive right away so the page is searchable and never mistaken for an empty one.
  await derivePage(deps, id, true);
  await createPageVersion(db, id, { userId: a.userId, source: opts.source });
  return getPage(db, a, id);
}

/* ---------------------------------- move ------------------------------------- */

export interface MovePageInput {
  parentId?: string | null | undefined;
  afterId?: string | null | undefined;
  beforeId?: string | null | undefined;
}

/**
 * Sidebar drag and drop: next to a sibling (its Drive parent, since the tree skips folders) or
 * last under a parent. Same space only; needs edit rights on the page and on the target.
 */
export async function movePage(db: DbOrTx, a: DriveActor, nodeId: string, input: MovePageInput) {
  const access = await loadPage(db, a, nodeId);
  requirePage(a, access, 'space.edit_content');
  const node = access.node;
  const siblingId = input.afterId ?? input.beforeId ?? null;
  let parentId = input.parentId ?? null;
  if (siblingId) {
    if (siblingId === node.id) throw new AppError('invalid_target', { reason: 'into_itself' });
    const [sibling] = await db
      .select({ parentId: nodes.parentId, spaceId: nodes.spaceId })
      .from(nodes)
      .where(and(eq(nodes.id, siblingId), eq(nodes.orgId, a.org.id), isNull(nodes.deletedAt)));
    if (!sibling || sibling.spaceId !== node.spaceId) throw new AppError('invalid_target');
    parentId = sibling.parentId;
  }
  const dest = await container(db, a, node.spaceId, parentId);
  if (!can(a.actor, 'space.edit_content', nodeResource(a, dest.role))) {
    throw new AppError(dest.role === null ? 'not_found' : 'forbidden');
  }
  if (dest.space.archivedAt) throw new AppError('forbidden', { reason: 'archived' });
  if (dest.parent && (dest.parent.id === node.id || dest.parent.path.startsWith(`${node.path}.`))) {
    throw new AppError('invalid_target', { reason: 'into_itself' });
  }
  const destParentId = dest.parent?.id ?? null;
  const sameParent = node.parentId === destParentId;
  await db.transaction(async (tx) => {
    const name = sameParent ? node.name : await freeName(tx, node.spaceId, destParentId, node.name);
    const newPath = childPath(dest.parent?.path ?? null, node.id);
    if (newPath !== node.path) await rewriteSubtree(tx, node.path, newPath);
    await tx
      .update(nodes)
      .set({
        parentId: destParentId,
        name,
        position: await positionIn(tx, node.spaceId, destParentId, {
          afterId: input.afterId,
          beforeId: input.beforeId,
        }),
        updatedBy: a.userId,
      })
      .where(eq(nodes.id, node.id))
      .catch(nameTakenFrom);
  });
  return getPage(db, a, node.id);
}

/* --------------------------------- update ------------------------------------ */

export interface UpdatePageInput {
  name?: string | undefined;
  icon?: string | null | undefined;
  cover?: string | null | undefined;
  fullWidth?: boolean | undefined;
  smallText?: boolean | undefined;
  locked?: boolean | undefined;
}

/** Markdown at the end of a page, under the same rights as typing into it. */
export async function appendPage(deps: LiveDeps, a: DriveActor, nodeId: string, markdown: string) {
  const access = await loadPage(deps.db, a, nodeId);
  requirePage(a, access, 'space.edit_content');
  if (access.page.locked) throw new AppError('page_locked');
  await editPage(deps, nodeId, {
    op: 'append',
    doc: markdownToDoc(markdown),
    userId: a.userId,
    source: 'api',
  });
}

export async function updatePage(
  deps: LiveDeps,
  a: DriveActor,
  nodeId: string,
  input: UpdatePageInput,
) {
  const { db } = deps;
  const access = await loadPage(db, a, nodeId);
  requirePage(a, access, 'space.edit_content');
  const lockChanges = input.locked !== undefined && input.locked !== access.page.locked;
  const otherChanges = Object.entries(input).some(([k, v]) => k !== 'locked' && v !== undefined);
  // A locked page keeps its title and look until it is unlocked (design 5.17).
  if (access.page.locked && otherChanges && input.locked !== false)
    throw new AppError('page_locked');

  if (input.cover?.startsWith('node:')) {
    const fileId = input.cover.slice(5);
    const [file] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.id, fileId),
          eq(nodes.spaceId, access.space.id),
          eq(nodes.type, 'file'),
          isNull(nodes.deletedAt),
        ),
      );
    if (!file) throw new AppError('invalid_target', { field: 'cover' });
  }

  if (input.name !== undefined && input.name !== access.node.name) {
    const name = input.name;
    await db
      .update(nodes)
      .set({ name, updatedBy: a.userId })
      .where(eq(nodes.id, nodeId))
      .catch(nameTakenFrom);
  }
  const set: Partial<typeof pages.$inferInsert> = {};
  if (input.icon !== undefined) set.icon = input.icon;
  if (input.cover !== undefined) set.cover = input.cover;
  if (input.fullWidth !== undefined) set.fullWidth = input.fullWidth;
  if (input.smallText !== undefined) set.smallText = input.smallText;
  if (input.locked !== undefined) set.locked = input.locked;
  if (Object.keys(set).length) await db.update(pages).set(set).where(eq(pages.nodeId, nodeId));

  if (input.name !== undefined && input.name !== access.node.name) {
    // The title is part of the search vector.
    await deps.jobs.send('page.snapshot', { nodeId, force: true });
  }
  await notifyCollab(deps, nodeId, lockChanges ? 'recheck' : 'meta');
  return getPage(db, a, nodeId);
}

/** Copy next to the original with its current body (design 5.17 "Çoğalt"). */
export async function duplicatePage(
  deps: WikiJobDeps,
  a: DriveActor,
  nodeId: string,
  name: string,
  source: EditSource,
) {
  const access = await loadPage(deps.db, a, nodeId);
  const doc = docToJson(await storedDoc(deps.db, nodeId));
  return createPage(
    deps,
    a,
    access.space.id,
    {
      parentId: access.node.parentId,
      name,
      icon: access.page.icon,
      afterId: access.node.id,
      markdown: undefined,
    },
    { source, locale: 'tr' },
  ).then(async (created) => {
    await deps.db
      .update(pages)
      .set({ ydoc: stateFromJson(doc), cover: access.page.cover, fullWidth: access.page.fullWidth })
      .where(eq(pages.nodeId, created.id));
    await derivePage(deps, created.id, true);
    return getPage(deps.db, a, created.id);
  });
}

/* --------------------------------- content ----------------------------------- */

export async function pageContent(
  db: DbOrTx,
  a: DriveActor,
  nodeId: string,
  format: 'markdown' | 'json',
) {
  const access = await loadPage(db, a, nodeId);
  const json = docToJson(docFromState(access.page.ydoc));
  return {
    markdown: docToMarkdown(json),
    ...(format === 'json' ? { doc: json } : {}),
    updatedAt: (access.page.editedAt ?? access.node.updatedAt).toISOString(),
  };
}

/**
 * "Takip et": whoever can read a page can follow it, alone or with its sub-pages. Without
 * `descendants` (older clients) that choice stays; not following clears it.
 */
export async function setFollow(
  db: DbOrTx,
  a: DriveActor,
  nodeId: string,
  input: { following: boolean; descendants?: boolean | undefined },
): Promise<Record<string, never>> {
  const { node } = await loadPage(db, a, nodeId);
  const descendants = input.following ? input.descendants : false;
  await db
    .insert(nodeUserState)
    .values({
      userId: a.userId,
      nodeId,
      orgId: node.orgId,
      following: input.following,
      followDescendants: descendants ?? false,
    })
    .onConflictDoUpdate({
      target: [nodeUserState.userId, nodeUserState.nodeId],
      set: {
        following: input.following,
        ...(descendants === undefined ? {} : { followDescendants: descendants }),
        updatedAt: new Date(),
      },
    });
  return {};
}

/** Ticks a to-do of the page, for those who may edit its body. */
export async function setTask(
  deps: LiveDeps,
  a: DriveActor,
  nodeId: string,
  task: { index: number; text: string; checked: boolean },
  source: EditSource,
): Promise<Record<string, never>> {
  const access = await loadPage(deps.db, a, nodeId);
  if (!canEditBody(a, access)) throw new AppError('forbidden');
  await setPageTask(deps, nodeId, task, { userId: a.userId, source });
  return {};
}

/** Markdown files of a page (and its child pages under a folder of the same name). */
export async function exportPage(db: DbOrTx, a: DriveActor, nodeId: string, children: boolean) {
  const access = await loadPage(db, a, nodeId);
  const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '-').trim() || 'sayfa';
  const files: { path: string; markdown: string }[] = [];
  const rootJson = docToJson(docFromState(access.page.ydoc));
  files.push({
    path: `${safe(access.node.name)}.md`,
    markdown: `# ${access.node.name}\n\n${docToMarkdown(rootJson)}\n`,
  });
  if (children) {
    const tree = await pageTree(db, a, access.space.id);
    const byParent = new Map<string, PageTreeItem[]>();
    for (const item of tree.items) {
      if (!item.parentId) continue;
      byParent.set(item.parentId, [...(byParent.get(item.parentId) ?? []), item]);
    }
    const walkChildren = async (parentId: string, dir: string) => {
      for (const child of byParent.get(parentId) ?? []) {
        const [row] = await db
          .select({ ydoc: pages.ydoc })
          .from(pages)
          .where(eq(pages.nodeId, child.id));
        const md = docToMarkdown(docToJson(docFromState(row?.ydoc)));
        files.push({
          path: `${dir}/${safe(child.name)}.md`,
          markdown: `# ${child.name}\n\n${md}\n`,
        });
        await walkChildren(child.id, `${dir}/${safe(child.name)}`);
      }
    };
    await walkChildren(access.node.id, safe(access.node.name));
  }
  return { files };
}

/* ---------------------------------- import ----------------------------------- */

/**
 * Markdown import (design 5.15, files only): a path's folders become parent pages; a file
 * named like a folder becomes that folder's page. The first `# Title` line names the page.
 */
export async function importPages(
  deps: WikiJobDeps,
  a: DriveActor,
  spaceId: string,
  input: { parentId: string | null; files: { path: string; content: string }[] },
  opts: { source: EditSource; locale: 'tr' | 'en' },
) {
  const warnings: { path: string; code: 'empty' | 'too_large' | 'duplicate' }[] = [];
  const files = input.files
    .map((f) => ({ ...f, path: f.path.replace(/\\/g, '/').replace(/^\/+/, '') }))
    .filter((f) => {
      if (!/\.(md|markdown)$/i.test(f.path)) return false;
      if (!f.content.trim()) {
        warnings.push({ path: f.path, code: 'empty' });
        return false;
      }
      return true;
    })
    .sort(
      (x, y) => x.path.split('/').length - y.path.split('/').length || x.path.localeCompare(y.path),
    );
  if (!files.length) throw new AppError('import_invalid');

  const created: PageTreeItem[] = [];
  const folders = new Map<string, string>();
  const seen = new Set<string>();
  const imported = new Map<string, { id: string; name: string; content: string }>();
  const ensureFolder = async (dir: string): Promise<string | null> => {
    if (!dir) return input.parentId;
    const known = folders.get(dir);
    if (known) return known;
    const parts = dir.split('/');
    const parentId = await ensureFolder(parts.slice(0, -1).join('/'));
    const page = await createPage(deps, a, spaceId, { parentId, name: parts.at(-1)! }, opts);
    folders.set(dir, page.id);
    created.push(treeItem(page));
    return page.id;
  };

  for (const f of files) {
    const key = f.path.toLowerCase();
    if (seen.has(key)) {
      warnings.push({ path: f.path, code: 'duplicate' });
      continue;
    }
    seen.add(key);
    const dir = f.path.split('/').slice(0, -1).join('/');
    const base = f.path
      .split('/')
      .at(-1)!
      .replace(/\.(md|markdown)$/i, '');
    let content = f.content.replace(/^\uFEFF/, '');
    let title = base;
    const heading = /^#\s+(.+)\r?\n/.exec(content);
    if (heading) {
      title = heading[1]!.trim();
      content = content.slice(heading[0].length);
    }
    const folderKey = dir ? `${dir}/${base}` : base;
    const existing = folders.get(folderKey);
    if (existing) {
      // `Ops.md` after `Ops/…` created the "Ops" page: fill it.
      await deps.db
        .update(pages)
        .set({ ydoc: stateFromJson(markdownToDoc(content)) })
        .where(eq(pages.nodeId, existing));
      await derivePage(deps, existing, true);
      imported.set(f.path, { id: existing, name: base, content });
      continue;
    }
    const parentId = await ensureFolder(dir);
    const page = await createPage(
      deps,
      a,
      spaceId,
      { parentId, name: title.slice(0, 255), markdown: content },
      opts,
    );
    folders.set(folderKey, page.id);
    created.push(treeItem(page));
    imported.set(f.path, { id: page.id, name: page.name, content });
  }

  // Every page has an address now: links between the files can point at them.
  const resolve = importLinkResolver([...imported.keys()]);
  for (const [path, page] of imported) {
    if (!/\.(md|markdown)/i.test(page.content)) continue;
    const doc = markdownToDoc(page.content);
    const relinked = relinkPages(doc.content, (href) => {
      const target = imported.get(resolve(href, path) ?? '');
      return target ? pagePath(target) : null;
    });
    if (!relinked) continue;
    await deps.db
      .update(pages)
      .set({ ydoc: stateFromJson(doc) })
      .where(eq(pages.nodeId, page.id));
    await derivePage(deps, page.id, true);
  }
  return { pages: created, warnings };
}

/** Points the links `to` knows at their new address; true when any changed. */
function relinkPages(nodes: PMNode[], to: (href: string) => string | null): boolean {
  let changed = false;
  for (const node of nodes) {
    for (const mark of node.marks ?? []) {
      const href = mark.attrs?.href;
      const next = mark.type === 'link' && typeof href === 'string' ? to(href) : null;
      if (next) {
        mark.attrs = { ...mark.attrs, href: next };
        changed = true;
      }
    }
    if (node.content && relinkPages(node.content, to)) changed = true;
  }
  return changed;
}

const treeItem = (p: Page): PageTreeItem => ({
  id: p.id,
  parentId: p.parentId,
  name: p.name,
  icon: p.icon,
  position: '',
  hasChildren: false,
  myRole: p.myRole,
  favorite: p.favorite,
  updatedAt: p.updatedAt,
});

/* ---------------------------------- collab ------------------------------------ */

export async function collabToken(
  db: DbOrTx,
  env: Env,
  a: DriveActor,
  nodeId: string,
  source: 'web' | 'mobile',
): Promise<PageCollabToken> {
  const access = await loadPage(db, a, nodeId);
  const exp = Math.floor(Date.now() / 1000) + COLLAB_TOKEN_TTL_SECONDS;
  const documentName = pageDocumentName(nodeId);
  return {
    token: signCollabToken(env.AUTH_SECRET, {
      d: documentName,
      u: a.userId,
      o: a.org.id,
      src: source,
      exp,
    }),
    url: clientCollabUrl(env, collabConfig(env).publicUrl, source === 'mobile'),
    documentName,
    expiresAt: new Date(exp * 1000).toISOString(),
    readOnly: !canEditBody(a, access),
  };
}

/* --------------------------------- backlinks ---------------------------------- */

export async function backlinks(db: DbOrTx, a: DriveActor, nodeId: string): Promise<Backlink[]> {
  await loadPage(db, a, nodeId);
  const rows = await db
    .select({ ref: pageRefs, node: nodes, icon: pages.icon })
    .from(pageRefs)
    .innerJoin(nodes, eq(nodes.id, pageRefs.fromNodeId))
    .leftJoin(pages, eq(pages.nodeId, nodes.id))
    .where(and(eq(pageRefs.toNodeId, nodeId), isNull(nodes.deletedAt)));
  const out = new Map<string, Backlink>();
  const roles = new Map<string, Awaited<ReturnType<typeof spaceRoleOf>>>();
  const shares = new Map<string, Awaited<ReturnType<typeof userSharePaths>>>();
  for (const r of rows) {
    if (!roles.has(r.node.spaceId)) {
      roles.set(r.node.spaceId, await spaceRoleOf(db, r.node.spaceId, a.userId));
      shares.set(r.node.spaceId, await userSharePaths(db, r.node.spaceId, a.userId));
    }
    const role = roleForPath(roles.get(r.node.spaceId)!, shares.get(r.node.spaceId)!, r.node.path);
    if (!role || !can(a.actor, 'space.view', nodeResource(a, role))) continue;
    const item = out.get(r.node.id) ?? {
      node: {
        id: r.node.id,
        name: r.node.name,
        type: r.node.type,
        icon: r.icon ?? null,
        spaceId: r.node.spaceId,
      },
      kinds: [],
      updatedAt: r.node.updatedAt.toISOString(),
    };
    if (!item.kinds.includes(r.ref.kind)) item.kinds.push(r.ref.kind);
    out.set(r.node.id, item);
  }
  return [...out.values()].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
}
