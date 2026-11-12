import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { internalPathOf, localePath, resolveRoute, type Route } from '@/lib/route';

const LOCALES = ['en', 'tr'];
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** Old site URLs that only exist as Hub-managed redirects. */
const REDIRECTED = new Set(['/markdown-page', '/tr/markdown-page']);

function rewrite(path: string) {
  const r = resolveRoute(path, LOCALES, 'en');
  if (r.action !== 'rewrite') throw new Error(`${path} → ${r.action}`);
  return r;
}

describe('resolveRoute', () => {
  it('serves the default locale without a prefix', () => {
    expect(rewrite('/')).toMatchObject({
      locale: 'en',
      internalPath: '/en',
      route: { kind: 'home' },
    });
    expect(rewrite('/docs/1.0.1/welcome')).toMatchObject({
      locale: 'en',
      internalPath: '/en/docs/1.0.1/welcome',
      route: { kind: 'doc', version: '1.0.1', slug: 'welcome' },
    });
  });

  it('routes prefixed locales', () => {
    expect(rewrite('/tr')).toMatchObject({
      locale: 'tr',
      internalPath: '/tr',
      route: { kind: 'home' },
    });
    expect(rewrite('/tr/docs/1.0.1/open-source-libs/milvaion/quick-start')).toMatchObject({
      locale: 'tr',
      route: { kind: 'doc', version: '1.0.1', slug: 'open-source-libs/milvaion/quick-start' },
    });
    expect(rewrite('/tr/blog/tags/dotnet')).toMatchObject({
      locale: 'tr',
      route: { kind: 'blogTag', tag: 'dotnet', page: 1 },
    });
  });

  it('redirects the default locale prefix to the unprefixed URL', () => {
    expect(resolveRoute('/en/docs/1.0.1/welcome', LOCALES, 'en')).toEqual({
      action: 'redirect',
      location: '/docs/1.0.1/welcome',
      status: 301,
    });
    expect(resolveRoute('/en', LOCALES, 'en')).toEqual({
      action: 'redirect',
      location: '/',
      status: 301,
    });
  });

  it('does not take unknown two-letter segments for locales', () => {
    expect(rewrite('/de/docs/x')).toMatchObject({
      locale: 'en',
      route: { kind: 'other', path: '/de/docs/x' },
    });
  });

  it('treats locale-like segments as locales when the locale list is unknown', () => {
    expect(resolveRoute('/tr/blog', null, 'en')).toMatchObject({
      action: 'rewrite',
      locale: 'tr',
      route: { kind: 'blog' },
    });
  });

  it('maps every Docusaurus URL kind', () => {
    const cases: [string, Route][] = [
      ['/docs', { kind: 'docsRoot' }],
      ['/docs/1.0.0', { kind: 'docsVersionRoot', version: '1.0.0' }],
      ['/docs/next/welcome', { kind: 'doc', version: 'next', slug: 'welcome' }],
      [
        '/docs/1.0.1/category/milvaion-scheduler',
        { kind: 'category', version: '1.0.1', category: 'milvaion-scheduler' },
      ],
      ['/blog', { kind: 'blog', page: 1 }],
      ['/blog/page/2', { kind: 'blog', page: 2 }],
      ['/blog/milvaion-mcp-server', { kind: 'blogPost', slug: 'milvaion-mcp-server' }],
      ['/blog/tags', { kind: 'blogTags' }],
      ['/blog/tags/dotnet/page/3', { kind: 'blogTag', tag: 'dotnet', page: 3 }],
      ['/blog/archive', { kind: 'blogArchive' }],
      ['/blog/authors', { kind: 'blogAuthors' }],
      ['/blog/authors/bugrakosen', { kind: 'blogAuthor', key: 'bugrakosen', page: 1 }],
      ['/blog/rss.xml', { kind: 'rss' }],
      ['/blog/atom.xml', { kind: 'atom' }],
      ['/sitemap.xml', { kind: 'sitemap' }],
      ['/search', { kind: 'search' }],
      ['/docs/welcome', { kind: 'other', path: '/docs/welcome' }],
      ['/markdown-page', { kind: 'other', path: '/markdown-page' }],
    ];
    for (const [path, route] of cases) expect(rewrite(path).route, path).toEqual(route);
  });

  it('passes API, media and assets through', () => {
    for (const p of [
      '/api/revalidate',
      '/media/img/logo.svg',
      '/img/logo.svg',
      '/_next/static/x.js',
      '/favicon.ico',
      '/robots.txt',
    ]) {
      expect(resolveRoute(p, LOCALES, 'en'), p).toEqual({ action: 'pass' });
    }
  });

  it('redirects /blog/page/1 to /blog', () => {
    expect(resolveRoute('/tr/blog/page/1', LOCALES, 'en')).toEqual({
      action: 'redirect',
      location: '/tr/blog',
      status: 301,
    });
  });

  it('builds locale paths and internal paths', () => {
    expect(localePath('en', 'en', '/blog')).toBe('/blog');
    expect(localePath('tr', 'en', '/')).toBe('/tr');
    expect(localePath('tr', 'en', '/blog')).toBe('/tr/blog');
    expect(internalPathOf('/tr/docs/1.0.1/welcome', LOCALES, 'en')).toBe('/tr/docs/1.0.1/welcome');
    expect(internalPathOf('/docs/1.0.1/welcome?x=1', LOCALES, 'en')).toBe('/en/docs/1.0.1/welcome');
  });
});

describe('old Docusaurus sitemap URLs', () => {
  for (const [name, locale] of [
    ['old-sitemap-en.txt', 'en'],
    ['old-sitemap-tr.txt', 'tr'],
  ] as const) {
    it(`every URL in ${name} resolves to a page route`, () => {
      const urls = fixture(name);
      expect(urls.length).toBeGreaterThan(150);
      for (const url of urls) {
        const r = rewrite(url);
        expect(r.locale, url).toBe(locale);
        if (REDIRECTED.has(url)) {
          expect(r.route.kind, url).toBe('other');
          continue;
        }
        expect(r.route.kind, url).not.toBe('other');
        // params match the URL
        const rest = locale === 'en' ? url : url.replace(/^\/tr/, '') || '/';
        if (r.route.kind === 'doc') expect(`/docs/${r.route.version}/${r.route.slug}`).toBe(rest);
        if (r.route.kind === 'category') {
          expect(`/docs/${r.route.version}/category/${r.route.category}`).toBe(rest);
        }
        if (r.route.kind === 'blogPost') expect(`/blog/${r.route.slug}`).toBe(rest);
        if (r.route.kind === 'blogTag') {
          expect(rest.startsWith(`/blog/tags/${r.route.tag}`)).toBe(true);
        }
        expect(r.internalPath, url).toBe(rest === '/' ? `/${locale}` : `/${locale}${rest}`);
      }
    });
  }
});
