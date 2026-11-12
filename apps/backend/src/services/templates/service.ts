import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  boardCards,
  boardColumns,
  nodes,
  pages,
  templates,
  users,
  type DbOrTx,
} from '@crewhall/db';
import type { AppLocale } from '@crewhall/i18n';
import {
  BoardLabel,
  BoardTemplateContent,
  can,
  PageTemplateContent,
  SpaceTemplateContent,
  type Template,
  type TemplateKind,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import { loadBoard } from '../boards/access';
import { loadSpace, nodeResource, reachableSpaceIds, type DriveActor } from '../drive/access';
import { orgContext } from '../membership';
import { loadPage } from '../wiki/access';
import { docFromState, docToJson } from '../wiki/doc';
import { docToMarkdown, markdownToDoc } from '../wiki/markdown';
import { pageTree } from '../wiki/pages';
import { ALL_BUILTINS, type Builtin } from './builtin';

/**
 * The template gallery (roadmap 8): built-ins from code plus saved templates of the caller's
 * reach: the org's, those of spaces the caller can open and their own. Saving captures a page
 * (Markdown), a board (columns, labels, fields, card skeletons) or a whole space (page tree and
 * boards); people, dates, comments, files and permissions are never copied.
 */

type Row = typeof templates.$inferSelect;
type Content = PageTemplateContent | BoardTemplateContent | SpaceTemplateContent;

export const SPACE_LIMITS = { pages: 50, boards: 10 };

const isOrgAdmin = (a: DriveActor) =>
  can(a.actor, 'org.update_settings', { type: 'org', org: orgContext(a.org) });

async function isSpaceAdmin(db: DbOrTx, a: DriveActor, spaceId: string) {
  try {
    const { role } = await loadSpace(db, a, spaceId);
    return can(a.actor, 'space.update_settings', nodeResource(a, role));
  } catch {
    return false;
  }
}

export function parseContent(kind: string, content: unknown): Content {
  if (kind === 'page') return PageTemplateContent.parse(content);
  if (kind === 'board') return BoardTemplateContent.parse(content);
  if (kind === 'space') return SpaceTemplateContent.parse(content);
  throw new AppError('not_found');
}

/** What a gallery card shows. */
function describe(kind: TemplateKind, content: Content): Pick<Template, 'preview' | 'summary'> {
  if (kind === 'page') {
    const { markdown } = content as PageTemplateContent;
    return {
      preview: markdown
        .split(/\n{2,}/)
        .slice(0, 6)
        .join('\n\n')
        .slice(0, 1200),
      summary: { blocks: markdownToDoc(markdown).content.length },
    };
  }
  if (kind === 'board') {
    const b = content as BoardTemplateContent;
    const columns = b.columns.map((c) => c.name);
    return {
      preview: columns.join(' · '),
      summary: { columns, cards: b.cards.length },
    };
  }
  const s = content as SpaceTemplateContent;
  const pageNames = s.pages.map((p) => p.name);
  const boardNames = s.boards.map((b) => b.name);
  return {
    preview: [...pageNames, ...boardNames].join(' · '),
    summary: { pages: pageNames, boards: boardNames },
  };
}

function fromBuiltin(b: Builtin, locale: AppLocale): Template {
  const content = b.content(locale);
  return {
    id: b.id,
    kind: b.kind,
    scope: 'builtin',
    spaceId: null,
    name: b.name[locale],
    description: b.description[locale],
    category: b.category,
    ...describe(b.kind, content),
    createdBy: null,
    canDelete: false,
  };
}

function fromRow(t: Row, u: typeof users.$inferSelect | null, canDelete: boolean): Template | null {
  let content: Content;
  try {
    content = parseContent(t.kind, t.content);
  } catch {
    return null; // a kind this version does not know (or a broken row) is left out
  }
  return {
    id: t.id,
    kind: t.kind as TemplateKind,
    scope: t.scope,
    spaceId: t.spaceId,
    name: t.name,
    description: t.description,
    category: t.category,
    ...describe(t.kind as TemplateKind, content),
    createdBy: u ? { id: u.id, name: u.name, email: u.email, imageUrl: u.image } : null,
    canDelete,
  };
}

/** Saved templates the caller may use: org-wide, of reachable spaces (or one space), own. */
async function visibleRows(db: DbOrTx, a: DriveActor, kind?: TemplateKind, spaceId?: string) {
  const spaceIds = spaceId ? [spaceId] : await reachableSpaceIds(db, a);
  return db
    .select({ t: templates, u: users })
    .from(templates)
    .leftJoin(users, eq(users.id, templates.createdBy))
    .where(
      and(
        eq(templates.orgId, a.org.id),
        kind ? eq(templates.kind, kind) : undefined,
        or(
          eq(templates.scope, 'org'),
          and(eq(templates.scope, 'personal'), eq(templates.ownerUserId, a.userId)),
          spaceIds.length
            ? and(eq(templates.scope, 'space'), inArray(templates.spaceId, spaceIds))
            : undefined,
        ),
      ),
    )
    .orderBy(asc(templates.name));
}

async function canDelete(db: DbOrTx, a: DriveActor, t: Row, adminSpaces: Map<string, boolean>) {
  if (t.scope === 'org') return isOrgAdmin(a);
  if (t.scope === 'personal') return t.ownerUserId === a.userId;
  if (!t.spaceId) return false;
  if (!adminSpaces.has(t.spaceId)) adminSpaces.set(t.spaceId, await isSpaceAdmin(db, a, t.spaceId));
  return adminSpaces.get(t.spaceId)!;
}

export async function listTemplates(
  db: DbOrTx,
  a: DriveActor,
  locale: AppLocale,
  q: { kind?: TemplateKind | undefined; spaceId?: string | undefined },
) {
  const builtin = ALL_BUILTINS.filter((b) => !q.kind || b.kind === q.kind).map((b) =>
    fromBuiltin(b, locale),
  );
  const rows = await visibleRows(db, a, q.kind, q.spaceId);
  const adminSpaces = new Map<string, boolean>();
  const saved: Template[] = [];
  for (const r of rows) {
    const t = fromRow(r.t, r.u, await canDelete(db, a, r.t, adminSpaces));
    if (t) saved.push(t);
  }
  return { items: [...builtin, ...saved], canCreateOrg: isOrgAdmin(a) };
}

/** A template's content as the caller may use it (not found when out of reach). */
export async function resolveTemplate(
  db: DbOrTx,
  a: DriveActor,
  templateId: string,
  locale: AppLocale,
  targetSpaceId?: string,
): Promise<{ kind: TemplateKind; name: string; content: Content }> {
  if (templateId.startsWith('builtin:')) {
    const b = ALL_BUILTINS.find((x) => x.id === templateId);
    if (!b) throw new AppError('not_found', { field: 'templateId' });
    return { kind: b.kind, name: b.name[locale], content: b.content(locale) };
  }
  if (!/^[0-9a-f-]{36}$/i.test(templateId))
    throw new AppError('not_found', { field: 'templateId' });
  const [t] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.id, templateId), eq(templates.orgId, a.org.id)));
  let ok = false;
  if (t?.scope === 'org') ok = true;
  else if (t?.scope === 'personal') ok = t.ownerUserId === a.userId;
  else if (t?.scope === 'space' && t.spaceId) {
    ok = t.spaceId === targetSpaceId || (await reachableSpaceIds(db, a)).includes(t.spaceId);
  }
  if (!t || !ok) throw new AppError('not_found', { field: 'templateId' });
  return { kind: t.kind as TemplateKind, name: t.name, content: parseContent(t.kind, t.content) };
}

/* ------------------------------- capturing content ------------------------------- */

async function boardContent(db: DbOrTx, a: DriveActor, boardId: string) {
  const access = await loadBoard(db, a, boardId);
  const columns = await db
    .select()
    .from(boardColumns)
    .where(eq(boardColumns.boardNodeId, boardId))
    .orderBy(asc(boardColumns.position));
  const index = new Map(columns.map((c, i) => [c.id, i]));
  const cards = await db
    .select({
      columnId: boardCards.columnId,
      title: boardCards.title,
      labels: boardCards.labels,
      text: boardCards.descText,
    })
    .from(boardCards)
    .where(
      and(
        eq(boardCards.boardNodeId, boardId),
        isNull(boardCards.archivedAt),
        isNull(boardCards.deletedAt),
      ),
    )
    .orderBy(asc(boardCards.position))
    .limit(200);
  const settings = access.board.settings;
  return {
    name: access.node.name,
    content: BoardTemplateContent.parse({
      columns: columns.map((c) => ({ name: c.name, wipLimit: c.wipLimit, isDone: c.isDone })),
      labels: settings.labels.flatMap((l) => {
        const label = BoardLabel.safeParse(l);
        return label.success ? [label.data] : [];
      }),
      fields: settings.fields,
      cards: cards
        .filter((c) => index.has(c.columnId))
        .map((c) => ({
          column: index.get(c.columnId)!,
          title: c.title,
          labels: c.labels.slice(0, 10),
          description: c.text.slice(0, 10_000),
        })),
    }),
  };
}

async function pageContent(db: DbOrTx, a: DriveActor, nodeId: string) {
  const access = await loadPage(db, a, nodeId);
  return {
    access,
    content: PageTemplateContent.parse({
      markdown: docToMarkdown(docToJson(docFromState(access.page.ydoc))),
      icon: access.page.icon,
    }),
  };
}

async function spaceContent(db: DbOrTx, a: DriveActor, spaceId: string) {
  await loadSpace(db, a, spaceId);
  const tree = await pageTree(db, a, spaceId);
  const items = tree.items
    .slice()
    .sort((x, y) => (x.position < y.position ? -1 : x.position > y.position ? 1 : 0));
  // Parents first, so every page's parent is already in the list.
  const depth = new Map<string, number>();
  const byId = new Map(items.map((i) => [i.id, i]));
  const depthOf = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    const parent = byId.get(id)?.parentId;
    const d = parent && byId.has(parent) ? depthOf(parent) + 1 : 0;
    depth.set(id, d);
    return d;
  };
  const chosen = items
    .slice()
    .sort((x, y) => depthOf(x.id) - depthOf(y.id))
    .slice(0, SPACE_LIMITS.pages);
  const keep = new Set(chosen.map((c) => c.id));
  const bodies = chosen.length
    ? await db
        .select({ id: pages.nodeId, ydoc: pages.ydoc })
        .from(pages)
        .where(inArray(pages.nodeId, [...keep]))
    : [];
  const body = new Map(bodies.map((b) => [b.id, docToMarkdown(docToJson(docFromState(b.ydoc)))]));
  const boardRows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.spaceId, spaceId), eq(nodes.type, 'board'), isNull(nodes.deletedAt)))
    .orderBy(asc(nodes.position))
    .limit(SPACE_LIMITS.boards);
  const boardsOut: SpaceTemplateContent['boards'] = [];
  for (const b of boardRows) {
    try {
      const { name, content } = await boardContent(db, a, b.id);
      boardsOut.push({ name, board: content });
    } catch {
      // a board the person cannot open is left out
    }
  }
  return SpaceTemplateContent.parse({
    pages: chosen.map((p) => ({
      key: p.id,
      parent: p.parentId && keep.has(p.parentId) ? p.parentId : null,
      name: p.name,
      icon: p.icon,
      markdown: body.get(p.id) ?? '',
    })),
    boards: boardsOut,
  });
}

export async function createTemplate(
  db: DbOrTx,
  a: DriveActor,
  input: {
    kind: TemplateKind;
    scope: 'org' | 'space' | 'personal';
    nodeId?: string | undefined;
    spaceId?: string | undefined;
    name: string;
    description: string;
    category: string;
  },
): Promise<Template> {
  let content: Content;
  let homeSpace: string | null;
  if (input.kind === 'page') {
    if (!input.nodeId) throw new AppError('validation_failed', { field: 'nodeId' });
    const { access, content: c } = await pageContent(db, a, input.nodeId);
    content = c;
    homeSpace = access.space.id;
  } else if (input.kind === 'board') {
    if (!input.nodeId) throw new AppError('validation_failed', { field: 'nodeId' });
    const { content: c } = await boardContent(db, a, input.nodeId);
    content = c;
    const [n] = await db
      .select({ spaceId: nodes.spaceId })
      .from(nodes)
      .where(eq(nodes.id, input.nodeId));
    homeSpace = n?.spaceId ?? null;
  } else {
    if (!input.spaceId) throw new AppError('validation_failed', { field: 'spaceId' });
    content = await spaceContent(db, a, input.spaceId);
    homeSpace = input.spaceId;
  }

  if (input.scope === 'org' && !isOrgAdmin(a)) throw new AppError('forbidden');
  const spaceId = input.scope === 'space' ? homeSpace : null;
  if (input.scope === 'space' && (!spaceId || !(await isSpaceAdmin(db, a, spaceId)))) {
    throw new AppError('forbidden');
  }

  const [row] = await db
    .insert(templates)
    .values({
      orgId: a.org.id,
      kind: input.kind,
      scope: input.scope,
      spaceId,
      ownerUserId: input.scope === 'personal' ? a.userId : null,
      name: input.name,
      description: input.description,
      category: input.category,
      content: content as unknown as Record<string, unknown>,
      createdBy: a.userId,
    })
    .returning();
  const [u] = await db.select().from(users).where(eq(users.id, a.userId));
  return fromRow(row!, u ?? null, true)!;
}

export async function deleteTemplate(db: DbOrTx, a: DriveActor, templateId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(templateId)) throw new AppError('not_found');
  const [t] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.id, templateId), eq(templates.orgId, a.org.id)));
  if (!t) throw new AppError('not_found');
  const visible =
    t.scope === 'org' ||
    (t.scope === 'personal' && t.ownerUserId === a.userId) ||
    (t.scope === 'space' && t.spaceId && (await reachableSpaceIds(db, a)).includes(t.spaceId));
  if (!visible) throw new AppError('not_found');
  if (!(await canDelete(db, a, t, new Map()))) throw new AppError('forbidden');
  await db.delete(templates).where(eq(templates.id, templateId));
}
