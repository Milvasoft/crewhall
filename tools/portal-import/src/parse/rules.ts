import path from 'node:path';
import { headings } from '@crewhall/editor';

/**
 * Docusaurus 3 naming rules (plugin-content-docs / plugin-content-blog / utils), reimplemented
 * so the import produces the same URLs as the Docusaurus build.
 */

// ---------------------------------------------------------------------------
// Number prefixes (`02-quick-start.md`, `01-folder/`)

const DATE_LIKE = /^(?:\d{2}|\d{4})[-_.]\d{2}(?:[-_.](?:\d{2}|\d{4}))?.*$/;
const VERSION_LIKE = /^\d+[-_.]\d+.*$/;
const NUMBER_PREFIX = /^(?<numberPrefix>\d+)\s*[-_.]+\s*(?<suffix>[^-_.\s].*)$/;

/** Docusaurus `DefaultNumberPrefixParser`: dates and version-like names keep their digits. */
export function parseNumberPrefix(name: string): { filename: string; numberPrefix: number | null } {
  if (DATE_LIKE.test(name) || VERSION_LIKE.test(name))
    return { filename: name, numberPrefix: null };
  const m = NUMBER_PREFIX.exec(name);
  if (!m?.groups) return { filename: name, numberPrefix: null };
  return { filename: m.groups.suffix ?? name, numberPrefix: Number(m.groups.numberPrefix) };
}

export const stripNumberPrefix = (name: string) => parseNumberPrefix(name).filename;

/** `01-a/02-b` → `a/b` ('.' stays '.'). */
export function stripPathNumberPrefixes(dir: string): string {
  if (dir === '.' || dir === '') return dir;
  return dir.split('/').map(stripNumberPrefix).join('/');
}

// ---------------------------------------------------------------------------
// Doc ids and slugs

/** Docusaurus `isCategoryIndex`: index.md, README.md or a file named like its folder. */
export function isCategoryIndex(fileName: string, dir: string): boolean {
  const name = fileName.toLowerCase();
  const folder = dir === '.' || dir === '' ? undefined : dir.split('/').pop()?.toLowerCase();
  return name === 'index' || name === 'readme' || (folder !== undefined && name === folder);
}

/** URL path resolution like `resolve-pathname` (`../x` against `/a/b/`). */
export function resolvePathname(to: string, from: string): string {
  if (to.startsWith('/')) return to;
  const base = from.endsWith('/') ? from : from.slice(0, from.lastIndexOf('/') + 1);
  const parts = (base + to).split('/');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? '';
    const last = i === parts.length - 1;
    if (p === '.') {
      if (last) out.push('');
      continue;
    }
    if (p === '..') {
      if (out.length > 1) out.pop();
      if (last) out.push('');
      continue;
    }
    out.push(p);
  }
  const joined = out.join('/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

/**
 * Docusaurus `getSlug`: front matter `slug` (absolute from the docs root or relative to the
 * folder), the folder URL for a category index, else `<folder>/<baseId>`. Returns the path
 * below the version root without leading or trailing slash.
 */
export function docSlug(params: {
  baseId: string;
  fileName: string;
  /** Source dir below the docs root, number prefixes kept; '.' at the root. */
  dir: string;
  frontMatterSlug: string | null;
}): string {
  const { baseId, fileName, dir, frontMatterSlug } = params;
  const dirStripped = stripPathNumberPrefixes(dir);
  const dirSlug = dir === '.' ? '/' : `/${dirStripped}/`;
  let slug: string;
  if (frontMatterSlug?.startsWith('/')) slug = frontMatterSlug;
  else if (!frontMatterSlug && isCategoryIndex(fileName, dir)) slug = dirSlug;
  else slug = resolvePathname(frontMatterSlug ?? baseId, dirSlug);
  return slug.replace(/^\/+/, '').replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Slugs for labels and tags

/** github-slugger over labels in order, de-duplicated (Docusaurus `createSlugger`). */
export function githubSlugs(labels: string[]): string[] {
  if (labels.length === 0) return [];
  const doc = {
    type: 'doc' as const,
    content: labels.map((text) => ({
      type: 'heading',
      attrs: { level: 2 },
      content: text ? [{ type: 'text', text }] : [],
    })),
  };
  return headings(doc).map((h) => h.id);
}

/** lodash `kebabCase` (blog tag permalinks). */
export function kebabCase(value: string): string {
  const deburred = value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ı/g, 'i')
    .replace(/[’']/g, '');
  const words = deburred.match(/\p{Lu}?\p{Ll}+|\p{Lu}+(?!\p{Ll})|\p{N}+|\p{Lu}|\p{Lo}+/gu) ?? [];
  return words.map((w) => w.toLowerCase()).join('-');
}

// ---------------------------------------------------------------------------
// Paths and files

export const toPosix = (p: string) => p.split(path.sep).join('/');

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export const mimeOf = (file: string) =>
  MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

/** Source code and config: not media (design 10.16 "kod dosyası"). */
const CODE_EXT =
  /\.(tsx?|jsx?|mjs|cjs|mts|cts|json|jsonc|ya?ml|css|scss|sass|less|html?|sh|ps1|cs|py|toml|lock)$/i;

export const isCodeFile = (file: string) => CODE_EXT.test(file);
export const isMarkdown = (file: string) => /\.mdx?$/i.test(file);
