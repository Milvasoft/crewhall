/**
 * The document model shared by the editor, the Hub backend (publish), the import tool and the
 * portal site renderer. It is Tiptap / ProseMirror JSON; this file is the single list of node
 * and mark names and their attributes. Keep it free of DOM and React imports: it runs in Node.
 *
 * Blocks: paragraph, heading, blockquote, bulletList, orderedList, listItem, taskList,
 * taskItem, codeBlock, mermaid, horizontalRule, table (tableRow, tableHeader, tableCell),
 * admonition, tabs (tabItem), truncate, toc, htmlBlock, toggle, embed, columns (column),
 * mathBlock, bookmark, video.
 * Inline: text, image, hardBreak, htmlInline, mention, mathInline. Marks: bold, italic, strike, code, link,
 * color (attrs `{ color: BlockColor }`, the block menu's "Renk"; markdown drops it).
 *
 * Wiki nodes (they never reach a public site as such, see `toPublicDoc`):
 * - toggle: collapsible block, content `block+`, attrs `ToggleAttrs`; markdown
 *   `:::toggle[Summary]` … `:::`, as a heading `:::toggle[Summary]{level=2}`.
 * - columns: side by side blocks, 2 to `MAX_COLUMNS` `column` nodes, each `block+`; markdown
 *   `::::columns` with a `:::column` for each. Narrow screens stack them.
 * - mathBlock, mathInline: LaTeX drawn with KaTeX, attrs `MathAttrs`; markdown `$$` on its own
 *   lines and `$$x$$` in text. A single `$` stays text, so prices do not turn into formulas.
 * - bookmark: block atom, a card for a web page, attrs `BookmarkAttrs`; markdown
 *   `::bookmark{url="…" title="…"}`.
 * - video: block atom, attrs `VideoAttrs`, see `videoSource`; markdown `::video{src="…"}`.
 * - embed: block atom showing another Hub node (file, board …), attrs `EmbedAttrs`; markdown
 *   `::embed{node="<id>" type="<type>"}` (a leaf directive).
 * - mention: inline atom, attrs `MentionAttrs`; markdown `[@label](mention:<kind>:<id>)`.
 *   Plain `@name` text stays text.
 * - unknownBlock, unknownMark: only in the editor, where a shared document has content this
 *   client does not know (extensions/unknown.ts); never stored.
 * Page links are the `link` mark with href `/p/{slug}-{id}` (no node of their own).
 */

export interface JSONMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface JSONNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JSONNode[];
  marks?: JSONMark[];
  text?: string;
}

export interface EditorDoc {
  type: 'doc';
  content?: JSONNode[];
}

/** Docusaurus admonition types (`:::note` …). `caution` renders like `warning`. */
export const ADMONITION_TYPES = [
  'note',
  'tip',
  'info',
  'warning',
  'danger',
  'caution',
  'important',
  'success',
  'secondary',
] as const;
export type AdmonitionType = (typeof ADMONITION_TYPES)[number];

export const isAdmonitionType = (v: string): v is AdmonitionType =>
  (ADMONITION_TYPES as readonly string[]).includes(v);

/**
 * The `color` mark (the block menu's "Renk"): a hue for the text, or `<hue>-bg` for a tinted
 * background. It is a mark, not a block attribute, so documents without colors keep their JSON.
 * Markdown has no place for it; it lives only in the editor document (Yjs, JSON versions).
 */
export const BLOCK_HUES = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type BlockHue = (typeof BLOCK_HUES)[number];
export type BlockColor = BlockHue | `${BlockHue}-bg`;

export interface ColorAttrs {
  color: BlockColor;
}

export const isBlockColor = (v: unknown): v is BlockColor =>
  typeof v === 'string' && (BLOCK_HUES as readonly string[]).includes(v.replace(/-bg$/, ''));

export type CellAlign = 'left' | 'center' | 'right' | null;

export interface HeadingAttrs {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  /** Custom anchor (`## Title {#custom-id}`); null = generated from the text. */
  id: string | null;
}

export interface CodeBlockAttrs {
  language: string | null;
  /** `title="…"` of the fence, shown above the code. */
  title: string | null;
  /** Rest of the fence meta, kept as written (e.g. `{1-4} showLineNumbers`). */
  meta: string | null;
}

export interface ImageAttrs {
  src: string;
  alt: string | null;
  title: string | null;
}

export interface AdmonitionAttrs {
  type: AdmonitionType;
  title: string | null;
}

export interface TabsAttrs {
  groupId: string | null;
}

export interface TabItemAttrs {
  value: string;
  label: string | null;
  default: boolean;
}

export interface ToggleAttrs {
  /** The always visible line; may be empty. */
  summary: string;
  /** 1-3 when the toggle is a heading. A client without this attribute shows a plain toggle. */
  level?: 1 | 2 | 3 | null;
}

export const IMAGE_ALIGNS = ['left', 'center', 'right'] as const;
export type ImageAlign = (typeof IMAGE_ALIGNS)[number];

export const isImageAlign = (v: unknown): v is ImageAlign =>
  typeof v === 'string' && (IMAGE_ALIGNS as readonly string[]).includes(v);

/** An image's width in percent of its block, from a stored attribute; null when it has none. */
export function imageWidth(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 10 && n <= 100 ? Math.round(n) : null;
}

export interface EmbedAttrs {
  /** Id of the embedded Hub node. */
  nodeId: string;
  /** Its node type (`file`, `board`, `drawing` …); null when the markdown did not say. */
  nodeType: string | null;
}

export const MENTION_KINDS = ['user', 'node', 'date'] as const;
export type MentionKind = (typeof MENTION_KINDS)[number];

export const isMentionKind = (v: string): v is MentionKind =>
  (MENTION_KINDS as readonly string[]).includes(v);

export interface MentionAttrs {
  /** User id, node id or ISO date (`2026-10-20`), depending on `kind`. */
  id: string;
  /** Text shown after the `@` (display name, node title, formatted date). */
  label: string;
  kind: MentionKind;
}

export interface MathAttrs {
  latex: string;
}

export interface BookmarkAttrs {
  url: string;
  title: string | null;
  favicon: string | null;
}

export interface VideoAttrs {
  /** A web address, or `node:<fileId>` for a Drive file. */
  src: string;
  title: string | null;
}

/** A typed address as a web URL, `https://` assumed; null when it is not one. */
export function webUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/]+:\d/.test(text);
  if (hasScheme && !/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(hasScheme ? text : `https://${text}`);
    return url.hostname.includes('.') || url.hostname === 'localhost' ? url.href : null;
  } catch {
    return null;
  }
}

const NODE_FILE = /^node:[0-9a-f-]{36}$/i;
const VIDEO_FILE = /\.(mp4|webm|ogv|ogg|mov|m4v)$/i;

export type VideoSource =
  /** A player page of a known host: an address fixed here, never one taken from the document. */
  { kind: 'player'; host: 'youtube' | 'vimeo'; url: string } | { kind: 'file'; src: string };

/** How to play `src`; null when it is no video we can play, which then shows as a link. */
export function videoSource(src: string): VideoSource | null {
  if (NODE_FILE.test(src)) return { kind: 'file', src };
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be') {
    const id =
      host === 'youtu.be'
        ? parts[0]
        : parts[0] === 'watch'
          ? url.searchParams.get('v')
          : ['embed', 'shorts', 'live', 'v'].includes(parts[0] ?? '')
            ? parts[1]
            : null;
    if (id && /^[\w-]{6,20}$/.test(id)) {
      return {
        kind: 'player',
        host: 'youtube',
        url: `https://www.youtube-nocookie.com/embed/${id}`,
      };
    }
    return null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = host === 'vimeo.com' ? parts[0] : parts[0] === 'video' ? parts[1] : null;
    if (id && /^\d{5,12}$/.test(id)) {
      return { kind: 'player', host: 'vimeo', url: `https://player.vimeo.com/video/${id}` };
    }
    return null;
  }
  return VIDEO_FILE.test(url.pathname) ? { kind: 'file', src: url.href } : null;
}

export const MAX_COLUMNS = 4;

export const emptyDoc = (): EditorDoc => ({ type: 'doc', content: [{ type: 'paragraph' }] });

/** Depth-first walk over every node (the doc itself included). Return false to skip children. */
export function walk(
  node: JSONNode | EditorDoc,
  visit: (node: JSONNode, parents: JSONNode[]) => void | false,
  parents: JSONNode[] = [],
): void {
  const n = node as JSONNode;
  if (visit(n, parents) === false) return;
  for (const child of n.content ?? []) walk(child, visit, [...parents, n]);
}

/** Returns a copy with `map` applied bottom-up to every node; return null to drop a node. */
export function mapDoc<T extends JSONNode | EditorDoc>(
  node: T,
  map: (node: JSONNode) => JSONNode | null,
): T {
  const n = node as JSONNode;
  const content = n.content
    ?.map((c) => mapDoc(c, map))
    .filter((c): c is JSONNode => c !== null && c !== undefined);
  const copy: JSONNode = { ...n, ...(n.content ? { content } : {}) };
  if (n.type === 'doc') return copy as T;
  return (map(copy) ?? null) as T;
}
