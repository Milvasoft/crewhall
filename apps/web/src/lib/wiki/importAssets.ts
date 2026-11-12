import { importLinkResolver } from '@crewhall/shared';

/**
 * Images and attachments of a Markdown import (design 5.15, H18). Outline, Notion and plain
 * Markdown folders keep files next to the pages; the links take several forms:
 *
 * - relative to the page:            `Ops/img/diagram.png`, `../uploads/a.png`
 * - from the package root:           `uploads/<…>/<id>/Ekran Görüntüsü.png` (Outline)
 * - URL-encoded:                     `Sayfa%20abc123/image%201.png` (Notion)
 * - Outline's redirect:              `/api/attachments.redirect?id=<uuid>` (also with its host)
 * - `<img src="…">` in Markdown
 *
 * Each link is matched to a file of the package, the file is uploaded once and the link is
 * rewritten to `node:<fileId>` (the editor shows Drive images by that src). Links to another
 * imported page are left for the server, which knows the page's address. Links that match nothing
 * are reported.
 */

export interface PackageFile {
  path: string;
  /** Text of a Markdown file, or the bytes of anything else. */
  text?: string;
  blob?: Blob;
  /** The file's name when its path does not carry it (Confluence stores files by id). */
  name?: string;
  /** A document that could not be converted. */
  unreadable?: boolean;
}

export interface MissingAttachment {
  /** The Markdown file. */
  path: string;
  /** The link as written. */
  target: string;
}

const MARKDOWN = /\.(md|markdown)$/i;

/** `![alt](target "title")`, `[text](target)` and `<img src="target">`. */
const LINK = /(!?)\[((?:[^\]\\]|\\.)*)\]\(\s*(<[^>]*>|[^)\s]+)((?:\s+(?:"[^"]*"|'[^']*'))?\s*)\)/g;
const IMG_TAG = /<img\b[^>]*>/gi;
const attr = (tag: string, name: string) =>
  new RegExp(`\\b${name}=(["'])([^"']*)\\1`, 'i').exec(tag)?.[2] ?? null;

const norm = (p: string) => {
  const out: string[] = [];
  for (const part of p.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/').toLowerCase();
};

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Links that are not package files: web pages, mail, anchors, data and Crewhall links. */
const external = (t: string) =>
  /^(https?:|mailto:|tel:|data:|node:|#)/i.test(t) && !/attachments\.redirect\?/i.test(t);

export class AssetIndex {
  private byPath = new Map<string, PackageFile>();
  private byName = new Map<string, PackageFile[]>();

  constructor(files: PackageFile[]) {
    for (const f of files) {
      if (MARKDOWN.test(f.path) || !f.blob) continue;
      const key = norm(f.path);
      this.byPath.set(key, f);
      const name = key.split('/').at(-1)!;
      this.byName.set(name, [...(this.byName.get(name) ?? []), f]);
    }
  }

  get size() {
    return this.byPath.size;
  }

  /** The package file a link in `mdPath` points at, or null. */
  resolve(target: string, mdPath: string): PackageFile | null {
    const raw = target.replace(/^<|>$/g, '').trim();
    // Outline's redirect links name the attachment id; the export keeps it in the file's path.
    const redirect = /attachments\.redirect\?(?:[^#]*&)?id=([0-9a-f-]{8,})/i.exec(raw);
    if (redirect) {
      const id = redirect[1]!.toLowerCase();
      for (const [key, file] of this.byPath) if (key.split('/').includes(id)) return file;
      return null;
    }
    if (external(raw)) return null;
    const clean = decode(raw.replace(/[?#].*$/, ''));
    const dir = mdPath.split('/').slice(0, -1).join('/');
    const candidates = [`${dir}/${clean}`, clean];
    // Outline writes package-root paths; a page deeper in the tree still links `uploads/…`.
    const anchor = /(?:^|\/)((?:uploads|attachments)\/.+)$/i.exec(clean);
    if (anchor) candidates.push(anchor[1]!);
    for (const c of candidates) {
      const hit = this.byPath.get(norm(c));
      if (hit) return hit;
    }
    // A package opened inside a parent folder: match the path's tail.
    const tail = norm(anchor ? anchor[1]! : clean);
    if (tail.includes('/')) {
      for (const [key, file] of this.byPath) if (key.endsWith(`/${tail}`)) return file;
    }
    // Last resort: a file name that exists only once in the package.
    const same = this.byName.get(tail.split('/').at(-1)!);
    return same?.length === 1 ? same[0]! : null;
  }
}

/** Every link target of a Markdown text that may be a package file. */
export function attachmentLinks(md: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(LINK)) out.push(m[3]!);
  for (const m of md.matchAll(IMG_TAG)) {
    const src = attr(m[0], 'src');
    if (src) out.push(src);
  }
  return out.filter((t) => !external(t.replace(/^<|>$/g, '')));
}

/**
 * Uploads the package files the Markdown links to (each once, through `upload`) and rewrites
 * the links to `node:<id>`. Files that do not resolve or fail to upload are reported.
 */
export async function rewriteAttachments(
  markdown: { path: string; content: string }[],
  index: AssetIndex,
  upload: (file: PackageFile) => Promise<string>,
): Promise<{
  files: { path: string; content: string }[];
  missing: MissingAttachment[];
  failed: MissingAttachment[];
  uploaded: number;
}> {
  const ids = new Map<PackageFile, Promise<string | null>>();
  const missing: MissingAttachment[] = [];
  const failed: MissingAttachment[] = [];
  const idFor = (file: PackageFile) => {
    let id = ids.get(file);
    if (!id) {
      id = upload(file).catch(() => null);
      ids.set(file, id);
    }
    return id;
  };

  const pageOf = importLinkResolver(markdown.map((md) => md.path));
  const files = [];
  for (const md of markdown) {
    const targets = new Map<string, string | null>();
    for (const target of attachmentLinks(md.content)) {
      if (targets.has(target) || pageOf(target, md.path) !== null) continue;
      const file = index.resolve(target, md.path);
      if (!file) {
        missing.push({ path: md.path, target });
        targets.set(target, null);
        continue;
      }
      const id = await idFor(file);
      if (!id) failed.push({ path: md.path, target });
      targets.set(target, id ? `node:${id}` : null);
    }
    const content = md.content
      .replace(LINK, (all, bang: string, text: string, target: string, title: string) => {
        const to = targets.get(target);
        return to ? `${bang}[${text}](${to}${title})` : all;
      })
      // Raw HTML stays text in the editor: a matched <img> becomes a Markdown image.
      .replace(IMG_TAG, (tag: string) => {
        const src = attr(tag, 'src');
        const to = src ? targets.get(src) : null;
        return to ? `![${(attr(tag, 'alt') ?? '').replace(/[[\]]/g, '')}](${to})` : tag;
      });
    files.push({ path: md.path, content });
  }
  const done = await Promise.all(ids.values());
  return { files, missing, failed, uploaded: done.filter(Boolean).length };
}
