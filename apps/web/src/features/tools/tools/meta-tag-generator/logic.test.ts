// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/meta-tag-generator/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { generateMetaTags } from './logic';

describe('meta-tag-generator', () => {
  it('emits title, description and OpenGraph', () => {
    const out = generateMetaTags({
      title: 'Too Much Tools',
      description: 'Local dev utilities',
      url: 'https://toomuch.tools',
      image: 'https://toomuch.tools/og.png',
    });
    expect(out).toContain('<title>Too Much Tools</title>');
    expect(out).toContain('<meta name="description" content="Local dev utilities" />');
    expect(out).toContain('<meta property="og:title" content="Too Much Tools" />');
    expect(out).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  it('omits empty fields', () => {
    const out = generateMetaTags({ title: 'Only Title' });
    expect(out).not.toContain('description');
    expect(out).not.toContain('og:image');
  });

  it('escapes HTML in values', () => {
    const out = generateMetaTags({ description: 'a "quote" & <tag>' });
    expect(out).toContain('a &quot;quote&quot; &amp; &lt;tag&gt;');
  });

  it('returns nothing for an empty input', () => {
    expect(generateMetaTags({})).toBe('');
  });

  it('omits og:type when there is no title and no explicit type', () => {
    const out = generateMetaTags({ description: 'just a description' });
    expect(out).not.toContain('og:type');
  });

  it('defaults og:type to website only when a title is present', () => {
    const out = generateMetaTags({ title: 'Home' });
    expect(out).toContain('<meta property="og:type" content="website" />');
  });

  it('lets an explicit type override the website default', () => {
    const out = generateMetaTags({ title: 'Article', type: 'article' });
    expect(out).toContain('<meta property="og:type" content="article" />');
    expect(out).not.toContain('content="website"');
  });

  it('omits twitter:card when there is no image and no explicit card', () => {
    const out = generateMetaTags({ title: 'No Image' });
    expect(out).not.toContain('twitter:card');
  });

  it('lets an explicit twitter card override the image default', () => {
    const out = generateMetaTags({
      image: 'https://x.com/og.png',
      twitterCard: 'summary',
    });
    expect(out).toContain('<meta name="twitter:card" content="summary" />');
    expect(out).not.toContain('content="summary_large_image"');
  });

  it('emits siteName, keywords, themeColor and twitterSite', () => {
    const out = generateMetaTags({
      siteName: 'Too Much Tools',
      keywords: 'dev, tools',
      themeColor: '#123456',
      twitterSite: '@toomuchtools',
    });
    expect(out).toContain('<meta property="og:site_name" content="Too Much Tools" />');
    expect(out).toContain('<meta name="keywords" content="dev, tools" />');
    expect(out).toContain('<meta name="theme-color" content="#123456" />');
    expect(out).toContain('<meta name="twitter:site" content="@toomuchtools" />');
  });
});
