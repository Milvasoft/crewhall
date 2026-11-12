import GithubSlugger from 'github-slugger';
import { walk, type EditorDoc, type JSONNode } from '../model';

export interface Heading {
  id: string;
  text: string;
  level: number;
}

/** Visible text of a node (code included, HTML left out). */
export function nodeText(node: JSONNode | EditorDoc): string {
  const n = node as JSONNode;
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'hardBreak') return ' ';
  if (n.type === 'image') return typeof n.attrs?.alt === 'string' ? n.attrs.alt : '';
  if (n.type === 'mention') {
    return typeof n.attrs?.label === 'string' ? `@${n.attrs.label}` : '';
  }
  if (n.type === 'bookmark' || n.type === 'video') {
    const title = n.attrs?.title;
    return typeof title === 'string' && title ? title : String(n.attrs?.url ?? '');
  }
  if (n.type === 'mathBlock' || n.type === 'mathInline') {
    return typeof n.attrs?.latex === 'string' ? n.attrs.latex : '';
  }
  if (
    n.type === 'htmlInline' ||
    n.type === 'htmlBlock' ||
    n.type === 'truncate' ||
    n.type === 'embed'
  ) {
    return '';
  }
  // Blocks are separated by line breaks; the inline content of a text block is not.
  const sep = (BLOCK_TYPES.has(n.type) && !TEXT_BLOCKS.has(n.type)) || n.type === 'doc' ? '\n' : '';
  const parts = (n.content ?? []).map(nodeText);
  if (n.type === 'toggle' && typeof n.attrs?.summary === 'string' && n.attrs.summary) {
    parts.unshift(n.attrs.summary);
  }
  return parts.join(sep);
}

const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'codeBlock',
  'mermaid',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  'admonition',
  'tabs',
  'tabItem',
  'toggle',
  'columns',
  'column',
]);

const TEXT_BLOCKS = new Set(['paragraph', 'heading', 'codeBlock', 'mermaid']);

/** Plain text for search indexes and previews. */
export const plainText = (doc: EditorDoc) =>
  nodeText(doc)
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * Headings with Docusaurus-compatible anchors: custom `{#id}` or github-slugger over the
 * text, de-duplicated in document order. h1 is included (level 1); the TOC uses 2-3.
 */
export function headings(doc: EditorDoc): Heading[] {
  const slugger = new GithubSlugger();
  const out: Heading[] = [];
  walk(doc, (node) => {
    if (node.type !== 'heading') return;
    const text = nodeText(node).trim();
    const custom = typeof node.attrs?.id === 'string' && node.attrs.id ? node.attrs.id : null;
    const id = custom ? (slugger.slug(custom), custom) : slugger.slug(text);
    out.push({ id, text, level: Number(node.attrs?.level ?? 1) });
    return false;
  });
  return out;
}

export function wordCount(doc: EditorDoc): number {
  const text = nodeText(doc);
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_.-]*/gu);
  return words ? words.length : 0;
}

/** Docusaurus "x min read": 200 words per minute, at least 1. */
export const readingMinutes = (doc: EditorDoc) => Math.max(1, Math.ceil(wordCount(doc) / 200));

export function codeBlockCount(doc: EditorDoc): number {
  let n = 0;
  walk(doc, (node) => {
    if (node.type === 'codeBlock' || node.type === 'mermaid') n++;
  });
  return n;
}

/** Splits a blog post at the `<!-- truncate -->` marker ("Özet sınırı"). */
export function splitAtTruncate(doc: EditorDoc): { excerpt: EditorDoc; truncated: boolean } {
  const content = doc.content ?? [];
  const idx = content.findIndex((n) => n.type === 'truncate');
  if (idx < 0) return { excerpt: doc, truncated: false };
  return { excerpt: { type: 'doc', content: content.slice(0, idx) }, truncated: true };
}

/** First paragraph's text, for descriptions that were left empty. */
export function firstParagraphText(doc: EditorDoc, max = 300): string | null {
  for (const node of doc.content ?? []) {
    if (node.type === 'paragraph') {
      const t = nodeText(node).trim();
      if (t) return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
    }
  }
  return null;
}

export interface Reference {
  kind: 'link' | 'image';
  url: string;
}

/** Every link href and image src in the document. */
export function references(doc: EditorDoc): Reference[] {
  const out: Reference[] = [];
  walk(doc, (node) => {
    if (node.type === 'image' && typeof node.attrs?.src === 'string') {
      out.push({ kind: 'image', url: node.attrs.src });
    }
    for (const m of node.marks ?? []) {
      if (m.type === 'link' && typeof m.attrs?.href === 'string') {
        out.push({ kind: 'link', url: m.attrs.href });
      }
    }
  });
  return out;
}

/**
 * Rewrites image srcs and link hrefs. Return the new URL, `null` to remove the link (its text
 * stays) or image, or `undefined` to leave it.
 */
export function rewriteReferences(
  doc: EditorDoc,
  rewrite: (ref: Reference) => string | null | undefined,
): EditorDoc {
  const visit = (node: JSONNode): JSONNode | null => {
    let n: JSONNode = { ...node };
    if (n.type === 'image' && typeof n.attrs?.src === 'string') {
      const next = rewrite({ kind: 'image', url: n.attrs.src });
      if (next === null) return null;
      if (next !== undefined) n = { ...n, attrs: { ...n.attrs, src: next } };
    }
    if (n.marks?.length) {
      const marks = n.marks.flatMap((m) => {
        if (m.type !== 'link' || typeof m.attrs?.href !== 'string') return [m];
        const next = rewrite({ kind: 'link', url: m.attrs.href });
        if (next === null) return [];
        return next === undefined ? [m] : [{ ...m, attrs: { ...m.attrs, href: next } }];
      });
      n = marks.length ? { ...n, marks } : (({ marks: _m, ...rest }) => rest)(n);
    }
    if (n.content) {
      n = { ...n, content: n.content.map(visit).filter((c): c is JSONNode => c !== null) };
    }
    return n;
  };
  return {
    type: 'doc',
    content: (doc.content ?? []).map(visit).filter((c): c is JSONNode => c !== null),
  };
}
