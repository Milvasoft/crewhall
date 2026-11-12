import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdownToDoc, references } from '@crewhall/editor';
import { PortalHome, PortalNavigation } from '@crewhall/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { compareUrls, parseDocusaurus, type ImportBundle } from '../src';

const SITE = fileURLToPath(new URL('./fixtures/site', import.meta.url));

let bundle: ImportBundle;
beforeAll(async () => {
  bundle = await parseDocusaurus(SITE, { oldUrls: ['/docs/2.0.0/intro', '/old-page'] });
});

const doc = (sourcePath: string) => {
  const d = bundle.docs.find((x) => x.sourcePath === sourcePath);
  if (!d) throw new Error(`no doc ${sourcePath}`);
  return d;
};
const entries = (type: string) => bundle.entries.filter((e) => e.type === type);

describe('fixture site: versions, docs and categories', () => {
  it('maps versions: current from config, archived from versions.json, an empty next', () => {
    expect(bundle.currentVersion).toBe('2.0.0');
    expect(bundle.versions).toEqual([
      { name: '2.0.0', label: '2.0.0', status: 'current', showInPicker: true },
      { name: '1.0.0', label: '1.0.0', status: 'archived', showInPicker: true },
      { name: 'next', label: 'Next', status: 'next', showInPicker: false },
    ]);
    expect(bundle.site).toMatchObject({
      name: 'Acme Docs',
      locales: ['en', 'tr'],
      defaultLocale: 'en',
    });
  });

  it('counts markdown files (docs, versioned, translations, posts)', () => {
    // 9 docs + 1 versioned + 2 tr current + 1 tr 1.0.0 + 2 posts + 1 tr post
    expect(bundle.fileCount).toBe(16);
  });

  it('applies number prefixes, front matter id / slug / title / position and index docs', () => {
    expect(doc('docs/01-guides/01-setup.md')).toMatchObject({
      version: '2.0.0',
      locale: 'en',
      dir: '01-guides',
      id: 'setup',
      slug: 'guides/setup',
      title: 'Setup',
      position: 1,
      unlisted: false,
    });
    expect(doc('docs/01-guides/02-advanced.md')).toMatchObject({
      id: 'deep-dive',
      slug: 'guides/deep-dive',
      title: 'Deep Dive',
      sidebarLabel: 'Advanced',
      position: 5,
      frontMatter: { keywords: ['acme', 'advanced'] },
    });
    expect(doc('docs/01-guides/custom.md').slug).toBe('custom-page');
    expect(doc('docs/01-guides/relslug.md')).toMatchObject({
      slug: 'guides/renamed',
      title: 'Renamed',
    });
    expect(doc('docs/reference/index.md')).toMatchObject({ slug: 'reference', title: 'Reference' });
    expect(doc('docs/intro.md')).toMatchObject({
      description: 'Start here.',
      position: 1,
      dir: '',
    });
    // Unpositioned items follow the positioned ones alphabetically.
    expect(doc('docs/01-guides/custom.md').position).toBe(6);
    expect(doc('docs/01-guides/relslug.md').position).toBe(7);
  });

  it('imports _-prefixed and draft docs as unlisted, outside the URL list', () => {
    expect(doc('docs/_partials/snippet.md')).toMatchObject({
      unlisted: true,
      slug: 'partials/snippet',
    });
    expect(doc('docs/draft.md')).toMatchObject({ unlisted: true, title: 'Draft' });
    expect(bundle.urls.some((u) => u.includes('snippet') || u.includes('draft'))).toBe(false);
  });

  it('reads categories with generated index, index-doc links and tr labels', () => {
    const cat = (locale: string, dir: string) =>
      bundle.categories.find((c) => c.version === '2.0.0' && c.locale === locale && c.dir === dir);
    expect(cat('en', '01-guides')).toMatchObject({
      parentDir: '',
      slug: 'guides',
      label: 'Guides',
      position: 2,
      description: 'All the guides.',
      link: 'generated-index',
      linkSlug: 'category/guides',
      collapsed: null,
    });
    expect(cat('tr', '01-guides')).toMatchObject({
      label: 'Kılavuzlar',
      description: 'Tüm kılavuzlar.',
      linkSlug: 'category/guides',
    });
    expect(cat('en', 'reference')).toMatchObject({
      label: 'reference',
      link: 'doc',
      linkSlug: 'reference',
    });
    expect(cat('tr', 'reference')?.label).toBe('Başvuru');
    expect(cat('en', '_partials')).toMatchObject({
      unlisted: true,
      slug: 'partials',
      link: 'none',
    });
  });

  it('reads translations and flags the ones identical to the source', () => {
    const tr = bundle.docs.filter((d) => d.locale === 'tr');
    expect(tr.map((d) => d.sourcePath).sort()).toEqual([
      'i18n/tr/docusaurus-plugin-content-docs/current/01-guides/01-setup.md',
      'i18n/tr/docusaurus-plugin-content-docs/current/intro.md',
      'i18n/tr/docusaurus-plugin-content-docs/version-1.0.0/intro.md',
    ]);
    expect(
      doc('i18n/tr/docusaurus-plugin-content-docs/current/01-guides/01-setup.md').sameAsSource,
    ).toBe(true);
    expect(doc('i18n/tr/docusaurus-plugin-content-docs/current/intro.md')).toMatchObject({
      title: 'Giriş',
      sameAsSource: false,
      description: 'Buradan başlayın.',
    });
    expect(doc('i18n/tr/docusaurus-plugin-content-docs/version-1.0.0/intro.md')).toMatchObject({
      version: '1.0.0',
      title: 'Eski Giriş',
    });
    expect(entries('translation')).toEqual([
      {
        type: 'translation',
        source: 'i18n/tr/docusaurus-plugin-content-docs/current/01-guides/01-setup.md',
        action: 'İçerik İngilizceyle aynı; "çevrilmedi" işaretlendi',
        target: { kind: 'doc', version: '2.0.0', locale: 'tr', slug: 'guides/setup' },
      },
    ]);
    // A localized version folder of no version is skipped as an old template.
    expect(entries('skipped').map((e) => e.source)).toContain(
      'i18n/tr/docusaurus-plugin-content-docs/version-0.9.0/intro.md',
    );
  });
});

describe('fixture site: markdown', () => {
  it('rewrites images, doc links and removes broken links', () => {
    const md = doc('docs/intro.md').markdown;
    expect(md).toContain('![Sitemap](/media/docs/_img/a.png)');
    expect(md).toContain('[setup guide](/docs/2.0.0/guides/setup#install)');
    expect(md).toContain('[deep dive](/docs/2.0.0/guides/deep-dive)');
    expect(md).toContain('[API](/docs/2.0.0/reference/api)');
    expect(md).toContain('This link is broken and so is next.');
    expect(md).toContain('![Logo](/media/img/logo.svg)');
    expect(md).toContain('![Badge](https://img.shields.io/badge/a-b-blue.svg)');
    expect(md).not.toMatch(/^---/);
    const links = entries('link').filter((e) => e.source === 'docs/intro.md');
    expect(links.map((e) => e.action)).toEqual([
      'Hedef yok (./missing.md); link kaldırıldı, metin korundu',
      'Hedef yok (/docs/next/intro); link kaldırıldı, metin korundu',
    ]);
    expect(entries('image').map((e) => e.source)).toEqual(['docs/intro.md']);
  });

  it('keeps admonitions, Tabs, code titles and mermaid', () => {
    const md = doc('docs/01-guides/01-setup.md').markdown;
    expect(md).toContain("import Tabs from '@theme/Tabs';");
    expect(md).toContain(':::tip[Before you start]');
    expect(md).toContain('<TabItem value="npm" label="npm">');
    expect(md).toContain('```bash title="terminal"');
    expect(md).toContain('```mermaid');
    expect(md).toContain('![Screenshot](/media/docs/01-guides/img/shot.png)');
    expect(md).toContain('[intro](/docs/2.0.0/intro)');
  });

  it('resolves relative URL links and reports MDX components', () => {
    const md = doc('docs/01-guides/02-advanced.md').markdown;
    expect(md).toContain('[setup](/docs/2.0.0/guides/setup)');
    expect(md).toContain('[the reference page](/docs/2.0.0/reference/api)');
    expect(entries('mdx').map((e) => e.action)).toEqual([
      "MDX import kaldırıldı (import Chart from '@site/src/components/Chart';); kullanılan bileşeni kontrol et",
      '<Chart> bileşeni desteklenmiyor; ham HTML olarak korundu, kontrol et',
    ]);
  });

  it('points translated links at the localized URLs and falls back to source images', () => {
    const md = doc('i18n/tr/docusaurus-plugin-content-docs/current/intro.md').markdown;
    expect(md).toContain('[Kurulum](/tr/docs/2.0.0/guides/setup)');
    expect(md).toContain('[ileri konular](/tr/docs/2.0.0/guides/deep-dive)');
    expect(md).toContain('![Site haritası](/media/docs/_img/a.png)');
  });

  it('leaves no relative references in any markdown', () => {
    for (const item of [...bundle.docs, ...bundle.posts]) {
      const refs = references(markdownToDoc(item.markdown).doc);
      expect(refs.filter((r) => /^\.{1,2}\//.test(r.url))).toEqual([]);
    }
  });
});

describe('fixture site: blog', () => {
  it('reads posts with slugs, dates, authors, tags, cover and truncate', () => {
    const hello = bundle.posts.find((p) => p.locale === 'en' && p.slug === 'hello');
    expect(hello).toMatchObject({
      sourcePath: 'blog/2024-01-15-hello/index.md',
      title: 'Hello World',
      description: 'The first post.',
      date: '2024-01-15T00:00:00.000Z',
      authorKeys: ['jane'],
      tags: ['Getting Started', 'news'],
      cover: '/media/blog/2024-01-15-hello/cover.png',
      frontMatter: {},
    });
    expect(hello?.markdown).toContain('<!-- truncate -->');
    expect(hello?.markdown).toContain('[second post](/blog/2024/02/01/second)');
    const second = bundle.posts.find((p) => p.sourcePath === 'blog/2024-02-01-second.md');
    expect(second).toMatchObject({
      slug: '2024/02/01/second',
      title: 'Second Post',
      date: '2024-02-01T00:00:00.000Z',
      authorKeys: ['guest-writer'],
      tags: ['news'],
    });
    const tr = bundle.posts.find((p) => p.locale === 'tr');
    expect(tr).toMatchObject({ slug: 'hello', title: 'Merhaba Dünya' });
  });

  it('reads authors.yml and synthesizes inline authors', () => {
    expect(bundle.authors).toEqual([
      {
        key: 'jane',
        name: 'Jane Doe',
        title: 'Engineer',
        url: 'https://github.com/jane',
        imageUrl: '/media/img/logo.svg',
      },
      { key: 'guest-writer', name: 'Guest Writer', title: 'Guest', url: null, imageUrl: null },
    ]);
  });
});

describe('fixture site: media, site, navigation, home', () => {
  it('lists media with public paths and skips code files', () => {
    expect(bundle.media.map((m) => [m.path, m.mime])).toEqual([
      ['/media/blog/2024-01-15-hello/cover.png', 'image/png'],
      ['/media/docs/01-guides/img/shot.png', 'image/png'],
      ['/media/docs/_img/a.png', 'image/png'],
      ['/media/img/favicon.ico', 'image/x-icon'],
      ['/media/img/logo.svg', 'image/svg+xml'],
      ['/media/img/social.png', 'image/png'],
    ]);
    expect(bundle.media.every((m) => m.size > 0 && path.isAbsolute(m.file))).toBe(true);
    const skipped = entries('skipped').map((e) => e.source);
    expect(skipped).toContain('docs/01-guides/example.ts');
    expect(skipped).toContain('static/js/extra.js');
    expect(entries('skipped').find((e) => e.source === 'src/pages/about.md')?.action).toBe(
      'src/pages sayfası (/about); ana sayfaya 301 yönlendirmesi eklenecek',
    );
  });

  it('reads site settings from the config AST', () => {
    expect(bundle.site.settings).toEqual({
      title: 'Acme Docs',
      tagline: 'Docs for Acme',
      url: 'https://docs.acme.test',
      favicon: '/media/img/favicon.ico',
      socialImage: '/media/img/social.png',
      logo: { src: '/media/img/logo.svg', srcDark: null, alt: 'Acme Logo' },
      prism: { light: 'github', dark: 'dracula' },
    });
    expect(entries('setting').find((e) => e.source.endsWith('docs.editUrl'))?.action).toBe(
      'Şablon deposuna gidiyordu; "Bu sayfayı düzenle" linki kapatıldı',
    );
  });

  it('maps navbar and footer with tr labels and {year}', () => {
    const nav = bundle.navigation;
    expect(PortalNavigation.safeParse(nav).success).toBe(true);
    expect(nav?.navbar.title).toEqual({ en: 'Acme', tr: 'Acme' });
    expect(nav?.navbar.items.map((i) => [i.kind, i.position, i.label, i.href ?? null])).toEqual([
      ['docs', 'left', { en: 'Docs', tr: 'Dokümanlar' }, null],
      ['blog', 'left', { en: 'Blog', tr: 'Blog' }, null],
      ['localeDropdown', 'right', {}, null],
      ['versionDropdown', 'right', {}, null],
      ['link', 'right', { en: 'GitHub' }, 'https://github.com/acme'],
    ]);
    expect(nav?.footer.columns).toEqual([
      {
        id: 'docs',
        title: { en: 'Docs', tr: 'Dokümanlar' },
        items: [{ id: 'intro', label: { en: 'Intro', tr: 'Giriş' }, href: '/docs/2.0.0/intro' }],
      },
      {
        id: 'more',
        title: { en: 'More', tr: 'Daha fazla' },
        items: [
          { id: 'blog', label: { en: 'Blog' }, href: '/blog' },
          { id: 'github', label: { en: 'GitHub' }, href: 'https://github.com/acme' },
        ],
      },
    ]);
    expect(nav?.footer.copyright).toEqual({
      en: 'Copyright © {year} Acme',
      tr: 'Telif © 2023 Acme',
    });
  });

  it('maps homepageContent.json to home sections', () => {
    const home = bundle.home;
    expect(PortalHome.safeParse(home).success).toBe(true);
    expect(home?.sections.map((s) => s.type)).toEqual([
      'hero',
      'about',
      'video',
      'features',
      'technologies',
      'community',
      'projects',
    ]);
    const [hero, , video, features, techs, community, projects] = home?.sections ?? [];
    expect(hero?.badge).toEqual({ en: 'Version {version}', tr: 'Versiyon {version}' });
    expect(video?.videoId).toBe('abcDEF12345');
    expect(features).toMatchObject({
      items: { en: ['Fast', 'Small'], tr: ['Hızlı', 'Küçük'] },
      image: '/media/img/logo.svg',
    });
    expect(techs?.images).toEqual(['/media/img/social.png']);
    expect(community?.image).toBe('/media/img/social.png');
    expect(projects?.projects?.[0]).toEqual({
      name: 'acme-lib',
      image: '/media/img/logo.svg',
      url: 'https://github.com/acme/lib',
      description: { en: 'A library.' },
      badges: [
        {
          url: 'https://github.com/acme/lib/blob/main/LICENSE',
          image: 'https://img.shields.io/badge/license-MIT-blue.svg',
          alt: 'License',
        },
      ],
    });
    expect(entries('home').map((e) => e.source)).toEqual([
      'src/pages/homepageContent.json › hero.en.version',
      'src/pages/homepageContent.json › hero.tr.version',
      'src/pages/homepageContent.json › techs.floatingImages[1]',
    ]);
  });
});

describe('fixture site: URLs', () => {
  it('lists every page Docusaurus serves, untranslated tr pages included', () => {
    const en = [
      '/',
      '/blog',
      '/blog/2024/02/01/second',
      '/blog/archive',
      '/blog/authors',
      '/blog/hello',
      '/blog/tags',
      '/blog/tags/getting-started',
      '/blog/tags/news',
      '/docs/1.0.0/intro',
      '/docs/2.0.0/category/guides',
      '/docs/2.0.0/custom-page',
      '/docs/2.0.0/guides/deep-dive',
      '/docs/2.0.0/guides/renamed',
      '/docs/2.0.0/guides/setup',
      '/docs/2.0.0/intro',
      '/docs/2.0.0/reference',
      '/docs/2.0.0/reference/api',
      '/search',
    ];
    const tr = en.map((u) => (u === '/' ? '/tr' : `/tr${u}`));
    expect(bundle.urls).toEqual([...en, ...tr].sort());
  });

  it('compares with old URLs ignoring domain and trailing slash', () => {
    expect(
      compareUrls(bundle.urls, ['https://docs.acme.test/tr/', '/docs/2.0.0/intro/', '/gone']),
    ).toEqual({
      matched: 2,
      missing: ['/gone'],
      extra: bundle.urls.filter((u) => u !== '/tr' && u !== '/docs/2.0.0/intro'),
    });
    const summary = bundle.entries.find((e) => e.source === 'sitemap');
    expect(summary?.action).toBe('1 / 2 URL aynı; 1 adres için yönlendirme gerekir: /old-page');
  });
});
