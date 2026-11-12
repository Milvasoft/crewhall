import fs from 'node:fs';
import { markdownToDoc, type MarkdownWarning } from '@crewhall/editor';
import { parse as parseYaml } from 'yaml';
import type { ImportAuthor } from '../bundle';
import { str, type JsObject } from './config';
import type { ParseContext } from './context';
import { contentTitle, type EditorDoc } from './markdown';
import { isMarkdown, kebabCase } from './rules';

export interface PostSource {
  locale: string;
  sourcePath: string;
  /** Path below the blog folder, e.g. `2024-06-01-a/index.md`. */
  relPath: string;
  slug: string;
  title: string;
  description: string | null;
  date: string;
  authorKeys: string[];
  tags: string[];
  /** Tag URL segments below /blog/tags/, in `tags` order. */
  tagPermalinks: string[];
  /** Raw `image` front matter. */
  image: string | null;
  draft: boolean;
  unlisted: boolean;
  frontMatter: Record<string, unknown>;
  body: string;
  doc: EditorDoc;
  warnings: MarkdownWarning[];
  source: PostSource | null;
}

export interface AuthorSource extends ImportAuthor {
  /** Has its own page (`page: true` in authors.yml). */
  page: boolean;
}

export interface BlogResult {
  dir: string;
  posts: PostSource[];
  authors: AuthorSource[];
  postsPerPage: number;
  archive: boolean;
  fileCount: number;
}

const POST_FIELDS = new Set([
  'slug',
  'title',
  'description',
  'date',
  'authors',
  'author',
  'author_title',
  'authorTitle',
  'author_url',
  'authorURL',
  'author_image_url',
  'authorImageURL',
  'tags',
  'image',
]);

/** Docusaurus `parseBlogFileName`. */
const DATE_FILENAME =
  /^(?<folder>.*)(?<date>\d{4}[-/]\d{1,2}[-/]\d{1,2})[-/]?(?<text>.*?)(?:\/index)?\.mdx?$/;

export function parseBlogFileName(relPath: string): { date: string | null; slug: string } {
  const m = DATE_FILENAME.exec(relPath);
  if (m?.groups) {
    const { folder = '', text = '', date = '' } = m.groups;
    const [y, mo, d] = date.split(/[-/]/).map(Number);
    const iso = new Date(Date.UTC(y ?? 1970, (mo ?? 1) - 1, d ?? 1)).toISOString();
    return { date: iso, slug: `${date.replace(/-/g, '/')}/${folder}${text}` };
  }
  return { date: null, slug: relPath.replace(/(?:\/index)?\.mdx?$/i, '') };
}

const strOrNull = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);

function toIsoDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  const dateOnly = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  const d = dateOnly
    ? new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])))
    : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

interface TagDefinition {
  label: string;
  permalink: string;
}

function readYamlMap(ctx: ParseContext, file: string): Record<string, unknown> | null {
  if (!ctx.isFile(file)) return null;
  try {
    const data: unknown = parseYaml(ctx.read(file));
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    ctx.report({ type: 'unsupported', source: file, action: 'YAML okunamadı', target: null });
    return null;
  }
}

function authorFrom(key: string, raw: Record<string, unknown>): AuthorSource {
  return {
    key,
    name: strOrNull(raw.name) ?? key,
    title: strOrNull(raw.title),
    url: strOrNull(raw.url),
    imageUrl: strOrNull(raw.image_url) ?? strOrNull(raw.imageURL),
    page: raw.page === true || (typeof raw.page === 'object' && raw.page !== null),
  };
}

export function readBlog(
  ctx: ParseContext,
  blogOptions: JsObject | null,
  locales: string[],
  defaultLocale: string,
): BlogResult | null {
  if (blogOptions === null) return null;
  const dir = str(blogOptions.path) ?? 'blog';
  if (!ctx.isDir(dir)) return null;

  const authors = new Map<string, AuthorSource>();
  const authorsFile = `${dir}/${str(blogOptions.authorsMapPath) ?? 'authors.yml'}`;
  for (const [key, raw] of Object.entries(readYamlMap(ctx, authorsFile) ?? {})) {
    if (raw && typeof raw === 'object')
      authors.set(key, authorFrom(key, raw as Record<string, unknown>));
  }
  const tagsFile = `${dir}/${typeof blogOptions.tags === 'string' ? blogOptions.tags : 'tags.yml'}`;
  const tagDefs = new Map<string, TagDefinition>();
  for (const [key, raw] of Object.entries(readYamlMap(ctx, tagsFile) ?? {})) {
    const r = (raw ?? {}) as Record<string, unknown>;
    tagDefs.set(key, {
      label: strOrNull(r.label) ?? key,
      permalink: (strOrNull(r.permalink) ?? kebabCase(key)).replace(/^\/+/, ''),
    });
  }

  const posts: PostSource[] = [];
  let fileCount = 0;

  const resolveAuthors = (fm: Record<string, unknown>, file: string): string[] => {
    const list: unknown[] = [];
    if (Array.isArray(fm.authors)) list.push(...(fm.authors as unknown[]));
    else if (fm.authors !== undefined && fm.authors !== null) list.push(fm.authors);
    if (typeof fm.author === 'string') {
      list.push({
        name: fm.author,
        title: fm.author_title ?? fm.authorTitle,
        url: fm.author_url ?? fm.authorURL,
        image_url: fm.author_image_url ?? fm.authorImageURL,
      });
    }
    const keys: string[] = [];
    for (const item of list) {
      if (typeof item === 'string') {
        if (!authors.has(item)) {
          authors.set(item, authorFrom(item, {}));
          ctx.report({
            type: 'setting',
            source: file,
            action: `"${item}" yazarı ${authorsFile} dosyasında yok; anahtarıyla oluşturuldu`,
            target: null,
          });
        }
        keys.push(item);
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const raw = item as Record<string, unknown>;
      const key = strOrNull(raw.key);
      if (key && authors.has(key)) {
        keys.push(key);
        continue;
      }
      // Inline author: synthesize a stable key from the name.
      const name = strOrNull(raw.name) ?? key ?? 'author';
      const base = key ?? (kebabCase(name) || 'author');
      let candidate = base;
      for (let i = 2; authors.has(candidate) && authors.get(candidate)?.name !== name; i++) {
        candidate = `${base}-${i}`;
      }
      if (!authors.has(candidate)) authors.set(candidate, authorFrom(candidate, { ...raw, name }));
      keys.push(candidate);
    }
    return keys;
  };

  const readPost = (
    file: string,
    relPath: string,
    locale: string,
    source: PostSource | null,
  ): PostSource => {
    const text = ctx.read(file);
    const parsed = markdownToDoc(text);
    const fm = parsed.frontMatter;
    const fromName = parseBlogFileName(relPath);
    const fmSlug = strOrNull(fm.slug);
    const slug = (fmSlug ?? fromName.slug).replace(/^\/+/, '').replace(/\/+$/, '');
    const date =
      toIsoDate(fm.date) ?? fromName.date ?? fs.statSync(ctx.abs(file)).mtime.toISOString();
    const rawTags = Array.isArray(fm.tags) ? (fm.tags as unknown[]) : [];
    const tags: string[] = [];
    const tagPermalinks: string[] = [];
    for (const t of rawTags) {
      if (typeof t === 'string' || typeof t === 'number') {
        const key = String(t);
        const def = tagDefs.get(key);
        tags.push(def?.label ?? key);
        tagPermalinks.push(def?.permalink ?? kebabCase(key));
      } else if (t && typeof t === 'object') {
        const r = t as Record<string, unknown>;
        const label = strOrNull(r.label);
        if (!label) continue;
        tags.push(label);
        tagPermalinks.push((strOrNull(r.permalink) ?? kebabCase(label)).replace(/^\/+/, ''));
      }
    }
    const fileName = relPath.split('/').pop() ?? relPath;
    const body = text
      .replace(/^\uFEFF/, '')
      .replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
    return {
      locale,
      sourcePath: file,
      relPath,
      slug,
      title:
        strOrNull(fm.title) ??
        contentTitle(parsed.doc) ??
        fileName.replace(/(?:\/index)?\.mdx?$/i, ''),
      description: strOrNull(fm.description),
      date,
      authorKeys: resolveAuthors(fm, file),
      tags,
      tagPermalinks,
      image: strOrNull(fm.image),
      draft: fm.draft === true,
      unlisted: fm.unlisted === true,
      frontMatter: Object.fromEntries(Object.entries(fm).filter(([k]) => !POST_FIELDS.has(k))),
      body,
      doc: parsed.doc,
      warnings: parsed.warnings,
      source,
    };
  };

  const sourcePosts = new Map<string, PostSource>();
  for (const file of ctx.files(dir).filter(isMarkdown)) {
    const relPath = file.slice(dir.length + 1);
    if (relPath.split('/').some((p) => p.startsWith('_'))) {
      ctx.report({
        type: 'skipped',
        source: file,
        action: 'Alt çizgiyle başlayan dosya; Docusaurus yayınlamıyor, atlandı',
        target: null,
      });
      continue;
    }
    const post = readPost(file, relPath, defaultLocale, null);
    sourcePosts.set(relPath, post);
    posts.push(post);
    fileCount++;
  }

  for (const locale of locales) {
    if (locale === defaultLocale) continue;
    const localizedDir = `i18n/${locale}/docusaurus-plugin-content-blog`;
    for (const file of ctx.files(localizedDir).filter(isMarkdown)) {
      const relPath = file.slice(localizedDir.length + 1);
      const source = sourcePosts.get(relPath);
      if (!source) {
        ctx.report({
          type: 'skipped',
          source: file,
          action: 'Kaynak dilde karşılığı olan yazı yok; Docusaurus yayınlamıyor, atlandı',
          target: null,
        });
        continue;
      }
      posts.push(readPost(file, relPath, locale, source));
      fileCount++;
    }
  }

  const perPage = blogOptions.postsPerPage;
  return {
    dir,
    posts,
    authors: [...authors.values()],
    postsPerPage: typeof perPage === 'number' && perPage > 0 ? perPage : perPage === 'ALL' ? 0 : 10,
    archive: blogOptions.archiveBasePath !== null,
    fileCount,
  };
}
