import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { en } from '@/i18n/en';
import { renderMarkdown } from '@/render/Markdown';
import { sanitizeHtml } from '@/render/sanitize';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _p,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    prefetch?: boolean;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const html = (markdown: string, extractTitle = false) => {
  const r = renderMarkdown(markdown, en, extractTitle);
  return { ...r, html: renderToStaticMarkup(<>{r.content}</>) };
};

describe('markdown renderer', () => {
  it('renders admonitions with Infima classes, icon and label or custom title', () => {
    const out = html(
      ':::tip\nHello\n:::\n\n:::warning Note\nCareful\n:::\n\n:::danger[Stop]\nNo\n:::',
    );
    expect(out.html).toContain(
      'class="theme-admonition theme-admonition-tip admonition_xJq3 alert alert--success"',
    );
    expect(out.html).toContain(
      '<div class="admonitionHeading_Gvgb"><span class="admonitionIcon_Rf37"><svg viewBox="0 0 12 16">',
    );
    expect(out.html).toMatch(/admonitionIcon_Rf37"><svg[^]*?<\/svg><\/span>tip<\/div>/);
    expect(out.html).toContain('alert--warning');
    expect(out.html).toMatch(/<\/span>Note<\/div>/);
    expect(out.html).toContain('theme-admonition-danger');
    expect(out.html).toMatch(/<\/span>Stop<\/div>/);
    expect(out.html).toContain('<div class="admonitionContent_BuS1"><p>Hello</p></div>');
  });

  it('renders headings with Docusaurus ids and hash links, and a nested TOC', () => {
    const out = html(
      '# Title\n\n## Getting Started\n\n### Install it\n\n## Getting Started\n\n## Custom {#my-id}',
      true,
    );
    expect(out.title).toBe('Title');
    expect(out.html).not.toContain('<h1');
    expect(out.html).toContain(
      '<h2 class="anchor anchorTargetStickyNavbar_Vzrq" id="getting-started">Getting Started<a href="#getting-started" class="hash-link" aria-label="Direct link to Getting Started"',
    );
    expect(out.html).toContain('id="getting-started-1"');
    expect(out.html).toContain('id="my-id"');
    expect(out.toc.map((t) => t.id)).toEqual(['getting-started', 'getting-started-1', 'my-id']);
    expect(out.toc[0]?.children.map((t) => t.id)).toEqual(['install-it']);
  });

  it('renders code blocks with language, title, highlighted lines and copy button', () => {
    const out = html(
      '```csharp title="Program.cs" {2} showLineNumbers\nvar a = 1;\npublic class Foo {}\n```',
    );
    expect(out.html).toContain('class="language-csharp codeBlockContainer_Ckt0 theme-code-block"');
    expect(out.html).toContain('<div class="codeBlockTitle_OeMC">Program.cs</div>');
    expect(out.html).toContain('class="prism-code language-csharp codeBlock_bY9V thin-scrollbar"');
    expect(out.html).toContain('codeBlockLinesWithNumbering_o6Pm');
    expect(out.html).toContain('token-line codeLine_lJS_ theme-code-block-highlighted-line');
    expect(out.html).toContain('<span class="token keyword">public</span>');
    expect(out.html).toContain('class="buttonGroup_M5ko"');
  });

  it('highlights bash and keeps unknown languages as plain text', () => {
    expect(html('```bash\ndocker --version\n```').html).toContain(
      '<span class="token function">docker</span>',
    );
    expect(html('```nope\n<b>x</b>\n```').html).toContain(
      '<span class="token plain">&lt;b&gt;x&lt;/b&gt;</span>',
    );
  });

  it('renders Tabs with Infima classes and the default tab selected', () => {
    const md = [
      '<Tabs groupId="os">',
      '<TabItem value="win" label="Windows">',
      '',
      'Windows text',
      '',
      '</TabItem>',
      '<TabItem value="mac" label="macOS" default>',
      '',
      'Mac text',
      '',
      '</TabItem>',
      '</Tabs>',
    ].join('\n');
    const out = html(md);
    expect(out.html).toContain('class="tabs-container tabList__CuJ"');
    expect(out.html).toContain('<ul role="tablist" aria-orientation="horizontal" class="tabs">');
    expect(out.html).toMatch(
      /aria-selected="true" class="tabs__item tabItem_LNqP tabs__item--active">macOS</,
    );
    expect(out.html).toMatch(/<div role="tabpanel" class="tabItem_Ymn6" hidden="">.*Windows text/);
    expect(out.html).toMatch(/<div role="tabpanel" class="tabItem_Ymn6"><p>Mac text/);
  });

  it('renders images lazily, tables, task lists and links', () => {
    const out = html(
      '![Alt](/media/img/a.png)\n\n| A | B |\n|:-:|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n[in](/docs/1.0.1/x) [out](https://example.com)',
    );
    expect(out.html).toContain(
      '<img decoding="async" loading="lazy" alt="Alt" src="/media/img/a.png" class="img_ev3q"/>',
    );
    expect(out.html).toContain('<th style="text-align:center">A</th>');
    expect(out.html).toContain('class="contains-task-list containsTaskList_mC6p"');
    expect(out.html).toContain('<a href="/docs/1.0.1/x">in</a>');
    expect(out.html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">out</a>',
    );
  });

  it('renders nothing for the truncate marker and keeps raw HTML safe', () => {
    const out = html(
      'Intro\n\n<!-- truncate -->\n\n<div><script>alert(1)</script><img src="x.png" onerror="alert(2)" alt="x"><b>bold</b></div>\n\nText <Highlight color="red">kept</Highlight> and <kbd>Ctrl</kbd>',
    );
    expect(out.html).not.toContain('truncate');
    expect(out.html).not.toContain('script');
    expect(out.html).not.toContain('alert');
    expect(out.html).not.toContain('onerror');
    expect(out.html).toContain('<b>bold</b>');
    expect(out.html).toContain('kept');
    expect(out.html).not.toContain('Highlight');
    expect(out.html).toContain('<kbd>Ctrl</kbd>');
  });

  it('wraps markdown between <details> HTML blocks', () => {
    const out = html('<details>\n<summary>More</summary>\n\nHidden **text**\n\n</details>');
    expect(out.html).toContain(
      '<details class="details_lb9f alert alert--info details_b_Ee"><summary>More</summary>',
    );
    expect(out.html).toMatch(/collapsibleContent_i85q">.*<strong>text<\/strong>.*<\/details>/);
  });

  it('renders wiki toggles as Docusaurus details', () => {
    const out = html(':::toggle[How it works]\nHidden **text**\n:::\n\n:::toggle\nNo summary\n:::');
    expect(out.html).toContain(
      '<details class="details_lb9f alert alert--info details_b_Ee"><summary>How it works</summary><div><div class="collapsibleContent_i85q"><p>Hidden <strong>text</strong></p></div></div></details>',
    );
    expect(out.html).toContain(
      '<summary></summary><div><div class="collapsibleContent_i85q"><p>No summary</p>',
    );
    expect(out.html).not.toContain(' open');
  });

  it('renders mentions as plain text and drops embeds', () => {
    const out = html(
      'By [@Ali Veli](mention:user:u1) on **[@20 Oct](mention:date:2026-10-20)**, see [@Plan](mention:node:n1) and <kbd>K</kbd>.\n\n::embed{node="f1" type="file"}\n\nAfter',
    );
    expect(out.html).toContain(
      '<p>By Ali Veli on <strong>20 Oct</strong>, see Plan and <kbd>K</kbd>.</p><p>After</p>',
    );
    expect(out.html).not.toContain('mention');
    expect(out.html).not.toContain('@');
    expect(out.html).not.toContain('f1');
    expect(html('Hi [@Ali](mention:user:u1)').html).toBe('<p>Hi Ali</p>');
  });
});

describe('sanitizeHtml', () => {
  it('drops scripts and event handlers, keeps allowed tags and attributes', () => {
    const nodes = sanitizeHtml(
      '<p onclick="x()">Hi <a href="javascript:alert(1)">bad</a> <a href="https://ok.example">ok</a></p><style>p{}</style><iframe src="x"></iframe><img src="/a.png" onerror="alert(1)" width="10">',
    );
    const json = JSON.stringify(nodes);
    expect(json).not.toContain('onclick');
    expect(json).not.toContain('javascript');
    expect(json).not.toContain('onerror');
    expect(json).not.toContain('iframe');
    expect(json).not.toContain('p{}');
    expect(json).toContain('"href":"https://ok.example"');
    expect(json).toContain('"width":"10"');
  });

  it('keeps the text of unknown tags and decodes entities', () => {
    expect(sanitizeHtml('<Foo bar="1">a &amp; b &#x41;</Foo>')).toEqual([
      { type: 'text', text: 'a & b A' },
    ]);
  });
});
