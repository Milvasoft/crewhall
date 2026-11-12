import {
  docToMarkdown,
  mapDoc,
  nodeText,
  rewriteReferences,
  type EditorDoc,
  type MarkdownWarning,
} from '@crewhall/editor';
import type { ImportEntry } from '../bundle';
import { dirOf, joinRel, type ParseContext } from './context';
import { isCodeFile, isMarkdown, resolvePathname } from './rules';

export type { EditorDoc };

/** Docusaurus `contentTitle`: an h1 that is the first block of the document. */
export function contentTitle(doc: EditorDoc): string | null {
  const first = doc.content?.[0];
  if (first?.type !== 'heading' || Number(first.attrs?.level ?? 0) !== 1) return null;
  const text = nodeText(first).trim();
  return text || null;
}

/** Where a markdown file sits, for resolving its relative references. */
export interface RewriteScope {
  /** Repo-relative markdown file. */
  file: string;
  /** Default-locale counterpart of a translation (its folder is the second lookup place). */
  sourceFile: string | null;
  locale: string;
  /** Site URL of the page, for links relative to the URL (`../other-page`). */
  pageUrl: string;
  /** Content roots for `/x.md` and bare `x.md` links, localized root first. */
  roots: string[];
  target: ImportEntry['target'];
}

export interface RewriterOptions {
  /** `<locale>\0<repo-relative markdown path>` → site URL. */
  permalinks: Map<string, string>;
  /** Every site path a link may point at (listed and unlisted pages, feeds). */
  knownUrls: Set<string>;
  /** Docusaurus static directories, e.g. ['static']. */
  staticDirs: string[];
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const EXTERNAL = /^(?:https?:)?\/\//i;

const safeDecode = (s: string) => {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
};

/** Splits `path#hash` / `path?query` into the path and the rest. */
function splitSuffix(url: string): [string, string] {
  const i = url.search(/[?#]/);
  return i < 0 ? [url, ''] : [url.slice(0, i), url.slice(i)];
}

export const normalizeSitePath = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') || '/' : p);

/**
 * Rewrites images to `/media/...`, links to `.md` files to site URLs and relative page links
 * to absolute ones; removes links whose target does not exist (text kept) and reports them.
 */
export class ReferenceRewriter {
  /** Repo-relative files referenced from markdown (added to the media list when outside it). */
  readonly referencedMedia = new Set<string>();

  constructor(
    private readonly ctx: ParseContext,
    private readonly options: RewriterOptions,
  ) {}

  /** Public media path of a repo file: below a static dir → `/media/<rest>`, else `/media/<path>`. */
  mediaPath(rel: string): string {
    for (const dir of this.options.staticDirs) {
      if (rel.startsWith(`${dir}/`)) return `/media/${rel.slice(dir.length + 1)}`;
    }
    return `/media/${rel}`;
  }

  /** Resolves an image path to a repo file (null when missing). */
  resolveImageFile(url: string, scope: Pick<RewriteScope, 'file' | 'sourceFile'>): string | null {
    let p = safeDecode(splitSuffix(url.replace(/^pathname:\/\//, ''))[0]);
    if (!p) return null;
    const existing = (rel: string | null) => (rel !== null && this.ctx.isFile(rel) ? rel : null);
    if (p.startsWith('@site/')) return existing(joinRel('', p.slice('@site/'.length)));
    if (p.startsWith('/')) {
      p = p.slice(1);
      for (const dir of this.options.staticDirs) {
        const hit = existing(joinRel(dir, p));
        if (hit) return hit;
      }
      return null;
    }
    return (
      existing(joinRel(dirOf(scope.file), p)) ??
      (scope.sourceFile ? existing(joinRel(dirOf(scope.sourceFile), p)) : null)
    );
  }

  /** Image URL → media path; `undefined` keeps it (external), `null` when the file is missing. */
  image(url: string, scope: RewriteScope): string | null | undefined {
    if (EXTERNAL.test(url)) {
      this.ctx.report({
        type: 'image',
        source: scope.file,
        action: `Dış görsel (${url}); adres korundu, Medya'ya indirilmedi`,
        target: scope.target,
      });
      return undefined;
    }
    if (/^data:/i.test(url) || (SCHEME.test(url) && !/^pathname:/i.test(url))) return undefined;
    const file = this.resolveImageFile(url, scope);
    if (!file) return null;
    this.referencedMedia.add(file);
    return this.mediaPath(file);
  }

  link(url: string, scope: RewriteScope): string | null | undefined {
    if (url.startsWith('#') || url === '' || EXTERNAL.test(url) || SCHEME.test(url)) {
      return undefined;
    }
    const [rawPath, suffix] = splitSuffix(url);
    const p = safeDecode(rawPath);
    if (!p) return undefined;

    if (isMarkdown(p)) {
      const candidates: (string | null)[] = [];
      if (p.startsWith('/')) {
        for (const root of scope.roots) candidates.push(joinRel(root, p.slice(1)));
      } else {
        if (!p.startsWith('./') && !p.startsWith('../')) {
          for (const root of scope.roots) candidates.push(joinRel(root, p));
          candidates.push(joinRel('', p));
        }
        candidates.push(joinRel(dirOf(scope.file), p));
        if (scope.sourceFile) candidates.push(joinRel(dirOf(scope.sourceFile), p));
      }
      for (const c of candidates) {
        const hit = c === null ? undefined : this.options.permalinks.get(`${scope.locale}\0${c}`);
        if (hit) return hit + suffix;
      }
      return null;
    }

    if (p.startsWith('/')) {
      if (this.options.knownUrls.has(normalizeSitePath(p))) return undefined;
      const file = this.resolveImageFile(p, scope);
      if (file) {
        this.referencedMedia.add(file);
        return this.mediaPath(file) + suffix;
      }
      return null;
    }

    // A file next to the markdown (PDF, archive, image link).
    const file = this.resolveImageFile(p, scope);
    if (file && !isMarkdown(file) && !isCodeFile(file)) {
      this.referencedMedia.add(file);
      return this.mediaPath(file) + suffix;
    }
    // A page URL relative to this page's URL.
    const resolved = normalizeSitePath(resolvePathname(p, scope.pageUrl));
    if (this.options.knownUrls.has(resolved)) return resolved + suffix;
    return null;
  }

  /** Rewrites one parsed document and returns it as Docusaurus-compatible markdown. */
  rewrite(doc: EditorDoc, scope: RewriteScope): { doc: EditorDoc; markdown: string } {
    let next = rewriteReferences(doc, (ref) => {
      if (ref.kind === 'image') {
        const out = this.image(ref.url, scope);
        if (out === null) {
          this.ctx.report({
            type: 'image',
            source: scope.file,
            action: `Görsel dosyası yok (${ref.url}); görsel kaldırıldı`,
            target: scope.target,
          });
        }
        return out;
      }
      const out = this.link(ref.url, scope);
      if (out === null) {
        this.ctx.report({
          type: 'link',
          source: scope.file,
          action: `Hedef yok (${ref.url}); link kaldırıldı, metin korundu`,
          target: scope.target,
        });
      }
      return out;
    });
    next = mapDoc(next, (node) => {
      if ((node.type !== 'htmlBlock' && node.type !== 'htmlInline') || !node.attrs) return node;
      const html = node.attrs.html;
      if (typeof html !== 'string') return node;
      const rewritten = this.rewriteHtml(html, scope);
      return rewritten === html ? node : { ...node, attrs: { ...node.attrs, html: rewritten } };
    });
    return { doc: next, markdown: docToMarkdown(next, { docusaurusImports: true }) };
  }

  /** `src={require('./a.png').default}`, `src={useBaseUrl('/img/a.png')}`, `src="./a.png"`. */
  private rewriteHtml(html: string, scope: RewriteScope): string {
    const replace = (whole: string, url: string) => {
      const out = this.image(url, scope);
      if (out === undefined) return whole;
      if (out === null) {
        this.ctx.report({
          type: 'image',
          source: scope.file,
          action: `Görsel dosyası yok (${url}); HTML içinde olduğu gibi bırakıldı`,
          target: scope.target,
        });
        return whole;
      }
      return `src="${out}"`;
    };
    return html
      .replace(
        /src=\{\s*(?:require|useBaseUrl)\(\s*(['"`])([^'"`]+)\1\s*\)(?:\.default)?\s*\}/g,
        (whole, _q: string, url: string) => replace(whole, url),
      )
      .replace(/\bsrc=(["'])([^"']+)\1/g, (whole, _q: string, url: string) =>
        url.startsWith('/media/') ? whole : replace(whole, url),
      );
  }
}

/** Editor warnings → report rows. */
export function reportWarnings(
  ctx: ParseContext,
  file: string,
  warnings: MarkdownWarning[],
  target: ImportEntry['target'],
): void {
  for (const w of warnings) {
    const detail = w.detail ?? '';
    switch (w.type) {
      case 'mdx-import':
        ctx.report({
          type: 'mdx',
          source: file,
          action: `MDX import kaldırıldı (${detail}); kullanılan bileşeni kontrol et`,
          target,
        });
        break;
      case 'unsupported-component':
        ctx.report({
          type: 'mdx',
          source: file,
          action: `<${detail}> bileşeni desteklenmiyor; ham HTML olarak korundu, kontrol et`,
          target,
        });
        break;
      case 'unknown-directive':
        ctx.report({
          type: 'mdx',
          source: file,
          action: `Bilinmeyen :::${detail} bloğu; içeriği korundu`,
          target,
        });
        break;
      case 'front-matter':
        ctx.report({
          type: 'unsupported',
          source: file,
          action: `Front matter YAML okunamadı (${detail}); varsayılanlar kullanıldı`,
          target,
        });
        break;
    }
  }
}
