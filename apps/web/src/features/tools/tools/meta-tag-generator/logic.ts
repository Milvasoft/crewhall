// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/meta-tag-generator/logic.ts. See THIRD_PARTY.md.
/**
 * Generate SEO / OpenGraph / Twitter meta tags from a small set of fields.
 * Pure and local.
 */

export interface MetaInput {
  title?: string;
  description?: string;
  url?: string;
  image?: string;
  siteName?: string;
  type?: string;
  twitterCard?: string;
  twitterSite?: string;
  themeColor?: string;
  keywords?: string;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function generateMetaTags(m: MetaInput): string {
  const lines: string[] = [];
  const name = (n: string, c?: string) =>
    c && lines.push(`<meta name="${n}" content="${esc(c)}" />`);
  const prop = (p: string, c?: string) =>
    c && lines.push(`<meta property="${p}" content="${esc(c)}" />`);

  if (m.title) lines.push(`<title>${esc(m.title)}</title>`);
  name('description', m.description);
  name('keywords', m.keywords);
  name('theme-color', m.themeColor);

  // OpenGraph
  prop('og:title', m.title);
  prop('og:description', m.description);
  prop('og:type', m.type || (m.title ? 'website' : undefined));
  prop('og:url', m.url);
  prop('og:image', m.image);
  prop('og:site_name', m.siteName);

  // Twitter
  name('twitter:card', m.twitterCard || (m.image ? 'summary_large_image' : undefined));
  name('twitter:site', m.twitterSite);
  name('twitter:title', m.title);
  name('twitter:description', m.description);
  name('twitter:image', m.image);

  return lines.join('\n');
}
