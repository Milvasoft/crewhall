import { and, eq, inArray, isNull } from 'drizzle-orm';
import { nodes, surfaceCards, surfaces, type DbOrTx } from '@crewhall/db';
import { TodoConfig } from '@crewhall/shared';
import { reachableSpaceIds, type DriveActor } from '../drive/access';
import { searchNodes } from '../drive/personal';
import { pageContent } from '../wiki/pages';

/**
 * What the assistant can really read, with the person's own rights: their home cards and the pages
 * they can see. "Yap" and "Sor" both use it, and the carrying actions (act-transfer.ts) take their
 * items from here, so what reaches a page or a card is what was on the source, not what a model
 * remembers. The vault is never read: its cards are left out altogether.
 */

export const fold = (s: string) => s.trim().toLocaleLowerCase('tr');

// ---------------------------------------------------------------------------------------
// Home cards
// ---------------------------------------------------------------------------------------

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

export interface TodoCard {
  id: string;
  title: string;
  items: TodoItem[];
}

/**
 * To-do cards on the person's own home page (Benim), with their items. Space surfaces and pinned
 * copies are left out: the assistant only writes on the person's own lists.
 */
export async function todoCardsOf(db: DbOrTx, a: DriveActor): Promise<TodoCard[]> {
  const rows = await db
    .select({ id: surfaceCards.id, config: surfaceCards.config })
    .from(surfaceCards)
    .innerJoin(surfaces, eq(surfaces.id, surfaceCards.surfaceId))
    .where(
      and(
        eq(surfaces.orgId, a.org.id),
        eq(surfaces.ownerType, 'user'),
        eq(surfaces.ownerId, a.userId),
        eq(surfaceCards.type, 'todo'),
        isNull(surfaceCards.pinnedFromCardId),
        isNull(surfaceCards.deletedAt),
      ),
    )
    .orderBy(surfaceCards.y, surfaceCards.x)
    .limit(50);
  return rows.flatMap((r) => {
    const config = TodoConfig.safeParse(r.config);
    if (!config.success) return [];
    return [
      {
        id: r.id,
        title: config.data.title,
        items: config.data.items.map((i) => ({ id: i.id, text: i.text, done: i.done })),
      },
    ];
  });
}

/** The card a name means: the exact title, one loose match, or the only card when none is named. */
export function findTodoCard(list: TodoCard[], ref: string | null | undefined): TodoCard | null {
  if (!ref?.trim()) return list.length === 1 ? list[0]! : null;
  const r = fold(ref);
  const exact = list.filter((c) => fold(c.title) === r);
  if (exact.length === 1) return exact[0]!;
  const loose = list.filter((c) => fold(c.title).includes(r) || r.includes(fold(c.title)));
  return loose.length === 1 ? loose[0]! : list.length === 1 ? list[0]! : null;
}

export const openItems = (card: TodoCard) => card.items.filter((i) => !i.done);

export interface HomeCard {
  id: string;
  type: string;
  title: string;
  /** Lines of what is on the card: to-do items, a note's text, link names. */
  lines: string[];
}

const NOTE_CHARS = 2_000;

type Config = Record<string, unknown>;
const text = (v: unknown) => (typeof v === 'string' ? v : '');

function linkTitles(config: Config): string[] {
  const sections = Array.isArray(config.sections) ? (config.sections as Config[]) : [];
  return sections.flatMap((s) =>
    (Array.isArray(s.items) ? (s.items as Config[]) : []).map((i) => text(i.title)),
  );
}

/** Every card on the person's home page except vault items, as text the model can read. */
export async function homeCards(db: DbOrTx, a: DriveActor): Promise<HomeCard[]> {
  const rows = await db
    .select({ id: surfaceCards.id, type: surfaceCards.type, config: surfaceCards.config })
    .from(surfaceCards)
    .innerJoin(surfaces, eq(surfaces.id, surfaceCards.surfaceId))
    .where(
      and(
        eq(surfaces.orgId, a.org.id),
        eq(surfaces.ownerType, 'user'),
        eq(surfaces.ownerId, a.userId),
        isNull(surfaceCards.deletedAt),
      ),
    )
    .orderBy(surfaceCards.y, surfaceCards.x)
    .limit(60);

  // Cards that point at a page or a file show its name, when the person can see it.
  const nodeIds = rows.flatMap((r) =>
    (r.type === 'node' || r.type === 'page') && typeof r.config.nodeId === 'string'
      ? [r.config.nodeId]
      : [],
  );
  const reachable = await reachableSpaceIds(db, a);
  const names = new Map(
    nodeIds.length && reachable.length
      ? (
          await db
            .select({ id: nodes.id, name: nodes.name })
            .from(nodes)
            .where(
              and(
                inArray(nodes.id, nodeIds),
                inArray(nodes.spaceId, reachable),
                eq(nodes.orgId, a.org.id),
                isNull(nodes.deletedAt),
              ),
            )
        ).map((n) => [n.id, n.name] as const)
      : [],
  );

  const cards: HomeCard[] = [];
  for (const { id, type, config } of rows) {
    switch (type) {
      case 'vault_item':
        break;
      case 'todo': {
        const parsed = TodoConfig.safeParse(config);
        if (!parsed.success) break;
        cards.push({
          id,
          type,
          title: parsed.data.title,
          lines: parsed.data.items.map((i) => `[${i.done ? 'x' : ' '}] ${i.text}`),
        });
        break;
      }
      case 'note':
        cards.push({ id, type, title: '', lines: [text(config.text).slice(0, NOTE_CHARS)] });
        break;
      case 'link':
        cards.push({
          id,
          type,
          title: text((config.item as Config | undefined)?.title),
          lines: [],
        });
        break;
      case 'link_group':
        cards.push({ id, type, title: text(config.title), lines: linkTitles(config) });
        break;
      case 'node':
      case 'page': {
        const name = typeof config.nodeId === 'string' ? names.get(config.nodeId) : undefined;
        if (name) cards.push({ id, type, title: name, lines: [] });
        break;
      }
      default:
        cards.push({ id, type, title: '', lines: [] });
    }
  }
  return cards;
}

export function homeCardsText(cards: HomeCard[]): string {
  if (!cards.length) return '(no cards on the home page)';
  return cards
    .map((c) => {
      const head = `${c.type}${c.title ? `: ${c.title}` : ''}`;
      if (c.type === 'todo' && !c.lines.length) return `${head}\n  (no items)`;
      return [head, ...c.lines.map((l) => `  ${l}`)].join('\n');
    })
    .join('\n');
}

// ---------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------

export interface PageRef {
  id: string;
  name: string;
  space: string;
}

/** Pages whose name matches, among those the person can see; optionally within a space. */
export async function findPages(
  db: DbOrTx,
  a: DriveActor,
  query: string,
  space?: string | null,
): Promise<PageRef[]> {
  const { items } = await searchNodes(db, a, { q: query.trim(), type: 'page', limit: 20 });
  const wanted = space?.trim() ? fold(space) : null;
  return items
    .filter((h) => h.matchedIn === 'name')
    .filter(
      (h) => !wanted || fold(h.space.name).includes(wanted) || wanted.includes(fold(h.space.name)),
    )
    .map((h) => ({ id: h.node.id, name: h.node.name, space: h.space.name }));
}

export type PageMatch = { page: PageRef } | { candidates: PageRef[] } | null;

/**
 * The page a name means. One exact title wins, then one loose match; several are returned as
 * candidates for the person to choose from, and the wrong one is never guessed.
 */
export async function resolvePage(
  db: DbOrTx,
  a: DriveActor,
  ref: string,
  space?: string | null,
): Promise<PageMatch> {
  const found = await findPages(db, a, ref, space);
  const exact = found.filter((p) => fold(p.name) === fold(ref));
  if (exact.length === 1) return { page: exact[0]! };
  if (exact.length > 1) return { candidates: exact };
  const loose = found.filter((p) => fold(p.name).includes(fold(ref)));
  if (loose.length === 1) return { page: loose[0]! };
  if (loose.length > 1) return { candidates: loose };
  return found.length === 1 ? { page: found[0]! } : found.length ? { candidates: found } : null;
}

export const candidateList = (pages: PageRef[]) =>
  pages
    .slice(0, 6)
    .map((p) => `${p.name} (${p.space})`)
    .join(', ');

export async function pageMarkdown(db: DbOrTx, a: DriveActor, nodeId: string): Promise<string> {
  return (await pageContent(db, a, nodeId, 'markdown')).markdown.trim();
}

export interface ListItem {
  text: string;
  done: boolean;
}

const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/;
/** Markup around the words: emphasis, inline code, a link's address. */
const inlinePlain = (s: string) =>
  s
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, '$1$2')
    .trim();

/**
 * The items of a page's body: its list lines (checkboxes keep their state). A page without any list
 * gives its other lines, one item each, so a plain note can become a list too.
 */
export function listItemsOf(markdown: string): ListItem[] {
  const lines = markdown.split(/\r?\n/);
  const listed: ListItem[] = [];
  for (const line of lines) {
    const m = LIST_LINE.exec(line);
    if (!m) continue;
    const item = inlinePlain(m[2]!);
    if (item) listed.push({ text: item, done: m[1] === 'x' || m[1] === 'X' });
  }
  if (listed.length) return listed;
  return lines
    .filter((l) => l.trim() && !/^\s*(#{1,6}\s|>|```|---|\|)/.test(l))
    .map((l) => ({ text: inlinePlain(l), done: false }))
    .filter((i) => i.text);
}

/** Letters and digits only: the same words survive a round through the editor's markdown. */
export const wordsOf = (s: string) =>
  s
    .toLocaleLowerCase('tr')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** The items that did not reach `body`. Empty means every one is really there. */
export function missingFrom(body: string, items: string[]): string[] {
  const have = wordsOf(body);
  return items.filter((i) => !have.includes(wordsOf(i)));
}

/** The items as a Markdown checklist, how a page holds a to-do list. */
export const checklist = (items: string[]) => items.map((t) => `- [ ] ${t}`).join('\n');
