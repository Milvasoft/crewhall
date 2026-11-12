import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdownToDoc, references } from '@crewhall/editor';
import { PortalHome, PortalNavigation } from '@crewhall/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { compareUrls, parseDocusaurus, type ImportBundle } from '../src';
import { findCorpus } from './helpers';

function markdownBelow(root: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.mdx?$/.test(f)) out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
  return out;
}

const corpus = findCorpus();
const sitemaps = fileURLToPath(new URL('../../../apps/portal/test/fixtures/', import.meta.url));
const readLines = (file: string) =>
  fs
    .readFileSync(path.join(sitemaps, file), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');

describe.skipIf(!corpus)('milva-portal corpus', () => {
  let bundle: ImportBundle;
  beforeAll(async () => {
    bundle = await parseDocusaurus(corpus!);
  });

  it('imports every docs and versioned_docs file (the 164 markdown files + the mdx)', () => {
    const docs = markdownBelow(corpus!, 'docs');
    const versioned = markdownBelow(corpus!, 'versioned_docs');
    expect(docs).toHaveLength(156);
    expect(versioned.filter((f) => f.endsWith('.md'))).toHaveLength(8);
    const imported = new Set(bundle.docs.map((d) => d.sourcePath));
    expect([...docs, ...versioned].filter((f) => !imported.has(f))).toEqual([]);
  });

  it('reads translations, posts, authors and media', () => {
    const count = (version: string, locale: string) =>
      bundle.docs.filter((d) => d.version === version && d.locale === locale).length;
    expect(count('1.0.1', 'en')).toBe(156);
    expect(count('1.0.0', 'en')).toBe(9);
    expect(count('1.0.1', 'tr')).toBe(68);
    expect(count('1.0.0', 'tr')).toBe(1);
    expect(bundle.posts).toHaveLength(16);
    expect(bundle.posts.filter((p) => p.locale === 'tr')).toHaveLength(8);
    expect(bundle.authors.map((a) => a.key).sort()).toEqual(['aliburhankeskin', 'bugrakosen']);
    expect(bundle.media.length).toBeGreaterThan(60);
    expect(bundle.fileCount).toBe(156 + 9 + 69 + 16);
    expect(PortalHome.safeParse(bundle.home).success).toBe(true);
    expect(PortalNavigation.safeParse(bundle.navigation).success).toBe(true);
    // The old template intro of a version that does not exist is skipped.
    expect(
      bundle.entries.some(
        (e) =>
          e.type === 'skipped' &&
          e.source === 'i18n/tr/docusaurus-plugin-content-docs/version-1.0.1/intro.md',
      ),
    ).toBe(true);
  });

  it('serves the same URLs as the live Docusaurus sitemap', () => {
    const old = [...readLines('old-sitemap-en.txt'), ...readLines('old-sitemap-tr.txt')];
    const result = compareUrls(bundle.urls, old);
    expect(result.missing).toEqual(['/markdown-page', '/tr/markdown-page']);
    expect(result.extra).toEqual([]);
    expect(result.matched).toBe(old.length - 2);
    expect(
      bundle.entries.find((e) => e.type === 'skipped' && e.source === 'src/pages/markdown-page.md'),
    ).toBeTruthy();

    const byType: Record<string, number> = {};
    for (const e of bundle.entries) byType[e.type] = (byType[e.type] ?? 0) + 1;
    const docs: Record<string, number> = {};
    for (const d of bundle.docs)
      docs[`${d.version}/${d.locale}`] = (docs[`${d.version}/${d.locale}`] ?? 0) + 1;
    console.log(
      JSON.stringify(
        {
          source: bundle.source,
          files: bundle.fileCount,
          docs,
          categories: bundle.categories.length,
          posts: bundle.posts.length,
          authors: bundle.authors.length,
          media: bundle.media.length,
          mediaBytes: bundle.media.reduce((n, m) => n + m.size, 0),
          entries: byType,
          urls: { generated: bundle.urls.length, old: old.length, ...result },
        },
        null,
        2,
      ),
    );
  });

  it('produces markdown that parses and has no relative references left', () => {
    const left: string[] = [];
    for (const item of [...bundle.docs, ...bundle.posts]) {
      const parsed = markdownToDoc(item.markdown);
      for (const ref of references(parsed.doc)) {
        if (/^\.{1,2}\//.test(ref.url)) left.push(`${item.sourcePath}: ${ref.url}`);
      }
      expect(item.markdown).not.toMatch(/require\(['"]\.\.?\//);
    }
    expect(left).toEqual([]);
  });
});
