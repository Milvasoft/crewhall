import fs from 'node:fs';
import path from 'node:path';
import { Editor } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { markdownToDoc, type EditorDoc, type JSONNode } from '../src';
import { createExtensions, validateDoc } from '../src/react';
import { findCorpus, markdownFiles } from './helpers/corpus';

/**
 * An open editor fills in an image's empty layout; markdown has none and the shared document
 * never stores an empty attribute, so that is the one difference a document does not see.
 */
function withoutEmptyImageLayout(node: JSONNode): JSONNode {
  const attrs = node.attrs;
  const content = node.content?.map(withoutEmptyImageLayout);
  const next: JSONNode = content ? { ...node, content } : { ...node };
  if (node.type === 'image' && attrs) {
    const { width, align, ...rest } = attrs;
    next.attrs = {
      ...rest,
      ...(width === null ? {} : { width }),
      ...(align === null ? {} : { align }),
    };
  }
  if (node.type === 'toggle' && attrs?.level === null) {
    next.attrs = { ...attrs };
    delete next.attrs.level;
  }
  return next;
}

/** Loads a doc into a headless editor and returns what the editor gives back. */
function loadAndRead(doc: EditorDoc): unknown {
  const editor = new Editor({ extensions: createExtensions(), content: doc });
  const json = withoutEmptyImageLayout(editor.getJSON() as JSONNode);
  editor.destroy();
  return json;
}

export const fixtures: Record<string, string> = {
  headings: '# One\n\n## Two {#custom-two}\n\n###### Six *em* **strong** ~~del~~ `code`\n',
  marks:
    'A [link](https://x.io "Title") and [`code link`](/docs/a) and ***both*** and <kbd>Ctrl</kbd>.\n\nLine one\\\nline two\n',
  lists:
    '- a\n- b\n  - nested\n\n3. three\n4. four\n\n- [ ] todo\n- [x] done\n  - [ ] nested todo\n',
  quote: '> Quote\n>\n> - list in quote\n',
  code: '```js title="a.js" {1-2} showLineNumbers\nconst a = 1;\n```\n\n```\nplain\n```\n',
  mermaid: '```mermaid\nflowchart LR\n  A --> B\n```\n',
  table: '| a | b | c |\n|:--|:-:|--:|\n| 1 | **2** | ![i](/img/x.png) |\n| 4 |\n',
  admonition: ':::tip[Title]\nBody\n\n:::note\nNested\n:::\n\n:::\n\n:::danger\nNo title\n:::\n',
  tabs: [
    '<Tabs groupId="os">',
    '  <TabItem value="win" label="Windows" default>',
    '    Windows **body**',
    '  </TabItem>',
    '  <TabItem value="mac" label="macOS">',
    '',
    '    ```bash',
    '    brew install x',
    '    ```',
    '',
    '  </TabItem>',
    '</Tabs>',
  ].join('\n'),
  blog: 'Summary text.\n\n<!-- truncate -->\n\nRest of the post.\n',
  html: '<div class="hero">\n  <b>raw</b>\n</div>\n\nInline <span style="color:red">html</span> here.\n',
  images: '![Alt text](/media/img/a.png "Image title") inline ![](b.png)\n',
  rule: 'Above\n\n---\n\nBelow\n',
  wiki: [
    ':::toggle[Summary *x*]\nBody\n\n::embed{node="n1" type="file"}\n:::',
    '::embed{node="n2"}',
    'Hi [@Ali](mention:user:u1) and **[@Plan](mention:node:n3)** on [@1 Oct](mention:date:2026-10-01).',
    '- [@Ali](mention:user:u1)',
  ].join('\n\n'),
  empty: '',
};

describe('editor schema matches the document model', () => {
  for (const [name, md] of Object.entries(fixtures)) {
    it(`fixture "${name}" validates and survives the editor unchanged`, () => {
      const { doc } = markdownToDoc(md);
      expect(validateDoc(doc)).toEqual({ ok: true });
      expect(loadAndRead(doc)).toEqual(doc);
    });
  }

  it('rejects unknown nodes, unknown attributes and bad content', () => {
    expect(validateDoc({ type: 'doc', content: [{ type: 'hologram' }] }).ok).toBe(false);
    expect(
      validateDoc({
        type: 'doc',
        content: [{ type: 'orderedList', attrs: { start: 1, type: 'a' }, content: [] }],
      }).ok,
    ).toBe(false);
    expect(
      validateDoc({
        type: 'doc',
        content: [{ type: 'bulletList', content: [{ type: 'paragraph' }] }],
      }).ok,
    ).toBe(false);
    expect(
      validateDoc({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'x', marks: [{ type: 'underline' }] }],
          },
        ],
      }).ok,
    ).toBe(false);
  });
});

const corpus = findCorpus();

describe.skipIf(!corpus)('editor schema against the Docusaurus corpus', () => {
  it('every corpus document validates and survives the editor unchanged', () => {
    const files = markdownFiles(corpus!);
    expect(files.length).toBeGreaterThan(100);
    const failures: string[] = [];
    for (const file of files) {
      const { doc } = markdownToDoc(fs.readFileSync(file, 'utf8'));
      const rel = path.relative(corpus!, file);
      const v = validateDoc(doc);
      if (!v.ok) failures.push(`${rel}: ${v.error}`);
      else if (JSON.stringify(loadAndRead(doc)) !== JSON.stringify(doc)) {
        // Key order may differ; fall back to a deep comparison before reporting.
        try {
          expect(loadAndRead(doc)).toEqual(doc);
        } catch {
          failures.push(`${rel}: changed by the editor`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
});
