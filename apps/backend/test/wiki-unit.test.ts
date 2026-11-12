import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { pageIdFromRef, pagePath, pageSlug, parsePageDocumentName } from '@crewhall/shared';
import { collectRefs } from '../src/services/wiki/derive';
import { HtmlRenderer } from '../src/services/wiki/export/html';
import { normalizeDoc } from '../src/services/wiki/export/normalize';
import { wordForms } from '../src/services/wiki/search';
import {
  appendContent,
  docFromState,
  docToJson,
  plainText,
  replaceContent,
  stateFromJson,
  wordCount,
} from '../src/services/wiki/doc';
import { docToMarkdown, markdownToDoc } from '../src/services/wiki/markdown';
import {
  signCollabToken,
  signInternal,
  verifyCollabToken,
  verifyInternal,
} from '../src/services/wiki/token';

const SAMPLE = `## Genel bakış

Sistem **üç** süreçten *oluşur*: \`API\`, [Scheduler](https://example.com "başlık") ve ~~eski~~ Worker.

:::note[Canlı belge]
Mimari bir karar değişirse önce tartış.
:::

- [x] SIGTERM ile kapanma
- [ ] Lider seçimi

1. bir
2. iki

> Alıntı

\`\`\`csharp
public sealed record JobDefinition { }
\`\`\`

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`

| Servis | Ölçek   |
| ------ | ------- |
| Api    | 2 kopya |

:::toggle[Neden Hangfire değil?]
Çünkü dağıtık kilit.
:::

::embed{node="0192f0a0-0000-7000-8000-000000000001" type="file"}

---`;

describe('wiki markdown', () => {
  it('round-trips the blocks the wiki supports', () => {
    const doc = markdownToDoc(SAMPLE);
    const types = doc.content.map((n) => n.type);
    expect(types).toEqual([
      'heading',
      'paragraph',
      'admonition',
      'taskList',
      'orderedList',
      'blockquote',
      'codeBlock',
      'mermaid',
      'table',
      'toggle',
      'embed',
      'horizontalRule',
    ]);
    expect(docToMarkdown(doc)).toBe(SAMPLE);
  });

  it('keeps marks through Yjs and back', () => {
    const json = markdownToDoc(SAMPLE);
    const viaYjs = docToJson(docFromState(stateFromJson(json)));
    expect(docToMarkdown(viaYjs)).toBe(SAMPLE);
  });

  it('reads and writes mention links', () => {
    const doc = markdownToDoc(
      'Sorular için [@Can Demir](mention:user:0192f0a0-0000-7000-8000-000000000002).',
    );
    expect(doc.content[0]!.content![1]).toEqual({
      type: 'mention',
      attrs: { id: '0192f0a0-0000-7000-8000-000000000002', label: 'Can Demir', kind: 'user' },
    });
    expect(docToMarkdown(doc)).toBe(
      'Sorular için [@Can Demir](mention:user:0192f0a0-0000-7000-8000-000000000002).',
    );
    expect(collectRefs(doc).people).toEqual(['0192f0a0-0000-7000-8000-000000000002']);
  });

  it('derives plain text and words, including tables, code and toggles', () => {
    const text = plainText(markdownToDoc(SAMPLE));
    expect(text).toContain('Api | 2 kopya');
    expect(text).toContain('public sealed record JobDefinition');
    expect(text).toContain('Neden Hangfire değil?');
    expect(wordCount('Sistem üç süreçten oluşur.')).toBe(4);
  });

  it('replaces and appends content as Yjs updates', () => {
    const doc = new Y.Doc();
    replaceContent(doc, markdownToDoc('Bir'));
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    const sv = Y.encodeStateVector(doc);
    appendContent(doc, markdownToDoc('İki'));
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc, sv));
    expect(docToMarkdown(docToJson(remote))).toBe('Bir\n\nİki');
    replaceContent(doc, markdownToDoc('Üç'));
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    expect(docToMarkdown(docToJson(remote))).toBe('Üç');
  });
});

describe('page export', () => {
  const page = (attrs: Record<string, unknown>) => ({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'image', attrs: { src: 'a.png', ...attrs } }] },
    ],
  });

  it('keeps an image layout in HTML and never writes an untrusted value', () => {
    const render = (attrs: Record<string, unknown>) =>
      new HtmlRenderer(new Map()).body(page(attrs) as never);
    expect(render({ width: 40, align: 'center' })).toContain(
      'style="display:block;width:40%;margin-inline:auto;"',
    );
    expect(render({})).not.toContain('style=');
    expect(render({ width: '1;background:url(x)', align: 'x" onload="y' })).not.toContain('style=');
  });
});

describe('toggle headings in exports', () => {
  const toggle = (attrs: Record<string, unknown>) =>
    new HtmlRenderer(new Map()).body({
      type: 'doc',
      content: [{ type: 'toggle', attrs, content: [{ type: 'paragraph' }] }],
    } as never);

  it('writes the heading into the summary, and only a level it knows', () => {
    expect(toggle({ summary: 'Kurulum', level: 2 })).toContain(
      '<summary><h2 style="display:inline">Kurulum</h2></summary>',
    );
    expect(toggle({ summary: 'Düz' })).toContain('<summary>Düz</summary>');
    expect(toggle({ summary: 'Düz', level: '1><script>' })).toContain('<summary>Düz</summary>');
  });
});

describe('bookmarks and videos in exports', () => {
  const FILE = '0190f0a0-0000-7000-8000-000000000abc';
  const normalized = (node: unknown) => {
    const page = { id: 'p', path: 'Sayfa', doc: { type: 'doc', content: [node] } };
    const ctx = {
      hubUrl: 'https://hub.test',
      set: { files: new Map(), nodeNames: new Map() },
      pageById: new Map(),
      ext: '.html',
      zip: false,
      imagesAsFiles: false,
    };
    return normalizeDoc(ctx as never, page as never).content[0];
  };

  it('become links', () => {
    expect(
      normalized({ type: 'bookmark', attrs: { url: 'https://example.com', title: 'Örnek' } }),
    ).toEqual({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Örnek',
          marks: [{ type: 'link', attrs: { href: 'https://example.com', title: null } }],
        },
      ],
    });
    const file = normalized({ type: 'video', attrs: { src: `node:${FILE}`, title: 'Tanıtım' } });
    expect(file?.content?.[0]).toMatchObject({
      text: '▶ Tanıtım',
      marks: [{ attrs: { href: `https://hub.test/api/v1/nodes/${FILE}/download` } }],
    });
    expect(normalized({ type: 'video', attrs: { src: '' } })).toEqual({ type: 'paragraph' });
  });
});

describe('new blocks in HTML exports', () => {
  const html = (content: unknown[]) =>
    new HtmlRenderer(new Map()).body({ type: 'doc', content } as never);

  it('writes formulas as MathML, without active links', () => {
    const out = html([
      { type: 'mathBlock', attrs: { latex: 'x^2' } },
      { type: 'paragraph', content: [{ type: 'mathInline', attrs: { latex: 'y' } }] },
    ]);
    expect(out).toContain('<div class="math">');
    expect(out.match(/<math/g)).toHaveLength(2);
    const evil = html([{ type: 'mathBlock', attrs: { latex: '\\href{javascript:alert(1)}{x}' } }]);
    expect(evil).not.toContain('href="javascript');
  });

  it('keeps columns side by side', () => {
    const column = { type: 'column', content: [{ type: 'paragraph' }] };
    expect(html([{ type: 'columns', content: [column, column] }])).toContain(
      '<div class="columns"><div class="column">',
    );
  });
});

describe('wiki refs and paths', () => {
  it('finds page links, embeds and node mentions', () => {
    const a = '0192f0a0-0000-7000-8000-00000000000a';
    const b = '0192f0a0-0000-7000-8000-00000000000b';
    const doc = markdownToDoc(
      `[A](/p/mimari-${a}#b-7Qx) ve [dış](https://x.com/p/a) ::embed{node="${b}"}\n\n::embed{node="${b}"}`,
    );
    const { refs } = collectRefs(doc);
    expect([...refs.keys()].sort()).toEqual([a, b]);
    expect([...refs.get(b)!]).toEqual(['embed']);
  });

  it('does not take an embedded table for a node', () => {
    const table = '0192f0a0-0000-7000-8000-00000000000d';
    const { refs } = collectRefs(markdownToDoc(`::embed{node="${table}" type="table"}`));
    expect([...refs.keys()]).toEqual([]);
  });

  it('builds and parses page paths and document names', () => {
    expect(pageSlug('Sürüm notları 1.4 · İş Akışı')).toBe('surum-notlari-1-4-is-akisi');
    const id = '0192f0a0-0000-7000-8000-00000000000c';
    expect(pagePath({ id, name: 'Mimari' })).toBe(`/p/mimari-${id}`);
    expect(pageIdFromRef(`/p/eski-ad-${id}`)).toBe(id);
    expect(parsePageDocumentName(`page:${id}`)).toBe(id);
    expect(parsePageDocumentName(`card:${id}`)).toBeNull();
  });
});

describe('collab tokens', () => {
  const secret = 'test-secret-0123456789abcdef0123456789';
  const payload = {
    d: 'page:0192f0a0-0000-7000-8000-00000000000c',
    u: '0192f0a0-0000-7000-8000-00000000000d',
    o: '0192f0a0-0000-7000-8000-00000000000e',
    src: 'web' as const,
  };
  it('verifies signature and expiry', () => {
    const token = signCollabToken(secret, { ...payload, exp: Math.floor(Date.now() / 1000) + 60 });
    expect(verifyCollabToken(secret, token)).toMatchObject(payload);
    expect(verifyCollabToken('another-secret-0123456789abcdef01234', token)).toBeNull();
    expect(verifyCollabToken(secret, `${token}x`)).toBeNull();
    const expired = signCollabToken(secret, { ...payload, exp: Math.floor(Date.now() / 1000) - 1 });
    expect(verifyCollabToken(secret, expired)).toBeNull();
  });
  it('signs internal requests', () => {
    const sig = signInternal(secret, '{"a":1}');
    expect(verifyInternal(secret, '{"a":1}', sig)).toBe(true);
    expect(verifyInternal(secret, '{"a":2}', sig)).toBe(false);
    expect(
      verifyInternal(secret, '{"a":1}', signInternal(secret, '{"a":1}', Date.now() - 120_000)),
    ).toBe(false);
  });
});

describe('search word forms', () => {
  it('strips Turkish suffixes down to a stem', () => {
    expect(wordForms('sunucuların')).toEqual(['sunucuların', 'sunucu', 'sunuc']);
    expect(wordForms('sunucuları')).toEqual(['sunucuları', 'sunucu', 'sunuc']);
    expect(wordForms('kuyruğu')).toEqual(['kuyruğu', 'kuyruğ']);
    expect(wordForms('api')).toEqual(['api']);
  });
});
