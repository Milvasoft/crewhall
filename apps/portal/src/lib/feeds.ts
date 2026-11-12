import type { PortalPublicPostSummary } from '@crewhall/shared';
import { firstParagraphText, markdownToDoc } from '@crewhall/editor';
import { cdata, escapeXml } from '@/lib/xml';

export interface FeedInput {
  /** Site base URL without trailing slash. */
  baseUrl: string;
  /** Blog URL, e.g. https://portal.example.com/blog or …/tr/blog */
  blogUrl: string;
  title: string;
  language: string;
  favicon: string | null;
  posts: PortalPublicPostSummary[];
}

const postUrl = (input: FeedInput, slug: string) => `${input.blogUrl}/${encodeURIComponent(slug)}`;

export function postDescription(post: PortalPublicPostSummary): string {
  if (post.description) return post.description;
  return firstParagraphText(markdownToDoc(post.excerpt).doc, 400) ?? '';
}

const latest = (posts: PortalPublicPostSummary[]) =>
  posts.reduce<string | null>((max, p) => (!max || p.date > max ? p.date : max), null) ??
  new Date(0).toISOString();

/** RSS 2.0, the shape Docusaurus (jpmonette/feed) produces at /blog/rss.xml. */
export function buildRss(input: FeedInput): string {
  const items = input.posts.map((p) => {
    const url = postUrl(input, p.slug);
    return [
      '        <item>',
      `            <title>${cdata(p.title)}</title>`,
      `            <link>${escapeXml(url)}</link>`,
      `            <guid>${escapeXml(url)}</guid>`,
      `            <pubDate>${new Date(p.date).toUTCString()}</pubDate>`,
      `            <description>${cdata(postDescription(p))}</description>`,
      ...p.tags.map((t) => `            <category>${escapeXml(t)}</category>`),
      '        </item>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">',
    '    <channel>',
    `        <title>${escapeXml(input.title)}</title>`,
    `        <link>${escapeXml(input.blogUrl)}</link>`,
    `        <description>${escapeXml(input.title)}</description>`,
    `        <lastBuildDate>${new Date(latest(input.posts)).toUTCString()}</lastBuildDate>`,
    '        <docs>https://validator.w3.org/feed/docs/rss2.html</docs>',
    '        <generator>https://github.com/jpmonette/feed</generator>',
    `        <language>${escapeXml(input.language)}</language>`,
    ...items,
    '    </channel>',
    '</rss>',
  ].join('\n');
}

/** Atom 1.0, as Docusaurus' /blog/atom.xml. */
export function buildAtom(input: FeedInput): string {
  const entries = input.posts.map((p) => {
    const url = postUrl(input, p.slug);
    return [
      '    <entry>',
      `        <title type="html">${cdata(p.title)}</title>`,
      `        <id>${escapeXml(url)}</id>`,
      `        <link href="${escapeXml(url)}"/>`,
      `        <updated>${escapeXml(new Date(p.date).toISOString())}</updated>`,
      `        <summary type="html">${cdata(postDescription(p))}</summary>`,
      ...p.authors.map((a) =>
        [
          '        <author>',
          `            <name>${escapeXml(a.name)}</name>`,
          ...(a.url ? [`            <uri>${escapeXml(a.url)}</uri>`] : []),
          '        </author>',
        ].join('\n'),
      ),
      ...p.tags.map((t) => `        <category label="${escapeXml(t)}" term="${escapeXml(t)}"/>`),
      '    </entry>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `    <id>${escapeXml(input.blogUrl)}</id>`,
    `    <title>${escapeXml(input.title)}</title>`,
    `    <updated>${escapeXml(new Date(latest(input.posts)).toISOString())}</updated>`,
    '    <generator>https://github.com/jpmonette/feed</generator>',
    `    <link rel="alternate" href="${escapeXml(input.blogUrl)}"/>`,
    `    <subtitle>${escapeXml(input.title)}</subtitle>`,
    ...(input.favicon ? [`    <icon>${escapeXml(input.favicon)}</icon>`] : []),
    ...entries,
    '</feed>',
  ].join('\n');
}
