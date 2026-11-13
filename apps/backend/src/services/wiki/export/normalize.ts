import { posix } from 'node:path';
import type { PMDoc, PMMark, PMNode } from '../doc';
import { fileIdOfRef, pageIdOfHref, type ExportPage, type ExportSet } from './collect';

/**
 * Turns a page body into what an exported file can show (roadmap 6): mentions become text (or
 * a link to an exported page), embeds become a link or an image, links between exported pages
 * point at each other's files, `node:` files point at `ekler/…` inside the ZIP, and anything
 * that stays in Crewhall becomes an absolute hub link.
 *
 * Images of included files keep `asset:<id>` (or a relative path for Markdown) so each
 * renderer can embed them its own way.
 */

export interface ExportContext {
  hubUrl: string;
  set: ExportSet;
  pageById: Map<string, ExportPage>;
  /** Extension of exported pages (`.md`, `.html`, `.docx`, `.pdf`). */
  ext: string;
  /** Several files in a ZIP: relative links between them work. */
  zip: boolean;
  /** Markdown writes images as files next to the pages; the others embed them. */
  imagesAsFiles: boolean;
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export function relativeTo(from: ExportPage, target: string) {
  const dir = posix.dirname(from.path);
  return encodePath(posix.relative(dir === '.' ? '' : dir, target) || posix.basename(target));
}

export function resolveHref(ctx: ExportContext, from: ExportPage, href: string): string {
  const pageId = pageIdOfHref(href);
  if (pageId) {
    const target = ctx.pageById.get(pageId);
    if (target && (ctx.zip || target === from)) {
      return target === from ? '#' : relativeTo(from, `${target.path}${ctx.ext}`);
    }
    return `${ctx.hubUrl}/p/${pageId}`;
  }
  const fileId = fileIdOfRef(href);
  if (fileId) {
    const file = ctx.set.files.get(fileId);
    if (file && ctx.zip) return relativeTo(from, file.path);
    return `${ctx.hubUrl}/api/v1/nodes/${fileId}/download`;
  }
  if (href.startsWith('/')) return `${ctx.hubUrl}${href}`;
  return href;
}

const text = (t: string, marks?: PMMark[]): PMNode =>
  marks?.length ? { type: 'text', text: t, marks } : { type: 'text', text: t };

const withLink = (marks: PMMark[] | undefined, href: string): PMMark[] => [
  ...(marks ?? []).filter((m) => m.type !== 'link'),
  { type: 'link', attrs: { href, title: null } },
];

function imageNode(ctx: ExportContext, from: ExportPage, src: string, attrs: PMNode['attrs']) {
  const fileId = fileIdOfRef(src);
  if (!fileId) return { type: 'image', attrs: { ...attrs, src } };
  const file = ctx.set.files.get(fileId);
  if (!file) return { type: 'image', attrs: { ...attrs, src: resolveHref(ctx, from, src) } };
  return {
    type: 'image',
    attrs: { ...attrs, src: ctx.imagesAsFiles ? relativeTo(from, file.path) : `asset:${fileId}` },
  };
}

function mapInline(ctx: ExportContext, from: ExportPage, n: PMNode): PMNode {
  if (n.type === 'mention') {
    const label = String(n.attrs?.label ?? '');
    const kind = n.attrs?.kind ?? 'user';
    if (kind === 'node' && typeof n.attrs?.id === 'string') {
      const name = ctx.set.nodeNames.get(n.attrs.id) ?? label;
      const page = ctx.pageById.get(n.attrs.id);
      const href = page ? resolveHref(ctx, from, `/p/${page.id}`) : null;
      return href ? text(name, withLink(n.marks, href)) : text(name, n.marks);
    }
    return text(kind === 'date' ? label : `@${label}`, n.marks);
  }
  if (n.type === 'image') return imageNode(ctx, from, String(n.attrs?.src ?? ''), n.attrs);
  if (!n.marks?.some((m) => m.type === 'link')) return n;
  return {
    ...n,
    marks: n.marks.map((m) =>
      m.type === 'link'
        ? { ...m, attrs: { ...m.attrs, href: resolveHref(ctx, from, String(m.attrs?.href ?? '')) } }
        : m,
    ),
  };
}

function mapNode(ctx: ExportContext, from: ExportPage, n: PMNode): PMNode {
  // A page in another format has no card or player: a link says the same.
  if (n.type === 'bookmark' || n.type === 'video') {
    const target = String((n.type === 'video' ? n.attrs?.src : n.attrs?.url) ?? '');
    if (!target) return { type: 'paragraph' };
    const href = resolveHref(ctx, from, target);
    const label = String(n.attrs?.title ?? '') || (target.startsWith('node:') ? href : target);
    const description = n.type === 'bookmark' ? String(n.attrs?.description ?? '') : '';
    return {
      type: 'paragraph',
      content: [
        text(`${n.type === 'video' ? '▶ ' : ''}${label}`, withLink(undefined, href)),
        ...(description ? [text(` — ${description}`)] : []),
      ],
    };
  }
  if (n.type === 'embed') {
    const id = String(n.attrs?.nodeId ?? '');
    const file = ctx.set.files.get(id);
    if (file?.isImage) {
      return {
        type: 'paragraph',
        content: [imageNode(ctx, from, `node:${id}`, { alt: file.name })],
      };
    }
    const name = ctx.set.nodeNames.get(id);
    if (!name) return { type: 'paragraph' };
    const href =
      file || n.attrs?.nodeType === 'file'
        ? resolveHref(ctx, from, `node:${id}`)
        : n.attrs?.nodeType === 'page'
          ? resolveHref(ctx, from, `/p/${id}`)
          : `${ctx.hubUrl}/p/${id}`;
    return { type: 'paragraph', content: [text(`📎 ${name}`, withLink(undefined, href))] };
  }
  if (!n.content) return n;
  const content = n.content.map((c) =>
    c.type === 'text' ||
    c.type === 'mention' ||
    c.type === 'image' ||
    c.type === 'hardBreak' ||
    c.type === 'htmlInline'
      ? mapInline(ctx, from, c)
      : mapNode(ctx, from, c),
  );
  return { ...n, content };
}

export function normalizeDoc(ctx: ExportContext, page: ExportPage): PMDoc {
  return { type: 'doc', content: page.doc.content.map((n) => mapNode(ctx, page, n)) };
}
