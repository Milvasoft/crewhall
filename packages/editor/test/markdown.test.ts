import { describe, expect, it } from 'vitest';
import {
  docToMarkdown,
  headings,
  markdownToDoc,
  plainText,
  readingMinutes,
  references,
  rewriteReferences,
  splitAtTruncate,
  splitFrontMatter,
  toPublicDoc,
  type EditorDoc,
} from '../src';

const roundTrip = (md: string) => docToMarkdown(markdownToDoc(md).doc);

describe('markdown → doc', () => {
  it('reads front matter and strips the BOM', () => {
    const r = markdownToDoc(
      '\uFEFF---\nid: quick-start\ntitle: Quick Start\nsidebar_position: 20\n---\n\n# Quick Start\n',
    );
    expect(r.frontMatter).toEqual({
      id: 'quick-start',
      title: 'Quick Start',
      sidebar_position: 20,
    });
    expect(r.doc.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
  });

  it('turns Docusaurus admonitions into admonition blocks (both title styles)', () => {
    const v2 = markdownToDoc(':::info Light Mode\nAll **dark**.\n:::\n').doc;
    expect(v2.content?.[0]).toMatchObject({
      type: 'admonition',
      attrs: { type: 'info', title: 'Light Mode' },
      content: [{ type: 'paragraph' }],
    });
    const v3 = markdownToDoc(':::tip[Pair `x` with y]\nBody\n:::\n').doc;
    expect(v3.content?.[0]).toMatchObject({
      type: 'admonition',
      attrs: { type: 'tip', title: 'Pair x with y' },
    });
    const plain = markdownToDoc(':::warning\nCareful\n:::').doc;
    expect(plain.content?.[0]).toMatchObject({
      type: 'admonition',
      attrs: { type: 'warning', title: null },
    });
  });

  it('does not treat colons in text as directives', () => {
    const doc = markdownToDoc('Key:value and http://x.io:8080/a').doc;
    const texts = (doc.content?.[0]?.content ?? []).map((n) => n.text).join('');
    expect(texts).toBe('Key:value and http://x.io:8080/a');
  });

  it('keeps code fence language, title and meta; mermaid becomes its own block', () => {
    const doc = markdownToDoc(
      '```js title="docusaurus.config.js" {1-4}\nconst a = 1;\n```\n\n```mermaid\nflowchart LR\n A --> B\n```',
    ).doc;
    expect(doc.content?.[0]).toMatchObject({
      type: 'codeBlock',
      attrs: { language: 'js', title: 'docusaurus.config.js', meta: '{1-4}' },
      content: [{ type: 'text', text: 'const a = 1;' }],
    });
    expect(doc.content?.[1]).toMatchObject({
      type: 'mermaid',
      content: [{ text: 'flowchart LR\n A --> B' }],
    });
  });

  it('parses Docusaurus Tabs written without blank lines', () => {
    const md = [
      "import Tabs from '@theme/Tabs';",
      "import TabItem from '@theme/TabItem';",
      '',
      '<Tabs groupId="os">',
      '  <TabItem value="apple" label="Apple" default>',
      '    This is an **apple**',
      '  </TabItem>',
      '  <TabItem value="orange" label="Orange">',
      '    This is an orange',
      '  </TabItem>',
      '</Tabs>',
    ].join('\n');
    const r = markdownToDoc(md);
    expect(r.warnings).toEqual([]);
    const tabs = r.doc.content?.[0];
    expect(tabs).toMatchObject({ type: 'tabs', attrs: { groupId: 'os' } });
    expect(tabs?.content).toHaveLength(2);
    expect(tabs?.content?.[0]).toMatchObject({
      type: 'tabItem',
      attrs: { value: 'apple', label: 'Apple', default: true },
      content: [{ type: 'paragraph' }],
    });
    expect(tabs?.content?.[1]?.attrs).toMatchObject({ value: 'orange', default: false });
  });

  it('parses tables with alignment and <br> in cells', () => {
    const doc = markdownToDoc('| a | b |\n|:-|-:|\n| x<br/>y | `z` |').doc;
    const table = doc.content?.[0];
    expect(table?.type).toBe('table');
    expect(table?.content?.[0]?.content?.[1]?.attrs?.align).toBe('right');
    expect(table?.content?.[1]?.content?.[0]?.content?.[0]?.content?.map((n) => n.type)).toEqual([
      'text',
      'hardBreak',
      'text',
    ]);
  });

  it('reads task lists, links, images and reference links', () => {
    const doc = markdownToDoc(
      '- [x] done\n- [ ] todo\n\n![Alt](./img/a.png "T") [docs][d]\n\n[d]: /docs/x',
    ).doc;
    expect(doc.content?.[0]).toMatchObject({
      type: 'taskList',
      content: [{ attrs: { checked: true } }, { attrs: { checked: false } }],
    });
    expect(references(doc)).toEqual([
      { kind: 'image', url: './img/a.png' },
      { kind: 'link', url: '/docs/x' },
    ]);
  });

  it('reads empty task items as tasks, not a literal [ ]', () => {
    const empty = { type: 'paragraph' };
    expect(markdownToDoc('## Aksiyonlar\n\n- [ ]\n').doc.content?.[1]).toEqual({
      type: 'taskList',
      content: [{ type: 'taskItem', attrs: { checked: false }, content: [empty] }],
    });
    expect(markdownToDoc('- [x]\n- [ ] todo\n- [X]').doc.content?.[0]).toMatchObject({
      type: 'taskList',
      content: [
        { attrs: { checked: true }, content: [empty] },
        { attrs: { checked: false }, content: [{ content: [{ text: 'todo' }] }] },
        { attrs: { checked: true }, content: [empty] },
      ],
    });
    // An empty task survives a save and reload.
    const doc: EditorDoc = {
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [{ type: 'taskItem', attrs: { checked: false }, content: [empty] }],
        },
      ],
    };
    expect(docToMarkdown(doc)).toBe('- [ ]\n');
    expect(markdownToDoc(docToMarkdown(doc)).doc).toEqual(doc);
    expect(roundTrip('- [x] done\n- [ ]\n  - alt\n- [x]')).toBe(
      '- [x] done\n- [ ]\n  - alt\n- [x]\n',
    );
    // Brackets with other text stay text.
    expect(markdownToDoc('- [a]').doc.content?.[0]?.type).toBe('bulletList');
  });

  it('reports foreign MDX imports and components', () => {
    const r = markdownToDoc(
      'import X from \'./X\';\n\n<Highlight color="#25c2a0">green</Highlight>',
    );
    expect(r.warnings.map((w) => w.type)).toEqual(['mdx-import', 'unsupported-component']);
  });
});

describe('doc → markdown', () => {
  it('writes admonitions, tabs, code titles and truncate in Docusaurus syntax', () => {
    const md = roundTrip(
      ':::note[Heads up]\nText\n:::\n\nIntro\n\n<!-- truncate -->\n\n```ts title="a.ts"\nlet x\n```',
    );
    expect(md).toContain(':::note[Heads up]\nText\n:::');
    expect(md).toContain('<!-- truncate -->');
    expect(md).toContain('```ts title="a.ts"\nlet x\n```');
  });

  it('nests admonitions with longer outer fences', () => {
    const md = roundTrip('::::info Outer\n:::tip Inner\nx\n:::\n::::');
    expect(md).toContain('::::info[Outer]');
    expect(md).toContain(':::tip[Inner]');
    const again = markdownToDoc(md).doc.content?.[0];
    expect(again?.content?.[0]).toMatchObject({ type: 'admonition', attrs: { type: 'tip' } });
  });

  it('round-trips a representative document without changing its model', () => {
    const md = [
      '# Title {#custom}',
      '',
      'Some *em* **strong** ~~del~~ `code` [link](https://x.io "t") and ![i](/media/a.png).',
      '',
      '> quote',
      '',
      '1. one',
      '2. two',
      '   - nested',
      '',
      '| h1 | h2 |',
      '| :- | :-: |',
      '| a | b |',
      '',
      '---',
      '',
      '<Tabs>',
      '<TabItem value="a" label="A">',
      '',
      'Tab A',
      '',
      '</TabItem>',
      '</Tabs>',
      '',
      ':::danger',
      'Stop',
      ':::',
    ].join('\n');
    const first = markdownToDoc(md).doc;
    const again = markdownToDoc(docToMarkdown(first)).doc;
    expect(again).toEqual(first);
  });

  it('adds front matter and Tabs imports when asked', () => {
    const doc = markdownToDoc('<Tabs><TabItem value="a">\n\nx\n\n</TabItem></Tabs>').doc;
    const md = docToMarkdown(doc, {
      frontMatter: { id: 'x', title: 'X' },
      docusaurusImports: true,
    });
    expect(md.startsWith('---\nid: x\ntitle: X\n---\n\nimport Tabs')).toBe(true);
    expect(splitFrontMatter(md).frontMatter).toEqual({ id: 'x', title: 'X' });
  });
});

describe('inspection helpers', () => {
  it('builds Docusaurus heading anchors', () => {
    const doc = markdownToDoc(
      '# Quick Start\n## Step 1: Start the Stack\n## Step 1: Start the Stack\n## Custom {#my-id}',
    ).doc;
    expect(headings(doc).map((h) => h.id)).toEqual([
      'quick-start',
      'step-1-start-the-stack',
      'step-1-start-the-stack-1',
      'my-id',
    ]);
  });

  it('splits at truncate and counts reading time', () => {
    const doc = markdownToDoc(`intro\n\n<!-- truncate -->\n\n${'word '.repeat(450)}`).doc;
    expect(splitAtTruncate(doc).truncated).toBe(true);
    expect(splitAtTruncate(doc).excerpt.content).toHaveLength(1);
    expect(readingMinutes(doc)).toBe(3);
  });

  it('rewrites and removes references', () => {
    const doc = markdownToDoc('[a](./x.md) [b](/gone) ![c](./c.png)').doc;
    const out = rewriteReferences(doc, (r) =>
      r.url === '/gone' ? null : r.url.startsWith('./') ? `/new/${r.url.slice(2)}` : undefined,
    );
    expect(references(out)).toEqual([
      { kind: 'link', url: '/new/x.md' },
      { kind: 'image', url: '/new/c.png' },
    ]);
    expect(docToMarkdown(out)).toContain(' b ');
  });
});

describe('wiki nodes (toggle, embed, mention)', () => {
  it('reads :::toggle[Summary] as a toggle and keeps other directives unwrapped', () => {
    const r = markdownToDoc(':::toggle[How it *works*]\nBody\n:::\n\n:::toggle\nNo summary\n:::');
    expect(r.doc.content?.[0]).toEqual({
      type: 'toggle',
      attrs: { summary: 'How it works' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }],
    });
    expect(r.doc.content?.[1]).toMatchObject({ type: 'toggle', attrs: { summary: '' } });
    expect(r.warnings).toEqual([]);
    const v2 = markdownToDoc(':::toggle Old style\nx\n:::').doc;
    expect(v2.content?.[0]).toMatchObject({ type: 'toggle', attrs: { summary: 'Old style' } });
    const unknown = markdownToDoc(':::details\nKept\n:::');
    expect(unknown.doc.content?.[0]).toMatchObject({ type: 'paragraph' });
    expect(unknown.warnings.map((w) => w.type)).toEqual(['unknown-directive']);
  });

  it('reads ::embed leaf directives and keeps other leaf directives as text', () => {
    const r = markdownToDoc(
      '::embed{node="0190-abc" type="file"}\n\n::embed{node="n2"}\n\n::hologram{src="x.mp4"}',
    );
    expect(r.doc.content?.[0]).toEqual({
      type: 'embed',
      attrs: { nodeId: '0190-abc', nodeType: 'file' },
    });
    expect(r.doc.content?.[1]).toEqual({ type: 'embed', attrs: { nodeId: 'n2', nodeType: null } });
    expect(r.doc.content?.[2]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: '::hologram{src="x.mp4"}' }],
    });
    expect(r.warnings).toEqual([
      expect.objectContaining({ type: 'unknown-directive', detail: 'hologram' }),
    ]);
  });

  it('still leaves text directives off', () => {
    const doc = markdownToDoc('Ratio :ab and key:value, a::b and :x[y]{z}').doc;
    expect(doc.content?.[0]?.content).toEqual([
      { type: 'text', text: 'Ratio :ab and key:value, a::b and :x[y]{z}' },
    ]);
  });

  it('reads mention links and leaves plain @names and other links alone', () => {
    const doc = markdownToDoc(
      'Hi [@Ayşe Yılmaz](mention:user:u1), see [@Roadmap](mention:node:n9) by [@20 Ekim](mention:date:2026-10-20). @plain [x](mention:bad:1)',
    ).doc;
    const content = doc.content?.[0]?.content ?? [];
    expect(content.filter((n) => n.type === 'mention')).toEqual([
      { type: 'mention', attrs: { id: 'u1', label: 'Ayşe Yılmaz', kind: 'user' } },
      { type: 'mention', attrs: { id: 'n9', label: 'Roadmap', kind: 'node' } },
      { type: 'mention', attrs: { id: '2026-10-20', label: '20 Ekim', kind: 'date' } },
    ]);
    expect(content.some((n) => n.type === 'text' && n.text?.includes('@plain'))).toBe(true);
    expect(content.at(-1)).toMatchObject({
      text: 'x',
      marks: [{ type: 'link', attrs: { href: 'mention:bad:1' } }],
    });
  });

  it('writes the wiki nodes and round-trips them without changing the model', () => {
    const doc: EditorDoc = {
      type: 'doc',
      content: [
        {
          type: 'toggle',
          attrs: { summary: 'Why [this] *works* & <b> ~x~ !' },
          content: [
            {
              type: 'toggle',
              attrs: { summary: 'Inner' },
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Deep' }] },
                { type: 'embed', attrs: { nodeId: 'id "q" & co', nodeType: 'board' } },
              ],
            },
            {
              type: 'admonition',
              attrs: { type: 'note', title: null },
              content: [{ type: 'paragraph' }],
            },
          ],
        },
        { type: 'embed', attrs: { nodeId: 'f1', nodeType: 'file' } },
        { type: 'embed', attrs: { nodeId: 'f2', nodeType: null } },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Ping ' },
            { type: 'mention', attrs: { id: 'u1', label: 'Ali [Dev]', kind: 'user' } },
            { type: 'mention', attrs: { id: 'u1', label: 'Ali [Dev]', kind: 'user' } },
            { type: 'text', text: ' on ' },
            {
              type: 'mention',
              attrs: { id: '2026-10-20', label: '20 Oct', kind: 'date' },
              marks: [{ type: 'bold' }],
            },
          ],
        },
        { type: 'toggle', attrs: { summary: '' }, content: [{ type: 'paragraph' }] },
      ],
    };
    const md = docToMarkdown(doc);
    expect(md).toContain('::::toggle[');
    expect(md).toContain(
      ':::toggle[Inner]\nDeep\n\n::embed{node="id &quot;q&quot; &amp; co" type="board"}\n:::',
    );
    expect(md).toContain('::embed{node="f1" type="file"}');
    expect(md).toContain('::embed{node="f2"}');
    expect(md).toContain('(mention:user:u1)[@Ali');
    expect(md).toContain('**[@20 Oct](mention:date:2026-10-20)**');
    expect(markdownToDoc(md).doc).toEqual(doc);
    expect(markdownToDoc(md).warnings).toEqual([]);
  });

  it('keeps unknown leaf directive text stable across round trips', () => {
    const first = markdownToDoc('::hologram[Intro *clip*]{src=x.mp4}\nnext line').doc;
    const second = markdownToDoc(docToMarkdown(first)).doc;
    expect(second).toEqual(first);
  });

  it('keeps the level of a toggle heading, and reads only levels 1 to 3', () => {
    const { doc } = markdownToDoc(
      ':::toggle[Kurulum]{level=2}\nGövde\n:::\n\n:::toggle[Düz]{level=9}\nx\n:::',
    );
    expect(doc.content?.[0]).toMatchObject({ attrs: { summary: 'Kurulum', level: 2 } });
    expect(doc.content?.[1]?.attrs).toEqual({ summary: 'Düz' });
    const md = docToMarkdown(doc);
    expect(md).toContain(':::toggle[Kurulum]{level=2}');
    expect(md).toContain(':::toggle[Düz]\n');
    expect(markdownToDoc(md).doc.content?.[0]?.attrs).toEqual({ summary: 'Kurulum', level: 2 });
  });

  it('gives mention, toggle and embed text for search', () => {
    const doc = markdownToDoc(
      ':::toggle[Details]\nHello [@Ali](mention:user:u1)\n:::\n\n::embed{node="x" type="file"}',
    ).doc;
    expect(plainText(doc)).toBe('Details\nHello @Ali');
  });

  it('toPublicDoc flattens mentions, drops embeds and keeps toggles', () => {
    const doc = markdownToDoc(
      [
        'By [@Ali](mention:user:u1) on **[@20 Oct](mention:date:2026-10-20)** about [@Plan](mention:node:n1).',
        '',
        '::embed{node="f1" type="file"}',
        '',
        ':::toggle[More]',
        '::embed{node="f2" type="file"}',
        ':::',
      ].join('\n'),
    ).doc;
    const before = JSON.stringify(doc);
    const pub = toPublicDoc(doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect(pub).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'By Ali on ' },
            { type: 'text', text: '20 Oct', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' about Plan.' },
          ],
        },
        { type: 'toggle', attrs: { summary: 'More' }, content: [{ type: 'paragraph' }] },
      ],
    });
    expect(docToMarkdown(pub)).not.toContain('mention:');
    const onlyEmbed: EditorDoc = {
      type: 'doc',
      content: [{ type: 'embed', attrs: { nodeId: 'a', nodeType: null } }],
    };
    expect(toPublicDoc(onlyEmbed)).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
  });
});
