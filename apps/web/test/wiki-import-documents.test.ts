import { markdownToDoc } from '@crewhall/editor';
import { describe, expect, it } from 'vitest';
import { AssetIndex, rewriteAttachments, type PackageFile } from '@/lib/wiki/importAssets';
import { pagesToImport, readPackage } from '@/lib/wiki/importPackage';
import { makeZip } from './support/zip';

/** Word documents and Confluence space exports as page imports. */

const enc = new TextEncoder();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const fileOf = (name: string, data: Uint8Array) => new File([data as BlobPart], name);

/** What the page importer makes of the Markdown. */
const blockTypes = (markdown: string) =>
  markdownToDoc(markdown).doc.content!.map((node) => node.type);

/* ------------------------------- Word ------------------------------- */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (text: string, style?: string) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const cell = (body: string) => `<w:tc>${body}</w:tc>`;
const IMAGE = `<w:p><w:r><w:drawing>
  <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
    <wp:docPr id="1" name="Şema" descr="Akış şeması"/>
    <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId9"/></pic:blipFill>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline>
</w:drawing></w:r></w:p>`;

const makeWord = (body: string) =>
  makeZip([
    {
      path: '[Content_Types].xml',
      data: enc.encode(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
          <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
          <Default Extension="xml" ContentType="application/xml"/>
          <Default Extension="png" ContentType="image/png"/>
          <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
        </Types>`,
      ),
    },
    {
      path: '_rels/.rels',
      data: enc.encode(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
        </Relationships>`,
      ),
    },
    {
      path: 'word/_rels/document.xml.rels',
      data: enc.encode(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
          <Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
        </Relationships>`,
      ),
    },
    {
      path: 'word/styles.xml',
      data: enc.encode(
        `<w:styles ${W}>
          <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
          <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
        </w:styles>`,
      ),
    },
    { path: 'word/media/image1.png', data: PNG },
    {
      path: 'word/document.xml',
      data: enc.encode(`<w:document ${W}><w:body>${body}</w:body></w:document>`),
    },
  ]);

const markdownOf = (files: PackageFile[], path: string) =>
  files.find((f) => f.path === path)?.text ?? '';

describe('importing Word documents', () => {
  it('makes a page with headings, a table and the images as files of the package', async () => {
    const docx = await makeWord(
      [
        para('Giriş', 'Heading1'),
        para('İlk paragraf.'),
        `<w:tbl><w:tr>${cell(para('Ad'))}${cell(para('Değer'))}</w:tr><w:tr>${cell(para('a|b'))}${cell(para('2'))}</w:tr></w:tbl>`,
        IMAGE,
      ].join(''),
    );
    const files = await readPackage([fileOf('Yıllık Rapor.docx', docx)]);
    expect(files.map((f) => f.path)).toEqual([
      'Yıllık Rapor.md',
      'Yıllık Rapor/Yıllık Rapor-1.png',
    ]);

    const md = markdownOf(files, 'Yıllık Rapor.md');
    // The file names the page, not the first heading of the body.
    expect(md.startsWith('# Yıllık Rapor\n\n# Giriş\n\nİlk paragraf.')).toBe(true);
    expect(md).toContain('| Ad | Değer |\n| --- | --- |\n| a\\|b | 2 |');

    const res = await rewriteAttachments(
      [{ path: 'Yıllık Rapor.md', content: md }],
      new AssetIndex(files),
      async () => 'img',
    );
    expect(res.missing).toEqual([]);
    expect(res.files[0]!.content).toContain('![Akış şeması](node:img)');

    expect(blockTypes(res.files[0]!.content)).toContain('table');
  });

  it('names the page after the Title style when the document has one', async () => {
    const docx = await makeWord(para('Satış Planı', 'Title') + para('Metin.'));
    const files = await readPackage([fileOf('taslak-v3.docx', docx)]);
    expect(markdownOf(files, 'taslak-v3.md')).toBe('# Satış Planı\n\nMetin.');
  });

  it('keeps struck text and leaves footnote numbers without their dead links', async () => {
    const { htmlToPageMarkdown } = await import('@/lib/wiki/importHtml');
    expect(htmlToPageMarkdown('<p>Fiyat <s>10</s> 8</p>')).toBe('Fiyat ~~10~~ 8');

    const docx = await makeZip([
      {
        path: '[Content_Types].xml',
        data: enc.encode(
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
            <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
            <Default Extension="xml" ContentType="application/xml"/>
            <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
            <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
          </Types>`,
        ),
      },
      {
        path: '_rels/.rels',
        data: enc.encode(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
            <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
          </Relationships>`,
        ),
      },
      {
        path: 'word/_rels/document.xml.rels',
        data: enc.encode(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
            <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
          </Relationships>`,
        ),
      },
      {
        path: 'word/footnotes.xml',
        data: enc.encode(
          `<w:footnotes ${W}><w:footnote w:id="1">${para('Kaynak notu.')}</w:footnote></w:footnotes>`,
        ),
      },
      {
        path: 'word/document.xml',
        data: enc.encode(
          `<w:document ${W}><w:body><w:p><w:r><w:t>Metin</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p></w:body></w:document>`,
        ),
      },
    ]);
    const md = markdownOf(await readPackage([fileOf('notlu.docx', docx)]), 'notlu.md');
    expect(md).toContain('Kaynak notu.');
    expect(md).not.toContain('#footnote');
    expect(md).not.toContain('↑');
  });

  it('reports a damaged document and goes on with the rest', async () => {
    const files = await readPackage([
      fileOf('bozuk.docx', enc.encode('not a zip')),
      fileOf('sağlam.md', enc.encode('# Sağlam\n\nmetin')),
    ]);
    expect(pagesToImport(files)).toEqual({
      markdown: [{ path: 'sağlam.md', content: '# Sağlam\n\nmetin' }],
      skipped: [{ path: 'bozuk.docx', code: 'unreadable' }],
    });
  });

  it('keeps a Word file that a page links to, or one among attachments, as a file', async () => {
    const docx = await makeWord(para('Metin.'));
    const zip = await makeZip([
      { path: 'Sayfa.md', data: enc.encode('[Sözleşme](ek/sozlesme.docx)') },
      { path: 'ek/sozlesme.docx', data: docx },
      { path: 'uploads/abc/kullanilmayan.docx', data: docx },
      { path: 'Tek başına.docx', data: docx },
    ]);
    const files = await readPackage([fileOf('paket.zip', zip)]);
    expect(files.filter((f) => f.text !== undefined).map((f) => f.path)).toEqual([
      'Sayfa.md',
      'Tek başına.md',
    ]);
    expect(files.filter((f) => f.blob).map((f) => f.path)).toEqual([
      'ek/sozlesme.docx',
      'uploads/abc/kullanilmayan.docx',
    ]);
  });
});

/* ---------------------------- Confluence ---------------------------- */

/** A page as Confluence's "Export space > HTML" writes it. */
const confluencePage = (opts: {
  title: string;
  parents?: { href: string; name: string }[];
  body: string;
  attachments?: { file: string; name: string }[];
}) => `<!DOCTYPE html><html><head><title>Mühendislik : ${opts.title}</title></head>
<body class="theme-default aui-theme-default"><div id="page"><div id="main" class="aui-page-panel">
  <div id="main-header"><div id="breadcrumb-section"><ol id="breadcrumbs">
    <li class="first"><span><a href="index.html">Mühendislik</a></span></li>
    ${(opts.parents ?? []).map((p) => `<li><span><a href="${p.href}">${p.name}</a></span></li>`).join('')}
  </ol></div>
  <h1 id="title-heading" class="pagetitle"><span id="title-text"> Mühendislik : ${opts.title} </span></h1></div>
  <div id="content" class="view">
    <div class="page-metadata">Created by <span class="author">Mert</span></div>
    <div id="main-content" class="wiki-content group">${opts.body}</div>
    ${
      opts.attachments
        ? `<div class="pageSection group"><div class="pageSectionHeader"><h2 id="attachments" class="pageSectionTitle">Ekler:</h2></div>
          <div class="greybox" align="left">${opts.attachments
            .map(
              (a) =>
                `<img src="images/icons/bullet_blue.gif" height="8" width="8" alt=""/> <a href="${a.file}">${a.name}</a> (image/png)<br/>`,
            )
            .join('')}</div></div>`
        : ''
    }
    <div class="pageSection group"><div class="pageSectionHeader"><h2 id="comments" class="pageSectionTitle">Comments:</h2></div><p>Yorum metni</p></div>
  </div></div><div id="footer"><p>Document generated by Confluence</p></div></div></body></html>`;

const INDEX = `<html><head><title>Mühendislik</title></head><body><div id="main-content"></div>
  <h2>Available Pages:</h2><ul><li><a href="100.html">Mimari</a></li></ul></body></html>`;

const BODY = `
  <div class="toc-macro"><ul><li><a href="#Mimari-Kuyruk">Kuyruk</a></li></ul></div>
  <h1 id="Mimari-Kuyruk">Kuyruk</h1>
  <p>Şuna bak: <a href="200.html" data-linked-resource-id="200">Kilit stratejisi</a>,
    <a href="/pages/viewpage.action?pageId=200">eski adres</a>,
    <a href="/display/ENG/Silinen">silinen sayfa</a>
    ve <a href="https://example.com/doc">dış belge</a>
    <img class="emoticon emoticon-smile" src="images/icons/emoticons/smile.svg" data-emoji-fallback="🙂" alt="(smile)"/></p>
  <div class="confluence-information-macro confluence-information-macro-warning">
    <p class="title">Dikkat</p><span class="aui-icon aui-icon-small aui-iconfont-error confluence-information-macro-icon"></span>
    <div class="confluence-information-macro-body"><p>Üretimde çalıştırma.</p></div>
  </div>
  <div class="code panel pdl" style="border-width: 1px;"><div class="codeContent panelContent pdl">
    <pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: java; gutter: false; theme: Confluence" data-theme="Confluence">int a = 1;
int b = 2;</pre></div></div>
  <div class="table-wrap"><table class="wrapped confluenceTable"><colgroup><col/><col/></colgroup><tbody>
    <tr><th class="confluenceTh">Ad</th><th class="confluenceTh">Durum</th></tr>
    <tr><td class="confluenceTd"><p>bir</p><p>iki</p></td><td class="confluenceTd"><span class="status-macro aui-lozenge">BİTTİ</span></td></tr>
  </tbody></table></div>
  <ul class="inline-task-list"><li class="checked" data-inline-task-id="1"><span>Yapıldı</span></li><li data-inline-task-id="2"><span>Yapılacak</span></li></ul>
  <span class="confluence-embedded-file-wrapper"><img class="confluence-embedded-image" src="attachments/100/501.png?width=300" data-image-src="attachments/100/501.png" data-linked-resource-default-alias="şema.png" alt=""/></span>
`;

const confluenceExport = () =>
  makeZip([
    { path: 'ENG/' },
    { path: 'ENG/index.html', data: enc.encode(INDEX) },
    {
      path: 'ENG/100.html',
      data: enc.encode(
        confluencePage({
          title: 'Mimari',
          body: BODY,
          attachments: [
            { file: 'attachments/100/501.png', name: 'şema.png' },
            { file: 'attachments/100/502.pdf', name: 'rapor.pdf' },
          ],
        }),
      ),
    },
    {
      path: 'ENG/200.html',
      data: enc.encode(
        confluencePage({
          title: 'Kilit / strateji',
          parents: [{ href: '100.html', name: 'Mimari' }],
          body: '<p>Alt sayfa.</p>',
        }),
      ),
    },
    { path: 'ENG/styles/site.css', data: enc.encode('body {}') },
    { path: 'ENG/images/icons/bullet_blue.gif', data: PNG },
    { path: 'ENG/attachments/100/501.png', data: PNG },
    { path: 'ENG/attachments/100/502.pdf', data: enc.encode('%PDF-1.4') },
  ]);

describe('importing a Confluence space export', () => {
  const read = async () => readPackage([fileOf('ENG.zip', await confluenceExport())]);

  it('builds the page tree from breadcrumbs, without the index or the space key', async () => {
    const files = await read();
    expect(files.filter((f) => f.text !== undefined).map((f) => f.path)).toEqual([
      'Mimari.md',
      'Mimari/Kilit - strateji.md',
    ]);
    // A "/" cannot be in a path; the heading keeps the real name.
    expect(markdownOf(files, 'Mimari/Kilit - strateji.md')).toBe(
      '# Kilit / strateji\n\nAlt sayfa.',
    );
  });

  it('turns macros into the blocks of the editor', async () => {
    const md = markdownOf(await read(), 'Mimari.md');
    expect(md.startsWith('# Mimari\n\n# Kuyruk')).toBe(true);
    expect(md).toContain(':::danger[Dikkat]\n\nÜretimde çalıştırma.\n\n:::');
    expect(md).toContain('```java\nint a = 1;\nint b = 2;\n```');
    expect(md).toContain('| Ad | Durum |\n| --- | --- |\n| bir<br>iki | BİTTİ |');
    expect(md).toContain('- [x] Yapıldı');
    expect(md).toContain('- [ ] Yapılacak');
    expect(md).toContain('[dış belge](https://example.com/doc)');
    expect(md).toContain('🙂');

    expect(blockTypes(md)).toEqual(
      expect.arrayContaining(['admonition', 'codeBlock', 'table', 'taskList']),
    );
  });

  it('leaves out page chrome, comments and links with no target here', async () => {
    const md = markdownOf(await read(), 'Mimari.md');
    expect(md).not.toContain('Mert');
    expect(md).not.toContain('Yorum metni');
    expect(md).not.toContain('Document generated');
    expect(md).not.toContain('bullet_blue');
    expect(md).not.toContain('#Mimari-Kuyruk');
    expect(md).not.toContain('200.html');
    // No page of this export to point at: the words stay.
    expect(md).toContain('silinen sayfa');
    expect(md).not.toContain('/display/');
  });

  it('points links between pages at the imported file, from the root', async () => {
    const md = markdownOf(await read(), 'Mimari.md');
    const target = '/Mimari/Kilit%20-%20strateji.md';
    expect(md).toContain(`[Kilit stratejisi](${target})`);
    expect(md).toContain(`[eski adres](${target})`);
  });

  it('uploads images and listed attachments under their real names', async () => {
    const files = await read();
    const names: string[] = [];
    const res = await rewriteAttachments(
      pagesToImport(files).markdown,
      new AssetIndex(files),
      async (f) => {
        names.push(f.name ?? f.path);
        return `id-${names.length}`;
      },
    );
    expect(res.missing).toEqual([]);
    expect(names).toEqual(['şema.png', 'rapor.pdf']);
    const md = res.files.find((f) => f.path === 'Mimari.md')!.content;
    expect(md).toContain('![](node:id-1)');
    // A file the body does not show is listed under the export's own heading.
    expect(md).toContain('## Ekler\n\n- [rapor.pdf](node:id-2)');
    expect(md).not.toContain('[şema.png]');
  });

  it('does not take plain HTML next to an index.html for an export', async () => {
    const files = await readPackage([
      fileOf('index.html', enc.encode('<html><body><p>Site</p></body></html>')),
      fileOf(
        'hakkinda.html',
        enc.encode('<html><body><main id="main-content">Biz</main></body></html>'),
      ),
      fileOf('sayfa.md', enc.encode('metin')),
    ]);
    expect(files.map((f) => f.path)).toEqual(['index.html', 'hakkinda.html', 'sayfa.md']);
  });
});

describe('what one import can carry', () => {
  it('leaves out the deepest pages over the limit and reports them', () => {
    const files: PackageFile[] = Array.from({ length: 201 }, (_, i) => ({
      path: i === 0 ? 'a/b/derin.md' : `s${i}.md`,
      text: 'x',
    }));
    const { markdown, skipped } = pagesToImport(files);
    expect(markdown).toHaveLength(200);
    expect(skipped).toEqual([{ path: 'a/b/derin.md', code: 'too_many' }]);
  });

  it('reports a page over the size limit instead of failing the whole import', () => {
    const { markdown, skipped } = pagesToImport([
      { path: 'dev.md', text: 'x'.repeat(200_001) },
      { path: 'kısa.md', text: 'x' },
    ]);
    expect(markdown.map((m) => m.path)).toEqual(['kısa.md']);
    expect(skipped).toEqual([{ path: 'dev.md', code: 'too_large' }]);
  });
});
