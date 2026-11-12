import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PortalDocSlug, PortalPostSlug } from '@crewhall/shared';
import type {
  ImportAuthor,
  ImportBundle,
  ImportCategory,
  ImportDoc,
  ImportEntry,
  ImportMedia,
  ImportPost,
} from '../bundle';
import { readBlog, type PostSource } from './blog';
import { arr, classicPresetOptions, obj, readDocusaurusConfig, str, type JsObject } from './config';
import { ParseContext } from './context';
import { fullId, readDocs, normalizeBody, type DocSource } from './docs';
import { ReferenceRewriter, reportWarnings, type RewriteScope } from './markdown';
import { isCodeFile, isMarkdown, mimeOf } from './rules';
import { readHome, readNavigation, readSettings, reportConfig, type MediaLookup } from './site';
import { compareUrls, localePrefix, sitePath } from './urls';
import { readVersions, type VersionSource } from './versions';

export interface ParseOptions {
  /** Paths of the old site (sitemap); adds a URL comparison row to the report. */
  oldUrls?: string[];
}

const LANGUAGE_INSTRUMENTAL: Record<string, string> = {
  en: 'İngilizceyle',
  tr: 'Türkçeyle',
  de: 'Almancayla',
  fr: 'Fransızcayla',
  es: 'İspanyolcayla',
};

/**
 * Reads a Docusaurus 3 checkout into an `ImportBundle` (design 10.15 / 10.16): docs per version
 * and locale with their categories, blog posts and authors, media files, the home page,
 * navbar / footer, site settings, the URLs the imported site will serve and the report rows.
 * Nothing is executed: `docusaurus.config.js` and `sidebars.js` are read as ASTs.
 */
export async function parseDocusaurus(
  root: string,
  options: ParseOptions = {},
): Promise<ImportBundle> {
  const absRoot = path.resolve(root);
  const ctx = new ParseContext(absRoot);

  // --- Config -----------------------------------------------------------------------------
  const configFile = ['docusaurus.config.js', 'docusaurus.config.mjs', 'docusaurus.config.ts'].find(
    (f) => ctx.isFile(f),
  );
  let config: JsObject = {};
  if (configFile) {
    const read = readDocusaurusConfig(ctx.read(configFile));
    config = read.config;
    for (const error of read.errors) {
      ctx.report({
        type: 'unsupported',
        source: configFile,
        action: `Okunamadı: ${error}`,
        target: null,
      });
    }
  } else {
    ctx.report({
      type: 'unsupported',
      source: 'docusaurus.config.js',
      action: 'Dosya yok; varsayılan Docusaurus ayarları kullanıldı',
      target: null,
    });
  }
  const i18n = obj(config.i18n);
  const defaultLocale = str(i18n.defaultLocale) ?? 'en';
  const locales = [
    defaultLocale,
    ...arr(i18n.locales ?? null).filter(
      (l): l is string => typeof l === 'string' && l !== defaultLocale,
    ),
  ];
  const classic = classicPresetOptions(config);
  const docsOptions = classic.docs === false ? null : obj(classic.docs);
  const blogOptions = classic.blog === false ? null : obj(classic.blog);
  const staticDirs = arr(config.staticDirectories ?? ['static']).filter(
    (d): d is string => typeof d === 'string',
  );
  reportConfig(ctx, config, classic);

  // --- Content ------------------------------------------------------------------------------
  const { versions, currentVersion } = docsOptions
    ? readVersions(ctx, docsOptions)
    : { versions: [] as VersionSource[], currentVersion: '1.0.0' };
  const docsResult = readDocs(ctx, versions, locales, defaultLocale);
  const blog = readBlog(ctx, blogOptions, locales, defaultLocale);
  const posts = blog?.posts ?? [];
  const versionByName = new Map(versions.map((v) => [v.name, v]));
  const isPublicVersion = (name: string) => versionByName.get(name)?.status !== 'next';

  // --- Permalinks and URLs ------------------------------------------------------------------
  const urls = new Set<string>();
  const known = new Set<string>();
  const permalinks = new Map<string, string>();
  const docUrl = (doc: DocSource, locale: string) =>
    sitePath(localePrefix(locale, defaultLocale), 'docs', doc.version, doc.slug);
  const sourceDocs = docsResult.docs.filter((d) => d.source === null);
  const translations = new Map<string, DocSource>();
  for (const d of docsResult.docs) {
    if (d.source) translations.set(`${d.locale}\0${d.source.sourcePath}`, d);
  }
  for (const locale of locales) {
    for (const source of sourceDocs) {
      const doc =
        locale === defaultLocale
          ? source
          : (translations.get(`${locale}\0${source.sourcePath}`) ?? source);
      const url = docUrl(doc, locale);
      permalinks.set(`${locale}\0${source.sourcePath}`, url);
      if (doc !== source) permalinks.set(`${locale}\0${doc.sourcePath}`, url);
      known.add(url);
      if (!doc.unlisted && isPublicVersion(doc.version)) urls.add(url);
    }
    for (const category of docsResult.categories) {
      if (category.locale !== locale || category.link !== 'generated-index' || !category.linkSlug)
        continue;
      const url = sitePath(
        localePrefix(locale, defaultLocale),
        'docs',
        category.version,
        category.linkSlug,
      );
      known.add(url);
      if (!category.unlisted && isPublicVersion(category.version)) urls.add(url);
    }
  }

  const blogBase = '/blog';
  const postUrl = (post: PostSource, locale: string) =>
    sitePath(localePrefix(locale, defaultLocale), blogBase, post.slug);
  const sourcePosts = posts.filter((p) => p.source === null);
  const postTranslations = new Map<string, PostSource>();
  for (const p of posts)
    if (p.source) postTranslations.set(`${p.locale}\0${p.source.sourcePath}`, p);
  for (const locale of locales) {
    const prefix = localePrefix(locale, defaultLocale);
    urls.add(prefix || '/');
    urls.add(sitePath(prefix, 'search'));
    if (!blog) continue;
    const effective = sourcePosts
      .map((s) =>
        locale === defaultLocale ? s : (postTranslations.get(`${locale}\0${s.sourcePath}`) ?? s),
      )
      .filter((p) => !p.draft);
    for (const p of effective) {
      const url = postUrl(p, locale);
      const source = p.source ?? p;
      permalinks.set(`${locale}\0${source.sourcePath}`, url);
      if (p !== source) permalinks.set(`${locale}\0${p.sourcePath}`, url);
      known.add(url);
      if (!p.unlisted) urls.add(url);
    }
    const listed = effective.filter((p) => !p.unlisted);
    const pages = (count: number) =>
      blog.postsPerPage > 0 ? Math.max(1, Math.ceil(count / blog.postsPerPage)) : 1;
    const addPaged = (base: string, count: number) => {
      urls.add(base);
      for (let i = 2; i <= pages(count); i++) urls.add(sitePath(base, 'page', String(i)));
    };
    addPaged(sitePath(prefix, blogBase), listed.length);
    if (listed.length && blog.archive) urls.add(sitePath(prefix, blogBase, 'archive'));
    const tagCounts = new Map<string, number>();
    for (const p of listed) {
      for (const t of new Set(p.tagPermalinks)) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
    if (tagCounts.size) urls.add(sitePath(prefix, blogBase, 'tags'));
    for (const [tag, count] of tagCounts) addPaged(sitePath(prefix, blogBase, 'tags', tag), count);
    if (blog.authors.length) {
      urls.add(sitePath(prefix, blogBase, 'authors'));
      for (const a of blog.authors.filter((x) => x.page)) {
        const count = listed.filter((p) => p.authorKeys.includes(a.key)).length;
        addPaged(sitePath(prefix, blogBase, 'authors', a.key), count);
      }
    }
    for (const feed of ['rss.xml', 'atom.xml', 'feed.json'])
      known.add(sitePath(prefix, blogBase, feed));
  }
  for (const u of urls) known.add(u);

  // src/pages: only the home page is carried over.
  for (const file of ctx.files('src/pages')) {
    const rel = file.slice('src/pages/'.length);
    if (!/\.(mdx?|[jt]sx?)$/.test(rel) || /^index\.[jt]sx?$/.test(rel) || /(^|\/)_/.test(rel))
      continue;
    const route = rel.replace(/\.(mdx?|[jt]sx?)$/, '').replace(/(^|\/)index$/, '');
    ctx.report({
      type: 'skipped',
      source: file,
      action: `src/pages sayfası (/${route}); ana sayfaya 301 yönlendirmesi eklenecek`,
      target: null,
    });
  }

  // --- Markdown -----------------------------------------------------------------------------
  const rewriter = new ReferenceRewriter(ctx, { permalinks, knownUrls: known, staticDirs });
  const sameAs = LANGUAGE_INSTRUMENTAL[defaultLocale] ?? 'kaynak dille';

  const docs: ImportDoc[] = [];
  const versionIndex = new Map(versions.map((v, i) => [v.name, i]));
  const localeIndex = new Map(locales.map((l, i) => [l, i]));
  const orderedDocs = [...docsResult.docs].sort(
    (a, b) =>
      (versionIndex.get(a.version) ?? 0) - (versionIndex.get(b.version) ?? 0) ||
      (localeIndex.get(a.locale) ?? 0) - (localeIndex.get(b.locale) ?? 0) ||
      a.order - b.order,
  );
  for (const doc of orderedDocs) {
    const version = versionByName.get(doc.version);
    const target: ImportEntry['target'] = {
      kind: 'doc',
      version: doc.version,
      locale: doc.locale,
      slug: doc.slug,
    };
    const localizedRoot =
      doc.locale === defaultLocale
        ? null
        : `i18n/${doc.locale}/docusaurus-plugin-content-docs/${version?.localizedDirName ?? ''}`;
    const scope: RewriteScope = {
      file: doc.sourcePath,
      sourceFile: doc.source?.sourcePath ?? null,
      locale: doc.locale,
      pageUrl: docUrl(doc, doc.locale),
      roots: [...(localizedRoot ? [localizedRoot] : []), version?.contentDir ?? 'docs'],
      target,
    };
    reportWarnings(ctx, doc.sourcePath, doc.warnings, target);
    const { markdown } = rewriter.rewrite(doc.doc, scope);
    if (doc.sameAsSource) {
      ctx.report({
        type: 'translation',
        source: doc.sourcePath,
        action: `İçerik ${sameAs} aynı; "çevrilmedi" işaretlendi`,
        target,
      });
    }
    if (!PortalDocSlug.safeParse(doc.slug).success) {
      ctx.report({
        type: 'unsupported',
        source: doc.sourcePath,
        action: `Slug "${doc.slug}" portal slug kuralına uymuyor; adres korunsun diye olduğu gibi bırakıldı`,
        target,
      });
    }
    docs.push({
      version: doc.version,
      locale: doc.locale,
      sourcePath: doc.sourcePath,
      dir: doc.dir === '.' ? '' : doc.dir,
      id: doc.baseId,
      slug: doc.slug,
      title: doc.title,
      sidebarLabel: doc.sidebarLabel,
      position: doc.position,
      description: doc.description,
      unlisted: doc.unlisted,
      frontMatter: doc.frontMatter,
      markdown,
      sameAsSource: doc.sameAsSource,
    });
  }

  const categories: ImportCategory[] = [...docsResult.categories]
    .sort(
      (a, b) =>
        (versionIndex.get(a.version) ?? 0) - (versionIndex.get(b.version) ?? 0) ||
        (localeIndex.get(a.locale) ?? 0) - (localeIndex.get(b.locale) ?? 0) ||
        a.order - b.order,
    )
    .map(({ order: _order, sourceLabel: _sourceLabel, ...c }) => c);

  const importPosts: ImportPost[] = [];
  const orderedPosts = [...posts].sort(
    (a, b) =>
      (localeIndex.get(a.locale) ?? 0) - (localeIndex.get(b.locale) ?? 0) ||
      b.date.localeCompare(a.date) ||
      a.sourcePath.localeCompare(b.sourcePath),
  );
  for (const post of orderedPosts) {
    const target: ImportEntry['target'] = { kind: 'post', locale: post.locale, slug: post.slug };
    const scope: RewriteScope = {
      file: post.sourcePath,
      sourceFile: post.source?.sourcePath ?? null,
      locale: post.locale,
      pageUrl: postUrl(post, post.locale),
      roots: [
        ...(post.locale === defaultLocale
          ? []
          : [`i18n/${post.locale}/docusaurus-plugin-content-blog`]),
        blog?.dir ?? 'blog',
      ],
      target,
    };
    reportWarnings(ctx, post.sourcePath, post.warnings, target);
    const { markdown } = rewriter.rewrite(post.doc, scope);
    if (post.source && normalizeBody(post.body) === normalizeBody(post.source.body)) {
      ctx.report({
        type: 'translation',
        source: post.sourcePath,
        action: `İçerik ${sameAs} aynı; "çevrilmedi" işaretlendi`,
        target,
      });
    }
    if (!PortalPostSlug.safeParse(post.slug).success) {
      ctx.report({
        type: 'unsupported',
        source: post.sourcePath,
        action: `Slug "${post.slug}" tek parçalı yazı slug kuralına uymuyor; adres korunsun diye olduğu gibi bırakıldı`,
        target,
      });
    }
    let cover: string | null = null;
    if (post.image) {
      const resolved = rewriter.image(post.image, scope);
      cover = resolved === undefined ? post.image : resolved;
      if (resolved === null) {
        ctx.report({
          type: 'image',
          source: post.sourcePath,
          action: `Kapak görseli yok (${post.image}); boş bırakıldı`,
          target,
        });
      }
    }
    importPosts.push({
      locale: post.locale,
      sourcePath: post.sourcePath,
      slug: post.slug,
      title: post.title,
      description: post.description,
      date: post.date,
      authorKeys: post.authorKeys,
      tags: post.tags,
      cover,
      frontMatter: post.frontMatter,
      markdown,
    });
  }

  const authors: ImportAuthor[] = (blog?.authors ?? []).map(({ page: _page, ...a }) => {
    if (!a.imageUrl || /^(https?:)?\/\//i.test(a.imageUrl) || /^data:/i.test(a.imageUrl)) return a;
    const file = rewriter.resolveImageFile(a.imageUrl, {
      file: `${blog?.dir ?? 'blog'}/authors.yml`,
      sourceFile: null,
    });
    if (file) rewriter.referencedMedia.add(file);
    return { ...a, imageUrl: file ? rewriter.mediaPath(file) : a.imageUrl };
  });

  // --- Site, navigation, home ---------------------------------------------------------------
  const media: MediaLookup = (assetPath, source) => {
    if (/^(https?:)?\/\//i.test(assetPath) || /^data:/i.test(assetPath)) return assetPath;
    const file = rewriter.resolveImageFile(`/${assetPath.replace(/^\/+/, '')}`, {
      file: '',
      sourceFile: null,
    });
    if (file) {
      rewriter.referencedMedia.add(file);
      return rewriter.mediaPath(file);
    }
    ctx.report({
      type: source.startsWith('src/pages') ? 'home' : 'setting',
      source,
      action: `Dosya yok (${assetPath}); boş bırakıldı`,
      target: null,
    });
    return null;
  };
  const settings = readSettings(ctx, config, media);
  const current = versionByName.get(currentVersion);
  const navigation = readNavigation(
    ctx,
    config,
    locales,
    defaultLocale,
    media,
    (docId) => {
      const doc = sourceDocs.find((d) => d.version === current?.name && fullId(d) === docId);
      return doc ? docUrl(doc, defaultLocale) : null;
    },
    blogBase,
  );
  const home = readHome(ctx, locales, defaultLocale, currentVersion, media);

  // --- Media --------------------------------------------------------------------------------
  const mediaFiles = new Set<string>();
  const authorsFile = blog ? `${blog.dir}/authors.yml` : null;
  const walkDirs = [
    ...staticDirs,
    ...(docsOptions ? [str(docsOptions.path) ?? 'docs', 'versioned_docs'] : []),
    'i18n',
    ...(blog ? [blog.dir] : []),
  ];
  for (const dir of [...new Set(walkDirs)]) {
    for (const file of ctx.files(dir)) {
      const name = file.split('/').pop() ?? file;
      if (isMarkdown(file) || /^_category_\.(json|ya?ml)$/.test(name) || file === authorsFile)
        continue;
      if (blog && file === `${blog.dir}/tags.yml`) continue;
      // Translation files: i18n/<locale>/<file>.json, i18n/<locale>/<plugin>/<file>.json
      if (/^i18n\/[^/]+\/(?:[^/]+\/)?[^/]+\.json$/.test(file)) continue;
      if (isCodeFile(file)) {
        ctx.report({
          type: 'skipped',
          source: file,
          action: "Kod dosyası, doküman değil; istenirse Medya'ya ek olarak yüklenir",
          target: null,
        });
        continue;
      }
      mediaFiles.add(file);
    }
  }
  for (const file of rewriter.referencedMedia) mediaFiles.add(file);
  const mediaList: ImportMedia[] = [...mediaFiles]
    .map((file) => ({
      path: rewriter.mediaPath(file),
      file: ctx.abs(file),
      mime: mimeOf(file),
      size: fs.statSync(ctx.abs(file)).size,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // --- Result -------------------------------------------------------------------------------
  const urlList = [...urls].sort();
  if (options.oldUrls) {
    const cmp = compareUrls(urlList, options.oldUrls);
    const total = cmp.matched + cmp.missing.length;
    ctx.report({
      type: 'setting',
      source: 'sitemap',
      action:
        cmp.missing.length === 0
          ? `${cmp.matched} / ${total} URL aynı; yönlendirme gerekmiyor`
          : `${cmp.matched} / ${total} URL aynı; ${cmp.missing.length} adres için yönlendirme gerekir: ${cmp.missing.join(', ')}`,
      target: null,
    });
  }

  const siteTitle = settings.title ?? path.basename(absRoot);
  return {
    source: `${path.basename(absRoot)}${gitHead(absRoot)}`,
    site: { name: siteTitle, locales, defaultLocale, settings },
    currentVersion,
    versions: versions.map(({ name, label, status, showInPicker }) => ({
      name,
      label,
      status,
      showInPicker,
    })),
    categories,
    docs,
    authors,
    posts: importPosts,
    media: mediaList,
    home,
    navigation,
    entries: ctx.entries,
    fileCount: docsResult.fileCount + (blog?.fileCount ?? 0),
    urls: urlList,
  };
}

/** ` @ <short sha>` when the checkout is a git repository. */
function gitHead(root: string): string {
  if (!fs.existsSync(path.join(root, '.git'))) return '';
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return sha ? ` @ ${sha}` : '';
  } catch {
    return '';
  }
}
