import { eq } from 'drizzle-orm';
import { boardColumns, boards, users, type Db, type DbOrTx } from '@crewhall/db';
import type { AppLocale } from '@crewhall/i18n';
import type {
  ApplyTemplateResult,
  BoardTemplateContent,
  PageTemplateContent,
  SpaceTemplateContent,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import type { Jobs } from '../../jobs/queue';
import type { Logger } from '../../logger';
import type { Bus } from '../../realtime/bus';
import type { PresenceReader } from '../../realtime/presence';
import { keyBetween } from '../../util/position';
import { createBoard } from '../boards/boards';
import { createCard } from '../boards/cards';
import { inBoardsTx } from '../boards/integrations';
import { boardsEnabled } from '../boards/module';
import type { DriveActor } from '../drive/access';
import { freeName } from '../drive/tree';
import { isModuleEnabled } from '../identity/modules';
import { fillPlaceholders } from '../wiki/builtin-templates';
import { createPage } from '../wiki/pages';
import { resolveTemplate } from './service';

/**
 * Creates a template's content (roadmap 8): a page, a board with its starter cards, or a
 * space's pages and boards in the space root. Pages need the wiki module, boards the boards
 * module; for a space template the part of a switched-off module is skipped and reported.
 */

export interface ApplyDeps {
  db: Db;
  logger: Logger;
  jobs: Jobs;
  bus: Bus;
  presence?: PresenceReader | null;
}

type Created = ApplyTemplateResult['nodes'][number];

async function placeholders(db: DbOrTx, a: DriveActor, locale: AppLocale) {
  const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, a.userId));
  return {
    date: new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date()),
    author: me?.name ?? '',
  };
}

async function makePage(
  deps: ApplyDeps,
  a: DriveActor,
  spaceId: string,
  parentId: string | null,
  name: string,
  content: PageTemplateContent,
  locale: AppLocale,
  values: { date: string; author: string },
): Promise<Created> {
  const page = await createPage(
    deps,
    a,
    spaceId,
    {
      parentId,
      name,
      icon: content.icon,
      markdown: fillPlaceholders(content.markdown, values),
    },
    { source: 'web', locale },
  );
  return { id: page.id, type: 'page', name: page.name };
}

async function makeBoard(
  deps: ApplyDeps,
  a: DriveActor,
  spaceId: string,
  parentId: string | null,
  name: string,
  content: BoardTemplateContent,
  locale: AppLocale,
  req: RequestInfo,
): Promise<Created> {
  return inBoardsTx(deps, async (tx) => {
    const free = await freeName(tx, spaceId, parentId, name);
    const board = await createBoard(
      tx,
      a,
      spaceId,
      { parentId, name: free, template: 'empty', cardChats: true },
      locale,
      req,
    );
    // The template's own columns, labels and fields replace the empty board's.
    await tx.delete(boardColumns).where(eq(boardColumns.boardNodeId, board.id));
    const columnIds: string[] = [];
    let pos: string | null = null;
    for (const col of content.columns) {
      pos = keyBetween(pos, null);
      const [row] = await tx
        .insert(boardColumns)
        .values({
          orgId: a.org.id,
          boardNodeId: board.id,
          position: pos,
          name: col.name,
          wipLimit: col.wipLimit,
          isDone: col.isDone,
        })
        .returning({ id: boardColumns.id });
      columnIds.push(row!.id);
    }
    await tx
      .update(boards)
      .set({
        settings: {
          ...board.settings,
          labels: content.labels,
          fields: content.fields,
        },
      })
      .where(eq(boards.nodeId, board.id));
    const labelIds = new Set(content.labels.map((l) => l.id));
    for (const card of content.cards) {
      const columnId = columnIds[card.column];
      if (!columnId) continue;
      await createCard(tx, a, board.id, {
        columnId,
        title: card.title,
        description: card.description || undefined,
        labels: card.labels.filter((l) => labelIds.has(l)),
        assigneeIds: [],
        dueAt: null,
        afterId: null,
        beforeId: null,
        top: false,
      });
    }
    return { id: board.id, type: 'board' as const, name: board.name };
  });
}

export async function applyTemplate(
  deps: ApplyDeps,
  a: DriveActor,
  templateId: string,
  input: { spaceId: string; parentId: string | null },
  locale: AppLocale,
  req: RequestInfo,
): Promise<ApplyTemplateResult> {
  const t = await resolveTemplate(deps.db, a, templateId, locale, input.spaceId);
  const wiki = await isModuleEnabled(deps.db, a.org.id, 'wiki');
  const boardsOn = await boardsEnabled(deps.db, a.org.id);
  const values = await placeholders(deps.db, a, locale);

  if (t.kind === 'page') {
    if (!wiki) throw new AppError('module_disabled', { module: 'wiki' });
    const node = await makePage(
      deps,
      a,
      input.spaceId,
      input.parentId,
      t.name,
      t.content as PageTemplateContent,
      locale,
      values,
    );
    return { nodes: [node], skipped: [] };
  }
  if (t.kind === 'board') {
    if (!boardsOn) throw new AppError('module_disabled', { module: 'boards' });
    const node = await makeBoard(
      deps,
      a,
      input.spaceId,
      input.parentId,
      t.name,
      t.content as BoardTemplateContent,
      locale,
      req,
    );
    return { nodes: [node], skipped: [] };
  }

  // A space: its pages (parents first) and boards, in the space root.
  const space = t.content as SpaceTemplateContent;
  const nodes: Created[] = [];
  const skipped: string[] = [];
  if (space.pages.length && !wiki) skipped.push('wiki');
  if (space.boards.length && !boardsOn) skipped.push('boards');
  if (wiki) {
    const ids = new Map<string, string>();
    const pending = [...space.pages];
    // Parents first: keep taking pages whose parent exists (or that have none).
    while (pending.length) {
      const i = pending.findIndex(
        (p) => !p.parent || ids.has(p.parent) || !space.pages.some((q) => q.key === p.parent),
      );
      const p = pending.splice(i === -1 ? 0 : i, 1)[0]!;
      const parentId = p.parent ? (ids.get(p.parent) ?? null) : null;
      const node = await makePage(
        deps,
        a,
        input.spaceId,
        parentId,
        p.name,
        { markdown: p.markdown, icon: p.icon },
        locale,
        values,
      );
      ids.set(p.key, node.id);
      if (!p.parent) nodes.push(node);
    }
  }
  if (boardsOn) {
    for (const b of space.boards) {
      nodes.push(await makeBoard(deps, a, input.spaceId, null, b.name, b.board, locale, req));
    }
  }
  return { nodes, skipped };
}
