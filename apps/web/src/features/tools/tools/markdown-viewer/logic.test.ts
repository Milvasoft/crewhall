// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/markdown-viewer/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { markdownToHtml } from './logic';

describe('markdownToHtml', () => {
  it('renders headings and emphasis', () => {
    const html = markdownToHtml('# Title\n\nSome **bold** text.');
    expect(html).toContain('<h1');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('renders lists', () => {
    const html = markdownToHtml('- a\n- b');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>a</li>');
  });

  it('returns empty string for empty input', () => {
    expect(markdownToHtml('')).toBe('');
  });

  it('returns empty output for whitespace-only input', () => {
    expect(markdownToHtml('   ').trim()).toBe('');
  });

  it('renders GFM tables', () => {
    const html = markdownToHtml('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>a</th>');
  });

  it('renders fenced code blocks with a language class', () => {
    const html = markdownToHtml('```js\nconst a = 1;\n```');
    expect(html).toContain('<pre><code class="language-js">');
  });

  it('renders links with the href intact', () => {
    const html = markdownToHtml('[example](https://example.com)');
    expect(html).toContain('<a href="https://example.com">example</a>');
  });

  // The logic layer intentionally does NOT sanitize (see doc comment); the
  // component is responsible for running the output through DOMPurify. This
  // test locks in that contract so a future change doesn't silently start
  // sanitizing here (which would break raw-HTML passthrough features like GFM
  // tables) or accidentally strip markup expected downstream.
  it("passes inline raw HTML through unsanitized (sanitization is the caller's job)", () => {
    expect(markdownToHtml('<div>x</div>')).toContain('<div>x</div>');
  });
});
