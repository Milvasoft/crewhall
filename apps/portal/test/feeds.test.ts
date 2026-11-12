import type { PortalPublicPath, PortalPublicPostSummary } from '@crewhall/shared';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { buildAtom, buildRss, type FeedInput } from '@/lib/feeds';
import { buildRobots, buildSitemap } from '@/lib/sitemap';

const parser = new new JSDOM('').window.DOMParser();
const parse = (xml: string) => {
  const doc = parser.parseFromString(xml, 'application/xml');
  expect(doc.getElementsByTagName('parsererror').length).toBe(0);
  return doc;
};

const post = (
  slug: string,
  date: string,
  extra: Partial<PortalPublicPostSummary> = {},
): PortalPublicPostSummary => ({
  slug,
  title: `Post ${slug} & <friends>`,
  description: null,
  date,
  contentLocale: 'en',
  authors: [
    { key: 'ak', name: 'Ahmet K', title: 'Dev', url: 'https://example.com/ak', imageUrl: null },
  ],
  tags: ['dotnet', 'job-scheduler'],
  readingMinutes: 5,
  cover: null,
  excerpt: `# Post ${slug}\n\nFirst paragraph of ${slug} with ]]> inside.\n\nSecond.`,
  truncated: true,
  ...extra,
});

const feed: FeedInput = {
  baseUrl: 'https://portal.example.com',
  blogUrl: 'https://portal.example.com/blog',
  title: 'Example Portal Blog',
  language: 'en',
  favicon: 'https://portal.example.com/favicon.ico',
  posts: [
    post('b', '2026-07-20T00:00:00.000Z'),
    post('a', '2026-07-19T00:00:00.000Z', { description: 'Given' }),
  ],
};

describe('feeds', () => {
  it('builds a well-formed RSS 2.0 feed with Docusaurus URLs', () => {
    const doc = parse(buildRss(feed));
    expect(doc.documentElement.getAttribute('version')).toBe('2.0');
    const items = doc.getElementsByTagName('item');
    expect(items.length).toBe(2);
    expect(items[0]?.getElementsByTagName('link')[0]?.textContent).toBe(
      'https://portal.example.com/blog/b',
    );
    expect(items[0]?.getElementsByTagName('title')[0]?.textContent).toBe('Post b & <friends>');
    expect(items[0]?.getElementsByTagName('description')[0]?.textContent).toBe(
      'First paragraph of b with ]]> inside.',
    );
    expect(items[1]?.getElementsByTagName('description')[0]?.textContent).toBe('Given');
    expect(items[0]?.getElementsByTagName('category').length).toBe(2);
    expect(doc.getElementsByTagName('lastBuildDate')[0]?.textContent).toBe(
      'Mon, 20 Jul 2026 00:00:00 GMT',
    );
  });

  it('builds a well-formed Atom feed', () => {
    const doc = parse(buildAtom(feed));
    expect(doc.documentElement.namespaceURI).toBe('http://www.w3.org/2005/Atom');
    const entries = doc.getElementsByTagName('entry');
    expect(entries.length).toBe(2);
    expect(entries[0]?.getElementsByTagName('id')[0]?.textContent).toBe(
      'https://portal.example.com/blog/b',
    );
    expect(entries[0]?.getElementsByTagName('name')[0]?.textContent).toBe('Ahmet K');
  });
});

const path = (
  p: string,
  locale: string,
  alternates: Record<string, string>,
  noindex = false,
): PortalPublicPath => ({
  path: p,
  locale,
  kind: 'doc',
  updatedAt: '2026-10-19T00:00:00.000Z',
  alternates,
  noindex,
});

describe('sitemap', () => {
  const paths = [
    path('/docs/1.0.1/welcome', 'en', { en: '/docs/1.0.1/welcome', tr: '/tr/docs/1.0.1/welcome' }),
    path('/tr/docs/1.0.1/welcome', 'tr', {
      en: '/docs/1.0.1/welcome',
      tr: '/tr/docs/1.0.1/welcome',
    }),
    path('/docs/next/welcome', 'en', { en: '/docs/next/welcome' }),
    path('/tr/docs/next/welcome', 'tr', { tr: '/tr/docs/next/welcome' }),
    path('/docs/1.0.1/hidden', 'en', { en: '/docs/1.0.1/hidden' }, true),
  ];

  it('lists the locale pages with hreflang alternates and leaves out next/noindex', () => {
    const xml = buildSitemap({
      baseUrl: 'https://portal.example.com',
      locale: 'en',
      defaultLocale: 'en',
      paths,
    });
    const doc = parse(xml);
    const locs = [...doc.getElementsByTagName('loc')].map((l) => l.textContent);
    expect(locs).toEqual(['https://portal.example.com/docs/1.0.1/welcome']);
    const links = [...doc.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', 'link')].map(
      (l) => [l.getAttribute('hreflang'), l.getAttribute('href')],
    );
    expect(links).toEqual([
      ['en', 'https://portal.example.com/docs/1.0.1/welcome'],
      ['tr', 'https://portal.example.com/tr/docs/1.0.1/welcome'],
      ['x-default', 'https://portal.example.com/docs/1.0.1/welcome'],
    ]);
    const tr = parse(
      buildSitemap({
        baseUrl: 'https://portal.example.com',
        locale: 'tr',
        defaultLocale: 'en',
        paths,
      }),
    );
    expect([...tr.getElementsByTagName('loc')].map((l) => l.textContent)).toEqual([
      'https://portal.example.com/tr/docs/1.0.1/welcome',
    ]);
  });

  it('robots.txt disallows next docs and lists sitemaps', () => {
    const txt = buildRobots({
      baseUrl: 'https://portal.example.com',
      locales: ['en', 'tr'],
      defaultLocale: 'en',
    });
    expect(txt).toContain('Disallow: /docs/next/');
    expect(txt).toContain('Disallow: /tr/docs/next/');
    expect(txt).toContain('Sitemap: https://portal.example.com/sitemap.xml');
    expect(txt).toContain('Sitemap: https://portal.example.com/tr/sitemap.xml');
  });
});
