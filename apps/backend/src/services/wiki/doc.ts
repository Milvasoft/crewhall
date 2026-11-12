import * as Y from 'yjs';
import { PAGE_FRAGMENT } from '@crewhall/shared';

/**
 * ProseMirror JSON ↔ Yjs without a schema, in the encoding y-prosemirror (Tiptap
 * Collaboration) uses: every node is a Y.XmlElement named after its type with its attrs as
 * attributes; runs of text are one Y.XmlText whose formatting attributes are the marks
 * (`{ bold: {}, link: { href } }`). The backend, collab server and worker share this so they
 * never need the editor's schema.
 */

export interface PMMark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: PMMark[];
  text?: string;
}
export interface PMDoc {
  type: 'doc';
  content: PMNode[];
}

export const emptyPageDoc = (): PMDoc => ({ type: 'doc', content: [{ type: 'paragraph' }] });

export function docFromState(state: Uint8Array | null | undefined): Y.Doc {
  const doc = new Y.Doc();
  if (state && state.length) Y.applyUpdate(doc, state);
  return doc;
}

export const encodeState = (doc: Y.Doc) => Buffer.from(Y.encodeStateAsUpdate(doc));

export const pageFragment = (doc: Y.Doc) => doc.getXmlFragment(PAGE_FRAGMENT);

/** The page body as ProseMirror JSON (y-prosemirror's yXmlFragmentToProsemirrorJSON). */
export function fragmentToJson(fragment: Y.XmlFragment): PMDoc {
  const serialize = (item: Y.XmlElement | Y.XmlText | Y.XmlHook): PMNode[] => {
    if (item instanceof Y.XmlText) {
      const delta = item.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[];
      return delta
        .filter((d) => typeof d.insert === 'string' && d.insert.length > 0)
        .map((d) => {
          const node: PMNode = { type: 'text', text: d.insert as string };
          if (d.attributes && Object.keys(d.attributes).length) {
            node.marks = Object.entries(d.attributes).map(([type, attrs]) => {
              // Overlapping marks are stored as `name--hash`.
              const name = type.split('--')[0]!;
              const mark: PMMark = { type: name };
              if (attrs && typeof attrs === 'object' && Object.keys(attrs).length) {
                mark.attrs = attrs as Record<string, unknown>;
              }
              return mark;
            });
          }
          return node;
        });
    }
    if (item instanceof Y.XmlElement) {
      const node: PMNode = { type: item.nodeName };
      const attrs = item.getAttributes() as Record<string, unknown>;
      if (Object.keys(attrs).length) node.attrs = attrs;
      const children = item.toArray().flatMap((c) => serialize(c as Y.XmlElement | Y.XmlText));
      if (children.length) node.content = children;
      return [node];
    }
    return [];
  };
  return {
    type: 'doc',
    content: fragment.toArray().flatMap((c) => serialize(c as Y.XmlElement | Y.XmlText)),
  };
}

export const docToJson = (doc: Y.Doc) => fragmentToJson(pageFragment(doc));

function marksToAttributes(marks: PMMark[] | undefined): Record<string, unknown> | undefined {
  if (!marks?.length) return undefined;
  const out: Record<string, unknown> = {};
  for (const m of marks) out[m.type] = m.attrs ?? {};
  return out;
}

/** y-prosemirror's createTypeFromElementNode / createTypeFromTextNodes. */
function toYTypes(nodes: PMNode[]): (Y.XmlElement | Y.XmlText)[] {
  const out: (Y.XmlElement | Y.XmlText)[] = [];
  let textRun: PMNode[] = [];
  const flush = () => {
    if (!textRun.length) return;
    const text = new Y.XmlText();
    text.applyDelta(
      textRun.map((t) => {
        const attributes = marksToAttributes(t.marks);
        return attributes ? { insert: t.text ?? '', attributes } : { insert: t.text ?? '' };
      }),
    );
    out.push(text);
    textRun = [];
  };
  for (const n of nodes) {
    if (n.type === 'text') {
      if (n.text) textRun.push(n);
      continue;
    }
    flush();
    const el = new Y.XmlElement(n.type);
    for (const [k, v] of Object.entries(n.attrs ?? {})) {
      if (v !== null && v !== undefined) el.setAttribute(k, v as string);
    }
    const children = toYTypes(n.content ?? []);
    if (children.length) el.insert(0, children);
    out.push(el);
  }
  flush();
  return out;
}

/** The text of a to-do: the runs of its first paragraph, without formatting or inline atoms. */
function taskText(item: Y.XmlElement): string {
  const first = item.toArray()[0];
  if (!(first instanceof Y.XmlElement)) return '';
  return first
    .toArray()
    .filter((c): c is Y.XmlText => c instanceof Y.XmlText)
    .map((t) =>
      (t.toDelta() as { insert?: unknown }[])
        .map((d) => (typeof d.insert === 'string' ? d.insert : ''))
        .join(''),
    )
    .join('');
}

const normalizeTaskText = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Sets a to-do's checked state in one transaction. The index counts to-dos in document order,
 * sub-tasks included; false when that to-do no longer has this text.
 */
export function setTaskChecked(
  doc: Y.Doc,
  task: { index: number; text: string; checked: boolean },
  origin?: unknown,
): boolean {
  let at = 0;
  let found: Y.XmlElement | null = null;
  const visit = (el: Y.XmlFragment | Y.XmlElement) => {
    for (const child of el.toArray()) {
      if (found || !(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'taskItem') {
        if (at === task.index) {
          found = child;
          return;
        }
        at += 1;
      }
      visit(child);
    }
  };
  visit(pageFragment(doc));
  const item = found as Y.XmlElement | null;
  if (!item || normalizeTaskText(taskText(item)) !== normalizeTaskText(task.text)) return false;
  doc.transact(() => item.setAttribute('checked', task.checked as unknown as string), origin);
  return true;
}

/** Replaces the whole body inside one transaction (open editors receive it as an update). */
export function replaceContent(doc: Y.Doc, json: PMDoc, origin?: unknown) {
  const fragment = pageFragment(doc);
  doc.transact(() => {
    if (fragment.length) fragment.delete(0, fragment.length);
    const content = json.content.length ? json.content : emptyPageDoc().content;
    fragment.insert(0, toYTypes(content));
  }, origin);
}

/** Appends blocks at the end of the body. */
export function appendContent(doc: Y.Doc, json: PMDoc, origin?: unknown) {
  const fragment = pageFragment(doc);
  doc.transact(() => {
    // An empty trailing paragraph (the editor's placeholder) is replaced, not kept above.
    const last = fragment.length ? fragment.get(fragment.length - 1) : null;
    if (
      last instanceof Y.XmlElement &&
      last.nodeName === 'paragraph' &&
      last.length === 0 &&
      fragment.length > 0
    ) {
      fragment.delete(fragment.length - 1, 1);
    }
    fragment.insert(fragment.length, toYTypes(json.content));
  }, origin);
}

export function stateFromJson(json: PMDoc): Buffer {
  const doc = new Y.Doc();
  replaceContent(doc, json);
  return encodeState(doc);
}

/** Depth-first walk over every node. */
export function walk(node: PMNode | PMDoc, visit: (node: PMNode, parents: PMNode[]) => void) {
  const go = (n: PMNode, parents: PMNode[]) => {
    visit(n, parents);
    for (const c of n.content ?? []) go(c, [...parents, n]);
  };
  for (const c of node.content ?? []) go(c, []);
}

const BLOCK_SEPARATED = new Set(['tableCell', 'tableHeader', 'listItem', 'taskItem']);

/** Plain text of a document: blocks on their own lines (search, snippets, reading time). */
export function plainText(doc: PMDoc): string {
  const lines: string[] = [];
  const inline = (n: PMNode): string => {
    if (n.type === 'text') return n.text ?? '';
    if (n.type === 'hardBreak') return '\n';
    if (n.type === 'mention') return `@${String(n.attrs?.label ?? '')}`;
    return (n.content ?? []).map(inline).join('');
  };
  const block = (n: PMNode) => {
    const children = n.content ?? [];
    if (n.type === 'codeBlock' || n.type === 'mermaid') {
      lines.push(children.map(inline).join(''));
      return;
    }
    if (n.type === 'toggle' && typeof n.attrs?.summary === 'string') lines.push(n.attrs.summary);
    if (n.type === 'admonition' && typeof n.attrs?.title === 'string') lines.push(n.attrs.title);
    const hasBlocks = children.some((c) => c.type !== 'text' && !isInline(c));
    if (!hasBlocks) {
      const text = children.map(inline).join('');
      if (text.trim()) lines.push(text);
      return;
    }
    const cells: string[] = [];
    for (const c of children) {
      if (BLOCK_SEPARATED.has(c.type) && n.type === 'tableRow') {
        cells.push(plainText({ type: 'doc', content: c.content ?? [] }).replace(/\n/g, ' '));
      } else block(c);
    }
    if (cells.length) lines.push(cells.join(' | '));
  };
  for (const n of doc.content) block(n);
  return lines.join('\n');
}

const INLINE = new Set(['text', 'hardBreak', 'mention', 'image', 'htmlInline', 'inlineMath']);
const isInline = (n: PMNode) => INLINE.has(n.type);

export function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

/** ~200 words a minute, at least one minute once there is any text. */
export const readingMinutes = (words: number) =>
  words === 0 ? 0 : Math.max(1, Math.round(words / 200));
