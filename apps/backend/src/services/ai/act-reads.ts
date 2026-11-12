import { z } from 'zod';
import type { Deps } from '../../deps';
import { boardDetail } from '../boards/boards';
import type { DriveActor } from '../drive/access';
import {
  candidateList,
  findPages,
  findTodoCard,
  homeCards,
  homeCardsText,
  pageMarkdown,
  resolvePage,
  todoCardsOf,
} from './assistant-data';
import { isAskTool, runTools, type AskToolName } from './ask-tools';
import type { AiCaller } from './run';

/**
 * What "Yap" may look at before it answers or plans: the model asks with `{"reads":[…]}`, the server
 * reads with the person's rights and asks again with the results. It works the same on every
 * provider. The results are material for the model, never instructions.
 */

const Text = z.string().trim().max(200);

const Read = z.discriminatedUnion('type', [
  z.object({ type: z.literal('home_cards') }),
  z.object({ type: z.literal('read_todo_card'), card: Text.nullish() }),
  z.object({ type: z.literal('find_pages'), query: Text.min(1), space: Text.nullish() }),
  z.object({ type: z.literal('read_page'), page: Text.min(1), space: Text.nullish() }),
  z.object({ type: z.literal('read_board'), board: Text.min(1) }),
]);
type Read = z.infer<typeof Read>;

export const MAX_READS = 5;
/** A result the model gets at once, and all results of a turn together. */
const RESULT_CHARS = 4_000;
const TURN_CHARS = 12_000;
const BOARD_CARDS = 40;

export interface AssistantRead {
  type: string;
  args: Record<string, unknown>;
}

/** The reads in a reply: known kinds only, at most a few. */
export function parseReads(raw: unknown[]): AssistantRead[] {
  const out: AssistantRead[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { type, ...args } = item as Record<string, unknown>;
    if (typeof type !== 'string') continue;
    if (Read.safeParse(item).success || isAskTool(type)) out.push({ type, args });
  }
  return out.slice(0, MAX_READS);
}

export interface ReadCtx {
  deps: Deps;
  caller: AiCaller;
  a: DriveActor;
  tz: string;
  /** Boards the person reaches: a board's id by its key or name. */
  findBoard(ref: string): { id: string; name: string } | null;
}

const clip = (s: string) =>
  s.length > RESULT_CHARS ? `${s.slice(0, RESULT_CHARS)}\n… (cut off here)` : s;

async function readOne(read: Read, ctx: ReadCtx): Promise<string> {
  const { a } = ctx;
  const { db } = ctx.deps;
  switch (read.type) {
    case 'home_cards':
      return homeCardsText(await homeCards(db, a));
    case 'read_todo_card': {
      const cards = await todoCardsOf(db, a);
      if (!cards.length) return '(no to-do cards on the home page)';
      const card = findTodoCard(cards, read.card);
      const shown = card ? [card] : cards;
      if (read.card?.trim() && !card) {
        return `No to-do card named "${read.card}". The cards: ${cards.map((c) => c.title).join(', ')}`;
      }
      return shown
        .map((c) =>
          [
            `${c.title}:`,
            ...(c.items.length
              ? c.items.map((i) => `  [${i.done ? 'x' : ' '}] ${i.text}`)
              : ['  (no items)']),
          ].join('\n'),
        )
        .join('\n');
    }
    case 'find_pages': {
      const pages = await findPages(db, a, read.query, read.space);
      return pages.length ? candidateList(pages) : `(no page matches "${read.query}")`;
    }
    case 'read_page': {
      const match = await resolvePage(db, a, read.page, read.space);
      if (!match) return `(no page named "${read.page}")`;
      if ('candidates' in match) return `Several pages match: ${candidateList(match.candidates)}`;
      const body = await pageMarkdown(db, a, match.page.id);
      return `${match.page.name} (${match.page.space}):\n${body || '(the page is empty)'}`;
    }
    case 'read_board': {
      const board = ctx.findBoard(read.board);
      if (!board) return `(no board named "${read.board}")`;
      const detail = await boardDetail(db, a, board.id);
      const columns = new Map(detail.columns.map((c) => [c.id, c.name]));
      const cards = detail.cards
        .slice(0, BOARD_CARDS)
        .map(
          (c) =>
            `${detail.board.settings.key}-${c.number} ${c.title} · ${columns.get(c.columnId) ?? '?'}`,
        );
      return [`${board.name}:`, ...(cards.length ? cards : ['(no cards)'])].join('\n');
    }
  }
}

/** Runs the reads and returns each result as a block for <read_results>. */
export async function runReads(reads: AssistantRead[], ctx: ReadCtx): Promise<string[]> {
  const out: string[] = [];
  let size = 0;
  for (const { type, args } of reads) {
    let result: string;
    try {
      const own = Read.safeParse({ type, ...args });
      if (own.success) {
        result = await readOne(own.data, ctx);
      } else {
        const [run] = await runTools(
          ctx.deps,
          ctx.caller,
          [{ name: type as AskToolName, args }],
          ctx.tz,
        );
        result = run?.sources.length
          ? run.sources.map((s) => s.text).join('\n')
          : `(${run?.checked ?? type}: nothing found)`;
      }
    } catch (err) {
      ctx.deps.logger.warn({ err, read: type }, 'assistant read failed');
      result = '(this could not be read: no access, or it is gone)';
    }
    const block = `<result type="${type}" args='${JSON.stringify(args).replace(/'/g, '’')}'>\n${clip(result)}\n</result>`;
    size += block.length;
    if (size > TURN_CHARS) {
      out.push(`<result type="${type}">(left out: too much read this turn)</result>`);
      continue;
    }
    out.push(block);
  }
  return out;
}
