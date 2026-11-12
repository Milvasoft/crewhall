import { markdownToDoc, type MarkdownWarning } from '@crewhall/editor';
import { parse as parseYaml } from 'yaml';
import type { ImportCategory } from '../bundle';
import { compareNames, dirOf, type ParseContext } from './context';
import { contentTitle, type EditorDoc } from './markdown';
import {
  docSlug,
  githubSlugs,
  isCategoryIndex,
  isMarkdown,
  parseNumberPrefix,
  stripNumberPrefix,
  stripPathNumberPrefixes,
} from './rules';
import type { VersionSource } from './versions';

/** A doc file read from disk, before its references are rewritten. */
export interface DocSource {
  version: string;
  locale: string;
  sourcePath: string;
  /** Path below the docs root of the default locale, e.g. `a/01-b.md`. */
  relPath: string;
  /** Source dir below the docs root ('.' at the root), number prefixes kept. */
  dir: string;
  baseId: string;
  slug: string;
  title: string;
  sidebarLabel: string | null;
  explicitPosition: number | null;
  position: number;
  description: string | null;
  /** `_`-prefixed file or folder (Docusaurus does not route it). */
  excluded: boolean;
  unlisted: boolean;
  frontMatter: Record<string, unknown>;
  body: string;
  doc: EditorDoc;
  warnings: MarkdownWarning[];
  /** For translations: the default-locale doc. */
  source: DocSource | null;
  sameAsSource: boolean;
  /** Order in the Docusaurus sidebar (depth first), for stable output. */
  order: number;
}

export interface CategorySource extends ImportCategory {
  order: number;
  /** Category label in the default locale (generated-index slugs use it). */
  sourceLabel: string;
}

/** Categories whose position came from no `_category_` value and no number prefix. */
const explicitless = new WeakSet<CategorySource>();

const DOC_FIELDS = new Set([
  'id',
  'slug',
  'title',
  'sidebar_label',
  'sidebar_position',
  'description',
  'draft',
  'unlisted',
]);

const strOrNull = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);
const numOrNull = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : null;

export const normalizeBody = (body: string) => body.replace(/\r\n?/g, '\n').trim();

/** Reads one markdown file into a doc of `version` / `locale`. */
function readDoc(
  ctx: ParseContext,
  params: {
    version: string;
    locale: string;
    sourcePath: string;
    relPath: string;
    source: DocSource | null;
  },
): DocSource {
  const text = ctx.read(params.sourcePath);
  const parsed = markdownToDoc(text);
  const fm = parsed.frontMatter;
  const fileWithExt = params.relPath.split('/').pop() ?? params.relPath;
  const fileName = fileWithExt.replace(/\.mdx?$/i, '');
  const dir = dirOf(params.relPath) || '.';
  const { numberPrefix } = parseNumberPrefix(fileName);
  const baseId = strOrNull(fm.id) ?? stripNumberPrefix(fileName);
  const excluded = params.relPath.split('/').some((p) => p.startsWith('_'));
  let slug = docSlug({ baseId, fileName, dir, frontMatterSlug: strOrNull(fm.slug) });
  // `_tutorial/x` is not routed by Docusaurus; give the unlisted import a valid slug.
  if (excluded) {
    slug = slug
      .split('/')
      .map((s) => s.replace(/^_+/, ''))
      .join('/');
  }
  const frontMatter = Object.fromEntries(Object.entries(fm).filter(([k]) => !DOC_FIELDS.has(k)));
  const body = text
    .replace(/^\uFEFF/, '')
    .replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
  const explicitPosition = numOrNull(fm.sidebar_position) ?? numberPrefix;
  return {
    version: params.version,
    locale: params.locale,
    sourcePath: params.sourcePath,
    relPath: params.relPath,
    dir,
    baseId,
    slug,
    title: strOrNull(fm.title) ?? contentTitle(parsed.doc) ?? baseId,
    sidebarLabel: strOrNull(fm.sidebar_label),
    explicitPosition,
    position: explicitPosition ?? 0,
    description: strOrNull(fm.description),
    excluded,
    unlisted: excluded || fm.draft === true || fm.unlisted === true,
    frontMatter,
    body,
    doc: parsed.doc,
    warnings: parsed.warnings,
    source: params.source,
    sameAsSource: params.source ? normalizeBody(body) === normalizeBody(params.source.body) : false,
    order: 0,
  };
}

export interface DocsResult {
  docs: DocSource[];
  categories: CategorySource[];
  /** Markdown files read. */
  fileCount: number;
}

/**
 * Reads every version in every locale. Translations mirror the default-locale paths
 * (`i18n/<locale>/docusaurus-plugin-content-docs/<current|version-x>/<same path>`); a doc
 * without one is served in the default language by Docusaurus and is not listed here.
 */
export function readDocs(
  ctx: ParseContext,
  versions: VersionSource[],
  locales: string[],
  defaultLocale: string,
): DocsResult {
  const docs: DocSource[] = [];
  const categories: CategorySource[] = [];
  let fileCount = 0;
  const knownLocalizedDirs = new Set<string>();

  for (const version of versions) {
    if (!version.contentDir || !ctx.isDir(version.contentDir)) continue;
    const sourceFiles = ctx.files(version.contentDir).filter(isMarkdown);
    const sourceDocs: DocSource[] = [];
    for (const file of sourceFiles) {
      const relPath = file.slice(version.contentDir.length + 1);
      sourceDocs.push(
        readDoc(ctx, {
          version: version.name,
          locale: defaultLocale,
          sourcePath: file,
          relPath,
          source: null,
        }),
      );
      fileCount++;
    }
    const sourceCategories = buildCategories(ctx, version, defaultLocale, sourceDocs, null);
    docs.push(...sourceDocs);
    categories.push(...sourceCategories);

    for (const locale of locales) {
      if (locale === defaultLocale) continue;
      const localizedDir = `i18n/${locale}/docusaurus-plugin-content-docs/${version.localizedDirName}`;
      knownLocalizedDirs.add(localizedDir);
      const translated: DocSource[] = [];
      const bySource = new Map(sourceDocs.map((d) => [d.relPath, d]));
      for (const file of ctx.files(localizedDir).filter(isMarkdown)) {
        const relPath = file.slice(localizedDir.length + 1);
        const source = bySource.get(relPath);
        if (!source) {
          ctx.report({
            type: 'skipped',
            source: file,
            action: 'Kaynak dilde karşılığı olan doküman yok; Docusaurus yayınlamıyor, atlandı',
            target: null,
          });
          continue;
        }
        translated.push(
          readDoc(ctx, { version: version.name, locale, sourcePath: file, relPath, source }),
        );
        fileCount++;
      }
      // Sidebar order and categories are built over the effective docs of the locale.
      const effective = sourceDocs.map((s) => translated.find((t) => t.relPath === s.relPath) ?? s);
      categories.push(
        ...buildCategories(ctx, version, locale, effective, {
          localizedDir,
          sourceCategories,
        }),
      );
      docs.push(...translated);
    }
  }

  // Localized version folders that match no version (e.g. an old template's version-x).
  for (const locale of locales) {
    if (locale === defaultLocale) continue;
    const base = `i18n/${locale}/docusaurus-plugin-content-docs`;
    for (const file of ctx.files(base).filter(isMarkdown)) {
      const top = file.slice(base.length + 1).split('/')[0] ?? '';
      if (knownLocalizedDirs.has(`${base}/${top}`)) continue;
      ctx.report({
        type: 'skipped',
        source: file,
        action: /^version-/.test(top)
          ? `Böyle bir versiyon yok (${top.slice('version-'.length)}); eski şablon dosyası, atlandı`
          : 'Bir versiyon klasöründe değil; Docusaurus yayınlamıyor, atlandı',
        target: null,
      });
    }
  }

  return { docs, categories, fileCount };
}

// ---------------------------------------------------------------------------
// Categories and sidebar order

interface CategoryMeta {
  label?: string;
  position?: number;
  collapsed?: boolean;
  link?: { type?: string; slug?: string; id?: string; description?: string; title?: string } | null;
}

function readCategoryMeta(ctx: ParseContext, dir: string): CategoryMeta | null {
  for (const name of ['_category_.json', '_category_.yml', '_category_.yaml']) {
    const file = `${dir}/${name}`;
    if (!ctx.isFile(file)) continue;
    let data: unknown;
    try {
      data = name.endsWith('.json')
        ? JSON.parse(ctx.read(file).replace(/^\uFEFF/, ''))
        : parseYaml(ctx.read(file));
    } catch {
      ctx.report({
        type: 'unsupported',
        source: file,
        action: 'Okunamadı; klasör adı ve varsayılan sıra kullanıldı',
        target: null,
      });
      return null;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const d = data as Record<string, unknown>;
    const link = d.link;
    return {
      label: strOrNull(d.label) ?? undefined,
      position: numOrNull(d.position) ?? undefined,
      collapsed: typeof d.collapsed === 'boolean' ? d.collapsed : undefined,
      link:
        link === null
          ? null
          : link && typeof link === 'object' && !Array.isArray(link)
            ? (link as CategoryMeta['link'])
            : undefined,
    };
  }
  return null;
}

/** `i18n/<locale>/docusaurus-plugin-content-docs/<current|version-x>.json` messages. */
function readSidebarTranslations(ctx: ParseContext, localizedDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const data = ctx.readJson(`${localizedDir}.json`);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const message = (value as { message?: unknown } | null)?.message;
      if (typeof message === 'string') out.set(key, message);
    }
  }
  return out;
}

type SidebarNode =
  | { kind: 'doc'; name: string; position: number | null; doc: DocSource }
  | { kind: 'category'; name: string; position: number | null; category: CategorySource };

/**
 * Categories of one version + locale, the fallback positions of unpositioned items and the
 * sidebar order. Docusaurus autogenerated sidebars: a folder's label and position come from
 * `_category_.json` (else the folder name and its number prefix), items with a position come
 * first in ascending order, the rest follow alphabetically. Generated-index slugs are
 * `category/<github-slug of the default-locale label>`, de-duplicated per version.
 */
function buildCategories(
  ctx: ParseContext,
  version: VersionSource,
  locale: string,
  docs: DocSource[],
  translation: { localizedDir: string; sourceCategories: CategorySource[] } | null,
): CategorySource[] {
  const dirs = new Set<string>();
  for (const doc of docs) {
    let d = doc.dir;
    while (d && d !== '.') {
      dirs.add(d);
      d = dirOf(d);
    }
  }
  const messages = translation
    ? readSidebarTranslations(ctx, translation.localizedDir)
    : new Map<string, string>();
  const sidebarId = version.sidebarIds[0] ?? 'docsSidebar';
  const sourceByDir = new Map(translation?.sourceCategories.map((c) => [c.dir, c]) ?? []);

  const categories = new Map<string, CategorySource>();
  for (const dir of [...dirs].sort(compareNames)) {
    const name = dir.split('/').pop() ?? dir;
    const meta = readCategoryMeta(ctx, `${version.contentDir}/${dir}`) ?? {};
    const localized = translation
      ? readCategoryMeta(ctx, `${translation.localizedDir}/${dir}`)
      : null;
    const sourceLabel = meta.label ?? stripNumberPrefix(name);
    const key = `sidebar.${sidebarId}.category.${sourceLabel}`;
    const label = localized?.label ?? messages.get(key) ?? sourceLabel;
    const position = meta.position ?? parseNumberPrefix(name).numberPrefix;
    const indexDoc = docs.find((d) => d.dir === dir && isCategoryIndex(fileNameOf(d), d.dir));
    let link: ImportCategory['link'] = 'none';
    let linkSlug: string | null = null;
    if (meta.link === null) link = 'none';
    else if (meta.link?.type === 'generated-index') {
      link = 'generated-index';
      linkSlug = meta.link.slug ? meta.link.slug.replace(/^\/+/, '').replace(/\/+$/, '') : null;
    } else if (meta.link?.type === 'doc' && meta.link.id) {
      const id = meta.link.id;
      const target = docs.find(
        (d) => fullId(d) === id || fullId(d) === `${stripPathNumberPrefixes(dir)}/${id}`,
      );
      link = target ? 'doc' : 'none';
      linkSlug = target?.slug ?? null;
      if (!target) {
        ctx.report({
          type: 'link',
          source: `${version.contentDir}/${dir}/_category_.json`,
          action: `Kategori linki "${id}" dokümanını bulamadı; link kaldırıldı`,
          target: null,
        });
      }
    } else if (indexDoc) {
      link = 'doc';
      linkSlug = indexDoc.slug;
    }
    const description =
      (localized?.link?.type === 'generated-index' ? localized.link.description : undefined) ??
      messages.get(`${key}.link.generated-index.description`) ??
      (meta.link?.type === 'generated-index' ? meta.link.description : undefined) ??
      null;
    categories.set(dir, {
      version: version.name,
      locale,
      dir,
      parentDir: dirOf(dir),
      // `_` folders are not routed by Docusaurus; their slug drops the underscore like their docs.
      slug: stripPathNumberPrefixes(dir)
        .split('/')
        .map((s) => s.replace(/^_+/, ''))
        .join('/'),
      label,
      sourceLabel,
      position: position ?? 0,
      description: description?.trim() ? description : null,
      link,
      linkSlug,
      collapsed: meta.collapsed ?? null,
      unlisted: dir.split('/').some((p) => p.startsWith('_')),
      order: 0,
    });
    if (position === null) explicitless.add(categories.get(dir)!);
  }

  // Sidebar tree per parent dir.
  const children = new Map<string, SidebarNode[]>();
  const push = (parent: string, node: SidebarNode) => {
    const list = children.get(parent) ?? [];
    list.push(node);
    children.set(parent, list);
  };
  for (const doc of docs) {
    const parent = doc.dir === '.' ? '' : doc.dir;
    push(parent, {
      kind: 'doc',
      name: doc.relPath.split('/').pop() ?? doc.relPath,
      position: doc.explicitPosition,
      doc,
    });
  }
  for (const category of categories.values()) {
    push(category.parentDir, {
      kind: 'category',
      name: category.dir.split('/').pop() ?? category.dir,
      position: explicitless.has(category) ? null : category.position,
      category,
    });
  }

  let order = 0;
  const generated: CategorySource[] = [];
  const visit = (parent: string) => {
    const list = children.get(parent) ?? [];
    const positioned = list
      .filter((n) => n.position !== null)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || compareNames(a.name, b.name));
    const rest = list
      .filter((n) => n.position === null)
      .sort((a, b) => compareNames(a.name, b.name));
    const base = positioned.length ? Math.max(...positioned.map((n) => n.position ?? 0)) : 0;
    rest.forEach((n, i) => {
      if (n.kind === 'category') n.category.position = base + 1 + i;
      // Default-locale docs shown in another locale keep their own values.
      else if (n.doc.locale === locale) n.doc.position = base + 1 + i;
    });
    for (const node of [...positioned, ...rest]) {
      if (node.kind === 'doc') {
        if (node.doc.locale === locale) node.doc.order = order;
        order++;
      } else {
        node.category.order = order++;
        visit(node.category.dir);
        // Docusaurus slugs a category after its items (post-order).
        if (node.category.link === 'generated-index' && node.category.linkSlug === null) {
          generated.push(node.category);
        }
      }
    }
  };
  visit('');

  if (translation) {
    for (const category of generated) {
      category.linkSlug = sourceByDir.get(category.dir)?.linkSlug ?? null;
    }
  }
  const missing = generated.filter((c) => c.linkSlug === null);
  const slugs = githubSlugs(missing.map((c) => c.sourceLabel));
  missing.forEach((c, i) => {
    c.linkSlug = `category/${slugs[i] ?? ''}`;
  });

  return [...categories.values()];
}

export const fileNameOf = (doc: DocSource) =>
  (doc.relPath.split('/').pop() ?? '').replace(/\.mdx?$/i, '');

/** Docusaurus doc id: folder path without number prefixes + base id. */
export const fullId = (doc: DocSource) =>
  doc.dir === '.' ? doc.baseId : `${stripPathNumberPrefixes(doc.dir)}/${doc.baseId}`;
