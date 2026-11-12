// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/html-markdown/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from './logic';

describe('html-markdown', () => {
  it('converts headings and emphasis', () => {
    expect(htmlToMarkdown('<h1>Hello</h1>')).toBe('# Hello');
    expect(htmlToMarkdown('<p>a <strong>b</strong> <em>c</em></p>')).toBe('a **b** *c*');
  });

  it('converts lists', () => {
    const md = htmlToMarkdown('<ul><li>one</li><li>two</li></ul>');
    expect(md).toMatch(/^-\s+one$/m);
    expect(md).toMatch(/^-\s+two$/m);
  });

  it('converts links', () => {
    expect(htmlToMarkdown('<a href="https://x.com">x</a>')).toBe('[x](https://x.com)');
  });

  it('returns an empty string for empty or whitespace-only input', () => {
    expect(htmlToMarkdown('')).toBe('');
    expect(htmlToMarkdown('   ')).toBe('');
  });

  it('converts fenced code blocks', () => {
    expect(htmlToMarkdown('<pre><code>const a = 1;</code></pre>')).toBe('```\nconst a = 1;\n```');
  });

  it('converts blockquotes and images', () => {
    expect(htmlToMarkdown('<blockquote>quote</blockquote>')).toBe('> quote');
    expect(htmlToMarkdown('<img src="a.png" alt="alt text">')).toBe('![alt text](a.png)');
  });

  it('decodes HTML entities', () => {
    expect(htmlToMarkdown('<p>&amp; &lt; &gt; &copy;</p>')).toBe('& < > ©');
  });

  it('passes plain text through unchanged', () => {
    expect(htmlToMarkdown('not even html just text')).toBe('not even html just text');
  });
});
