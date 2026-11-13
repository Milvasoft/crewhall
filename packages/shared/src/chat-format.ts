/**
 * Chat message formatting (kararlar.md 2026-11-13), shared by web and mobile so both read a
 * message the same way. The result is a tree of plain values: nothing here is ever HTML, and
 * clients render each node with their own components.
 *
 * Syntax (common chat style):
 * - `*bold*` or `**bold**`, `_italic_`, `~strike~` or `~~strike~~`; nesting is allowed.
 * - A marker opens only at a word start and closes only at a word end, on the same line, around
 *   non-blank text: `snake_case_name`, `2*3*4` and `a * b * c` stay as they are.
 * - Lines starting with `- `, `* ` or `• ` form a bulleted list; `1. ` or `1) ` a numbered one.
 * - Code (```fenced``` blocks and `inline` spans) is never formatted; links and mention tokens
 *   (`<@userId>`, `<@all>`, `<@here>`) are whole: markers inside them do nothing.
 */

export type ChatInline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; url: string }
  | { kind: 'mention'; userId: string }
  | { kind: 'bold' | 'italic' | 'strike'; children: ChatInline[] };

export type ChatBlock =
  | { kind: 'code'; text: string; lang?: string }
  /** Lines of text; `\n` inside text nodes is a line break. */
  | { kind: 'paragraph'; children: ChatInline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: ChatInline[][] };

/** Mention token of a person (`<@id>`) or a group (`<@all>`, `<@here>`). */
export const CHAT_MENTION_RE = /<@([0-9a-zA-Z-]+)>/g;
/** http(s) addresses; trailing punctuation and format markers stay outside. */
export const CHAT_URL_RE = /\bhttps?:\/\/[^\s<>"'`)]+[^\s<>"'`).,;:!?*_~]/g;

const FENCE_RE = /```([a-zA-Z0-9#+-]*)\n?([\s\S]*?)```/g;
const BULLET_RE = /^ {0,3}[-*•] +(.*)$/;
const NUMBER_RE = /^ {0,3}(\d{1,3})[.)] +(.*)$/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/u;

type Atom = Exclude<ChatInline, { kind: 'text' | 'bold' | 'italic' | 'strike' }>;
/** One character (code point) or a whole token. */
type Unit = string | Atom;

const MARKS = { '*': 'bold', _: 'italic', '~': 'strike' } as const;
type Mark = keyof typeof MARKS;
const isMark = (u: Unit | undefined): u is Mark => u === '*' || u === '_' || u === '~';
const isWord = (u: Unit | undefined) => u !== undefined && (typeof u !== 'string' || WORD.test(u));
const isSpace = (u: Unit | undefined) => typeof u === 'string' && SPACE.test(u);

function pushChars(out: Unit[], text: string) {
  for (const ch of text) out.push(ch);
}

/** Links and mentions become whole units; the rest is split into characters. */
function pushLinksAndMentions(out: Unit[], text: string) {
  const tokens: { at: number; len: number; atom: Atom }[] = [];
  for (const m of text.matchAll(CHAT_MENTION_RE)) {
    tokens.push({ at: m.index, len: m[0].length, atom: { kind: 'mention', userId: m[1]! } });
  }
  for (const m of text.matchAll(CHAT_URL_RE)) {
    if (tokens.some((t) => m.index < t.at + t.len && t.at < m.index + m[0].length)) continue;
    tokens.push({ at: m.index, len: m[0].length, atom: { kind: 'link', url: m[0] } });
  }
  tokens.sort((a, b) => a.at - b.at);
  let last = 0;
  for (const t of tokens) {
    pushChars(out, text.slice(last, t.at));
    out.push(t.atom);
    last = t.at + t.len;
  }
  pushChars(out, text.slice(last));
}

function toUnits(text: string): Unit[] {
  const out: Unit[] = [];
  // Inline code first: nothing inside it is a link, a mention or a marker.
  for (const [i, seg] of text.split(/(`[^`\n]+`)/g).entries()) {
    if (!seg) continue;
    if (i % 2 === 1) out.push({ kind: 'code', text: seg.slice(1, -1) });
    else pushLinksAndMentions(out, seg);
  }
  return out;
}

const runOf = (units: Unit[], at: number, mark: Mark) => {
  let n = 0;
  while (units[at + n] === mark) n++;
  return n;
};

/** Index of the marker run that closes `mark` × `len` opened before `from`, or -1. */
function findClose(units: Unit[], from: number, end: number, mark: Mark, len: number) {
  let j = from;
  while (j < end) {
    const u = units[j];
    if (u === '\n') return -1;
    if (u !== mark) {
      j++;
      continue;
    }
    const run = runOf(units, j, mark);
    if (
      run === len &&
      j > from &&
      j + run <= end &&
      !isSpace(units[j - 1]) &&
      !isWord(units[j + run])
    ) {
      return j;
    }
    j += run;
  }
  return -1;
}

function parseUnits(units: Unit[], start: number, end: number): ChatInline[] {
  const out: ChatInline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ kind: 'text', text: buf });
    buf = '';
  };
  let i = start;
  while (i < end) {
    const u = units[i]!;
    if (typeof u !== 'string') {
      flush();
      out.push(u);
      i++;
      continue;
    }
    if (isMark(u) && !isWord(units[i - 1]) && units[i - 1] !== u) {
      const run = runOf(units, i, u);
      // `**bold**` and `~~strike~~`; underscores only single.
      const len = run === 2 && u !== '_' ? 2 : run === 1 ? 1 : 0;
      const first = units[i + len];
      if (len && i + len < end && !isSpace(first)) {
        const close = findClose(units, i + len, end, u, len);
        if (close > 0) {
          flush();
          out.push({ kind: MARKS[u], children: parseUnits(units, i + len, close) });
          i = close + len;
          continue;
        }
      }
      buf += u.repeat(run);
      i += run;
      continue;
    }
    buf += u;
    i++;
  }
  flush();
  return out;
}

/** Inline formatting of one piece of text (no blocks): code, links, mentions and markers. */
export function parseChatInline(text: string): ChatInline[] {
  const units = toUnits(text);
  return parseUnits(units, 0, units.length);
}

function textBlocks(text: string, out: ChatBlock[]) {
  let para: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;
  const endPara = () => {
    if (para.length && para.join('').trim()) {
      out.push({ kind: 'paragraph', children: parseChatInline(para.join('\n')) });
    }
    para = [];
  };
  const endList = () => {
    if (list) {
      out.push({
        kind: 'list',
        ordered: list.ordered,
        start: list.start,
        items: list.items.map(parseChatInline),
      });
    }
    list = null;
  };
  for (const line of text.split('\n')) {
    const bullet = BULLET_RE.exec(line);
    const number = bullet ? null : NUMBER_RE.exec(line);
    const item = bullet?.[1] ?? number?.[2];
    if (item !== undefined && item.trim()) {
      const ordered = number !== null;
      endPara();
      if (list && list.ordered !== ordered) endList();
      list ??= { ordered, start: ordered ? Number(number[1]) : 1, items: [] };
      list.items.push(item);
      continue;
    }
    endList();
    para.push(line);
  }
  endPara();
  endList();
}

/** A message as blocks: fenced code, paragraphs and lists (doc 4.1, kararlar.md 2026-11-13). */
export function parseChatText(text: string): ChatBlock[] {
  const out: ChatBlock[] = [];
  let last = 0;
  for (const m of text.matchAll(FENCE_RE)) {
    // The line break around a fence belongs to the fence, not to the text.
    textBlocks(text.slice(last, m.index).replace(/\n$/, ''), out);
    out.push({
      kind: 'code',
      text: (m[2] ?? '').replace(/\n$/, ''),
      ...(m[1] ? { lang: m[1] } : {}),
    });
    last = m.index + m[0].length;
  }
  textBlocks(last ? text.slice(last).replace(/^\n/, '') : text, out);
  return out;
}

function inlinePlain(nodes: ChatInline[], mention: (userId: string) => string): string {
  return nodes
    .map((n) => {
      switch (n.kind) {
        case 'text':
        case 'code':
          return n.text;
        case 'link':
          return n.url;
        case 'mention':
          return mention(n.userId);
        default:
          return inlinePlain(n.children, mention);
      }
    })
    .join('');
}

/**
 * The text without format markers, for previews, notifications and search snippets: lists keep
 * a "•" or their number, mentions go through `mention` (default: the token as written).
 */
export function chatPlainText(
  text: string,
  mention: (userId: string) => string = (id) => `<@${id}>`,
): string {
  return parseChatText(text)
    .map((b) => {
      if (b.kind === 'code') return b.text;
      if (b.kind === 'paragraph') return inlinePlain(b.children, mention);
      return b.items
        .map((item, i) => `${b.ordered ? `${b.start + i}.` : '•'} ${inlinePlain(item, mention)}`)
        .join('\n');
    })
    .join('\n');
}

function collectLinks(nodes: ChatInline[], out: string[]) {
  for (const n of nodes) {
    if (n.kind === 'link') out.push(n.url);
    else if (n.kind === 'bold' || n.kind === 'italic' || n.kind === 'strike') {
      collectLinks(n.children, out);
    }
  }
}

/** The http(s) addresses of a message in order, without duplicates; code is skipped. */
export function chatTextLinks(text: string): string[] {
  const out: string[] = [];
  for (const b of parseChatText(text)) {
    if (b.kind === 'paragraph') collectLinks(b.children, out);
    else if (b.kind === 'list') for (const item of b.items) collectLinks(item, out);
  }
  return [...new Set(out)];
}

/** Composer shortcut: wraps `text[start, end)` in `mark`, or unwraps it when already wrapped. */
export function toggleChatMark(
  text: string,
  start: number,
  end: number,
  mark: '*' | '_' | '~',
): { text: string; start: number; end: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (before.endsWith(mark) && after.startsWith(mark)) {
    return {
      text: before.slice(0, -1) + text.slice(start, end) + after.slice(1),
      start: start - 1,
      end: end - 1,
    };
  }
  const inner = text.slice(start, end);
  if (inner.length >= 2 && inner.startsWith(mark) && inner.endsWith(mark)) {
    return { text: before + inner.slice(1, -1) + after, start, end: end - 2 };
  }
  // Spaces stay outside the markers, or the marker would not close (` *word *`).
  const lead = /^\s*/.exec(inner)![0].length;
  const trail = inner.length - lead - /\s*$/.exec(inner.slice(lead))![0].length;
  const core = inner.slice(lead, lead + trail);
  const next =
    before + inner.slice(0, lead) + mark + core + mark + inner.slice(lead + trail) + after;
  return { text: next, start: start + lead + 1, end: start + lead + 1 + core.length };
}
