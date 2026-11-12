import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { boardCards, surfaceCards, surfaces } from '@crewhall/db';
import { CreateBoardCard, pagePath, paths, TodoConfig } from '@crewhall/shared';
import { z } from 'zod';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { createCard as createBoardCard } from '../boards/cards';
import { inBoardsTx } from '../boards/integrations';
import { loadNode, type DriveActor } from '../drive/access';
import { isModuleEnabled } from '../identity/modules';
import {
  createCard as createSurfaceCard,
  ensureSurfaces,
  updateCard as updateSurfaceCard,
} from '../quick/surfaces';
import { canEditBody, loadPage } from '../wiki/access';
import { editPage } from '../wiki/live';
import { markdownToDoc } from '../wiki/markdown';
import { createPage } from '../wiki/pages';
import { resolveSpace, type MoreCtx, type Prepared } from './act-tools';
import {
  candidateList,
  checklist,
  findTodoCard,
  fold,
  listItemsOf,
  missingFrom,
  openItems,
  pageMarkdown,
  resolvePage,
  type TodoCard,
} from './assistant-data';

/**
 * Carrying content between to-do cards, pages and boards. The model only says what goes where: the
 * items are read here, from the source, with the person's rights, frozen into the proposal (the
 * approval shows them) and written by the server. A source with nothing on it gives a plain
 * sentence and no proposal, and an applied action reads its result back before it counts as done.
 */

const Name = z.string().trim().max(200);

export const TodoToPageAction = z.object({
  type: z.literal('todo_to_page'),
  /** A card from <todo_cards>; null = the only one. */
  todo_card: Name.nullish(),
  /** A new page's title; null = the card's title. */
  title: Name.nullish(),
  /** A space for the new page; null = the person's own space. */
  space: Name.nullish(),
  /** An existing page to add to, instead of a new one. */
  page: Name.nullish(),
  /** Leave out what is already ticked (the default). */
  only_open: z.boolean().nullish(),
  remove_from_card: z.boolean().nullish(),
});

export const PageToTasksAction = z.object({
  type: z.literal('page_to_tasks'),
  page: Name.min(1),
  space: Name.nullish(),
  /** "todo" (default) or a board's key or name. */
  target: Name.nullish(),
  /** A card from <todo_cards>; null = the only one, or a new card named after the page. */
  todo_card: Name.nullish(),
  /** A new to-do card's title. */
  new_card: Name.nullish(),
});

export const MoveTodoItemsAction = z.object({
  type: z.literal('move_todo_items'),
  /** The source card; null = the card holding these items. */
  from: Name.nullish(),
  to: Name.min(1),
  /** Items' text; null = every open item of the source. */
  items: z.array(z.string().trim().min(1).max(300)).max(200).nullish(),
});

export const TRANSFER_ACTIONS = [TodoToPageAction, PageToTasksAction, MoveTodoItemsAction] as const;
export type TransferAction = z.infer<(typeof TRANSFER_ACTIONS)[number]>;
export const TRANSFER_TYPES = new Set<string>(TRANSFER_ACTIONS.map((s) => s.shape.type.value));

export interface TransferCtx extends MoreCtx {
  todoCards: TodoCard[];
  /** A board's id and name by its key or name, among those the person reaches. */
  findBoard(ref: string): { id: string; name: string } | null;
}

/** What to-do items and board titles take. */
const TODO_MAX = 200;
const TODO_TEXT = 300;
const BOARD_TITLE = 200;
const BOARD_ITEMS = 50;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** "3 madde: Faturayı öde, Sunucuyu yedekle, …" */
function itemsDetail(items: string[], ctx: MoreCtx) {
  const shown = items.slice(0, 3).join(', ');
  const rest = items.length > 3 ? ', …' : '';
  return `${ctx.tx.itemCount.replace('{n}', String(items.length))}: ${clip(shown, 120)}${rest}`;
}

const isTodoTarget = (t: string | null | undefined) =>
  !t?.trim() || /^(todo|to-?do( ?list)?|yapılacak(lar|larım|lar listesi)?)$/i.test(t.trim());

async function prepareTodoToPage(
  action: z.infer<typeof TodoToPageAction>,
  ctx: TransferCtx,
): Promise<Prepared | string> {
  const { tx } = ctx;
  if (!(await isModuleEnabled(ctx.db, ctx.a.org.id, 'wiki'))) return tx.moduleOff;
  if (!ctx.todoCards.length) return tx.noTodoCard;
  const card = findTodoCard(ctx.todoCards, action.todo_card);
  if (!card) {
    return action.todo_card?.trim()
      ? tx.unknownTodoCard.replace('{card}', action.todo_card.trim())
      : tx.whichTodoCardFrom.replace('{cards}', ctx.todoCards.map((c) => c.title).join(', '));
  }
  const source = action.only_open === false ? card.items : openItems(card);
  if (!source.length) return tx.emptyTodoCard.replace('{card}', card.title);
  const texts = source.map((i) => i.text);
  const carried = {
    card_id: card.id,
    item_ids: source.map((i) => i.id),
    items: texts,
    remove_from_card: action.remove_from_card === true,
  };

  if (action.page?.trim()) {
    const match = await resolvePage(ctx.db, ctx.a, action.page, action.space);
    if (!match) return tx.unknownPage.replace('{name}', action.page);
    if ('candidates' in match) return whichPage(action.page, match.candidates, ctx);
    const access = await loadPage(ctx.db, ctx.a, match.page.id).catch(() => null);
    if (!access || !canEditBody(ctx.a, access)) {
      return tx.noAccess.replace('{title}', match.page.name);
    }
    return {
      kind: 'todo_to_page',
      tool: 'ai_todo_to_page',
      payload: { ...carried, node_id: match.page.id },
      title: match.page.name,
      detail: itemsDetail(texts, ctx),
      location: match.page.space,
      items: texts,
    };
  }

  const space = await resolveSpace(action.space, ctx);
  if (typeof space === 'string') return space;
  const title = action.title?.trim() || card.title;
  return {
    kind: 'todo_to_page',
    tool: 'ai_todo_to_page',
    payload: { ...carried, space_id: space.id, title, locale: ctx.locale },
    title,
    detail: itemsDetail(texts, ctx),
    location: space.name,
    items: texts,
  };
}

const whichPage = (name: string, pages: Parameters<typeof candidateList>[0], ctx: MoreCtx) =>
  ctx.tx.whichPage.replace('{name}', name).replace('{pages}', candidateList(pages));

async function preparePageToTasks(
  action: z.infer<typeof PageToTasksAction>,
  ctx: TransferCtx,
): Promise<Prepared | string> {
  const { tx } = ctx;
  if (!(await isModuleEnabled(ctx.db, ctx.a.org.id, 'wiki'))) return tx.moduleOff;
  const match = await resolvePage(ctx.db, ctx.a, action.page, action.space);
  if (!match) return tx.unknownPage.replace('{name}', action.page);
  if ('candidates' in match) return whichPage(action.page, match.candidates, ctx);
  const { page } = match;
  const body = await pageMarkdown(ctx.db, ctx.a, page.id).catch(() => null);
  if (body === null) return tx.noAccess.replace('{title}', page.name);
  const all = listItemsOf(body).filter((i) => !i.done);
  if (!all.length) return tx.emptyPage.replace('{name}', page.name);

  if (!isTodoTarget(action.target)) {
    const board = ctx.findBoard(action.target!);
    if (!board) return tx.unknownBoard.replace('{board}', action.target!);
    if (all.length > BOARD_ITEMS) {
      return tx.tooManyItems
        .replace('{name}', page.name)
        .replace('{n}', String(all.length))
        .replace('{max}', String(BOARD_ITEMS));
    }
    const titles = all.map((i) => clip(i.text, BOARD_TITLE));
    return {
      kind: 'page_to_tasks',
      tool: 'ai_page_to_board',
      payload: { board_id: board.id, titles },
      title: page.name,
      detail: `${board.name} · ${itemsDetail(titles, ctx)}`,
      location: board.name,
      items: titles,
    };
  }

  const texts = [...new Set(all.map((i) => clip(i.text, TODO_TEXT)))];
  const newCard = action.new_card?.trim();
  const named = action.todo_card?.trim();
  const card = newCard ? null : findTodoCard(ctx.todoCards, named);
  if (!card && !newCard) {
    if (named) return tx.unknownTodoCard.replace('{card}', named);
    if (ctx.todoCards.length) {
      return tx.whichTodoCard.replace('{cards}', ctx.todoCards.map((c) => c.title).join(', '));
    }
  }
  if (!card) {
    if (texts.length > TODO_MAX) {
      return tx.tooManyItems
        .replace('{name}', page.name)
        .replace('{n}', String(texts.length))
        .replace('{max}', String(TODO_MAX));
    }
    const title = clip(newCard || page.name, 60);
    return {
      kind: 'page_to_tasks',
      tool: 'ai_page_to_todo',
      payload: { new_card: title, items: texts },
      title: page.name,
      detail: `${tx.todoOn.replace('{card}', title)} · ${itemsDetail(texts, ctx)}`,
      location: title,
      items: texts,
    };
  }
  // Items already on the card are not written twice.
  const have = new Set(card.items.map((i) => fold(i.text)));
  const fresh = texts.filter((t) => !have.has(fold(t)));
  if (!fresh.length) return tx.alreadyOnCard.replace('{card}', card.title);
  if (card.items.length + fresh.length > TODO_MAX) {
    return tx.todoFull.replace('{card}', card.title).replace('{max}', String(TODO_MAX));
  }
  return {
    kind: 'page_to_tasks',
    tool: 'ai_page_to_todo',
    payload: { card_id: card.id, items: fresh },
    title: page.name,
    detail: `${tx.todoOn.replace('{card}', card.title)} · ${itemsDetail(fresh, ctx)}`,
    location: card.title,
    items: fresh,
  };
}

async function prepareMove(
  action: z.infer<typeof MoveTodoItemsAction>,
  ctx: TransferCtx,
): Promise<Prepared | string> {
  const { tx } = ctx;
  const cards = ctx.todoCards;
  if (!cards.length) return tx.noTodoCard;
  const exactCard = (ref: string) => cards.filter((c) => fold(c.title) === fold(ref));
  const to = exactCard(action.to)[0] ?? findLooseCard(cards, action.to);
  if (!to) return tx.unknownTodoCard.replace('{card}', action.to);

  const others = cards.filter((c) => c.id !== to.id);
  const wants = (text: string) =>
    !action.items?.length ||
    action.items.some((i) => fold(text) === fold(i) || fold(text).includes(fold(i)));
  let from: TodoCard | null;
  if (action.from?.trim()) {
    from = exactCard(action.from)[0] ?? findLooseCard(others, action.from);
    if (!from) return tx.unknownTodoCard.replace('{card}', action.from);
  } else {
    // Unnamed: the one other card, or the only one holding these items.
    const holding = others.filter((c) => c.items.some((i) => !i.done && wants(i.text)));
    from = others.length === 1 ? others[0]! : holding.length === 1 ? holding[0]! : null;
    if (!from) {
      return tx.whichTodoCardFrom.replace('{cards}', others.map((c) => c.title).join(', '));
    }
  }
  if (from.id === to.id) return tx.sameTodoCard.replace('{card}', to.title);
  const items = (action.items?.length ? from.items : openItems(from)).filter((i) => wants(i.text));
  if (!items.length) return tx.noSuchItems.replace('{card}', from.title);
  if (to.items.length + items.length > TODO_MAX) {
    return tx.todoFull.replace('{card}', to.title).replace('{max}', String(TODO_MAX));
  }
  const texts = items.map((i) => i.text);
  return {
    kind: 'move_todo_items',
    tool: 'ai_move_todo_items',
    payload: { from_id: from.id, to_id: to.id, item_ids: items.map((i) => i.id), items: texts },
    title: `${from.title} → ${to.title}`,
    detail: itemsDetail(texts, ctx),
    location: to.title,
    items: texts,
  };
}

function findLooseCard(list: TodoCard[], ref: string) {
  const r = fold(ref);
  const hits = list.filter((c) => fold(c.title).includes(r) || r.includes(fold(c.title)));
  return hits.length === 1 ? hits[0]! : null;
}

export function prepareTransfer(
  action: TransferAction,
  ctx: TransferCtx,
): Promise<Prepared | string> {
  switch (action.type) {
    case 'todo_to_page':
      return prepareTodoToPage(action, ctx);
    case 'page_to_tasks':
      return preparePageToTasks(action, ctx);
    case 'move_todo_items':
      return prepareMove(action, ctx);
  }
}

// ---------------------------------------------------------------------------------------
// After approval
// ---------------------------------------------------------------------------------------

interface ApplyResult {
  result: Record<string, unknown>;
}

const unverified = (what: string) => new AppError('ai_action_unverified', { what });

const ToPagePayload = z.object({
  card_id: z.uuid(),
  item_ids: z.array(z.uuid()),
  items: z.array(z.string()).min(1),
  remove_from_card: z.boolean(),
  node_id: z.uuid().optional(),
  space_id: z.uuid().optional(),
  title: z.string().optional(),
  locale: z.enum(['tr', 'en']).default('tr'),
});

const ToTodoPayload = z.object({
  card_id: z.uuid().optional(),
  new_card: z.string().optional(),
  items: z.array(z.string()).min(1),
});

const ToBoardPayload = z.object({ board_id: z.uuid(), titles: z.array(z.string()).min(1) });

const MovePayload = z.object({
  from_id: z.uuid(),
  to_id: z.uuid(),
  item_ids: z.array(z.uuid()).min(1),
});

type DbTx = Parameters<Parameters<Deps['db']['transaction']>[0]>[0];

/** The card locked for the transaction, with its items. */
async function lockTodo(tx: DbTx, cardId: string) {
  const [card] = await tx
    .select({ config: surfaceCards.config, type: surfaceCards.type })
    .from(surfaceCards)
    .where(and(eq(surfaceCards.id, cardId), isNull(surfaceCards.deletedAt)))
    .for('update');
  if (!card || card.type !== 'todo') throw new AppError('not_found');
  return TodoConfig.parse(card.config);
}

const newItem = (text: string) => ({ id: randomUUID(), text, done: false, doneAt: null });

async function readTodoTexts(live: Deps, cardId: string) {
  const [card] = await live.db
    .select({ config: surfaceCards.config })
    .from(surfaceCards)
    .where(and(eq(surfaceCards.id, cardId), isNull(surfaceCards.deletedAt)));
  return card ? TodoConfig.parse(card.config).items.map((i) => i.text) : [];
}

export const TRANSFER_APPLIERS: Record<
  string,
  (live: Deps, a: DriveActor, payload: Record<string, unknown>) => Promise<ApplyResult>
> = {
  async ai_todo_to_page(live, a, payload) {
    const p = ToPagePayload.parse(payload);
    const body = checklist(p.items);
    let nodeId: string;
    let name: string;
    if (p.node_id) {
      const access = await loadPage(live.db, a, p.node_id);
      if (!canEditBody(a, access)) throw new AppError('forbidden');
      await editPage(live, p.node_id, {
        op: 'append',
        doc: markdownToDoc(body),
        userId: a.userId,
        source: 'api',
      });
      nodeId = access.node.id;
      name = access.node.name;
    } else {
      // createPage checks the right to add content to the space again.
      const page = await createPage(
        live,
        a,
        z.uuid().parse(p.space_id),
        { parentId: null, name: p.title ?? '', markdown: body },
        { source: 'api', locale: p.locale },
      );
      nodeId = page.id;
      name = page.name;
    }
    // Read it back: the card is only touched once the page really holds every item.
    const missing = missingFrom(await pageMarkdown(live.db, a, nodeId), p.items);
    if (missing.length) throw unverified(missing.slice(0, 3).join(', '));
    if (p.remove_from_card) {
      await live.db.transaction(async (tx) => {
        const config = await lockTodo(tx, p.card_id);
        const gone = new Set(p.item_ids);
        await updateSurfaceCard(tx, a, p.card_id, {
          config: { ...config, items: config.items.filter((i) => !gone.has(i.id)) },
        });
      });
    }
    return {
      result: { node_id: nodeId, items: p.items.length, path: pagePath({ id: nodeId, name }) },
    };
  },

  async ai_page_to_todo(live, a, payload) {
    const p = ToTodoPayload.parse(payload);
    let cardId = p.card_id;
    if (cardId) {
      await live.db.transaction(async (tx) => {
        const config = await lockTodo(tx, cardId!);
        await updateSurfaceCard(tx, a, cardId!, {
          config: { ...config, items: [...config.items, ...p.items.map(newItem)] },
        });
      });
    } else {
      // No to-do card yet: one is opened on the person's home page.
      await ensureSurfaces(live.db, a);
      const [surface] = await live.db
        .select({ id: surfaces.id })
        .from(surfaces)
        .where(
          and(
            eq(surfaces.orgId, a.org.id),
            eq(surfaces.ownerType, 'user'),
            eq(surfaces.ownerId, a.userId),
          ),
        );
      if (!surface) throw new AppError('not_found');
      const card = await createSurfaceCard(
        live.db,
        a,
        surface.id,
        {
          type: 'todo',
          config: { title: z.string().parse(p.new_card), items: p.items.map(newItem) },
        },
        null,
      );
      cardId = card.id;
    }
    const missing = missingFrom((await readTodoTexts(live, cardId)).join('\n'), p.items);
    if (missing.length) throw unverified(missing.slice(0, 3).join(', '));
    return { result: { card_id: cardId, items: p.items.length, path: paths.home() } };
  },

  async ai_page_to_board(live, a, payload) {
    const p = ToBoardPayload.parse(payload);
    await loadNode(live.db, a, p.board_id);
    const [column] = await live.db
      .execute<{ id: string }>(
        sql`select id from board_columns where board_node_id = ${p.board_id}
            order by position collate "C" limit 1`,
      )
      .then((r) => r.rows);
    if (!column) throw new AppError('not_found');
    const ids = await inBoardsTx(live, async (tx) => {
      const out: string[] = [];
      for (const title of p.titles) {
        const card = await createBoardCard(
          tx,
          a,
          p.board_id,
          CreateBoardCard.parse({ columnId: column.id, title }),
        );
        out.push(card.id);
      }
      return out;
    });
    const rows = await live.db
      .select({ id: boardCards.id })
      .from(boardCards)
      .where(and(inArray(boardCards.id, ids), isNull(boardCards.deletedAt)));
    if (rows.length !== p.titles.length) throw unverified(p.titles[0]!);
    return {
      result: { board_id: p.board_id, items: rows.length, path: paths.board(p.board_id) },
    };
  },

  async ai_move_todo_items(live, a, payload) {
    const p = MovePayload.parse(payload);
    const moving = new Set(p.item_ids);
    const moved = await live.db.transaction(async (tx) => {
      // In one order, so two moves between the same cards wait instead of locking each other.
      const [first, second] = [p.from_id, p.to_id].sort();
      const configs = new Map([
        [first!, await lockTodo(tx, first!)],
        [second!, await lockTodo(tx, second!)],
      ]);
      const from = configs.get(p.from_id)!;
      const to = configs.get(p.to_id)!;
      const items = from.items.filter((i) => moving.has(i.id));
      // Something ticked or removed since the proposal is not moved behind the person's back.
      if (!items.length) throw new AppError('not_found');
      await updateSurfaceCard(tx, a, p.from_id, {
        config: { ...from, items: from.items.filter((i) => !moving.has(i.id)) },
      });
      await updateSurfaceCard(tx, a, p.to_id, {
        config: { ...to, items: [...to.items, ...items] },
      });
      return items.map((i) => i.text);
    });
    const missing = missingFrom((await readTodoTexts(live, p.to_id)).join('\n'), moved);
    if (missing.length) throw unverified(missing.slice(0, 3).join(', '));
    return { result: { card_id: p.to_id, items: moved.length, path: paths.home() } };
  },
};
