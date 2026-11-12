import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { pageExports, pages } from '@crewhall/db';
import { pagePath, type PageExportFormat } from '@crewhall/shared';
import { stateFromJson } from '../src/services/wiki/doc';
import { purgePageExports } from '../src/services/wiki/export/jobs';
import { markdownToDoc } from '../src/services/wiki/markdown';
import { Client, createTestApp, join, setupWithOwner, uploadFile, type TestApp } from './helpers';

/**
 * Page export (roadmap 6): PDF, DOCX, HTML and Markdown, one page or with sub-pages (a ZIP
 * whose links point at each other), images and attachments included; only the creator gets
 * the file, only pages the creator can open go in.
 */
describe('wiki export', () => {
  let app: TestApp;
  let owner: Client;
  let spaceId: string;
  let root: { id: string; name: string };
  let child: { id: string; name: string };
  let png: Buffer;
  let imageId: string;
  let pdfId: string;

  const run = async (c: Client, nodeId: string, format: PageExportFormat, children = false) => {
    const job = await c.api.call('createPageExport', {
      params: { nodeId },
      body: { format, children },
    });
    // Jobs run inline in tests: the export is done when the call returns.
    const done = await c.api.call('getPageExport', { params: { exportId: job.id } });
    expect(done).toMatchObject({ status: 'ready', format, children });
    return done;
  };

  const download = async (c: Client, exportId: string) => {
    const res = await c.fetch(`http://localhost:3000/api/v1/page-exports/${exportId}/download`);
    expect(res.status).toBe(302);
    const file = await fetch(res.headers.get('location')!);
    expect(file.ok).toBe(true);
    return Buffer.from(await file.arrayBuffer());
  };

  const unzip = (data: Buffer) => unzipSync(new Uint8Array(data));

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.isDefault)!.id;
    png = await sharp({
      create: { width: 40, height: 20, channels: 3, background: '#fbc419' },
    })
      .png()
      .toBuffer();
    const folder = await owner.api.call('createFolder', {
      params: { spaceId },
      body: { parentId: null, name: 'Ekler' },
    });
    imageId = (
      await uploadFile(owner, {
        spaceId,
        parentId: folder.id,
        name: 'şema.png',
        content: png,
        mime: 'image/png',
      })
    ).node.id;
    pdfId = (
      await uploadFile(owner, {
        spaceId,
        parentId: folder.id,
        name: 'rapor.pdf',
        content: Buffer.from('%PDF-1.4\n%test'),
        mime: 'application/pdf',
      })
    ).node.id;

    root = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Mimari' },
    });
    child = await owner.api.call('createPage', {
      params: { spaceId },
      body: {
        name: 'Kilit stratejisi',
        parentId: root.id,
        markdown: `Üst sayfa: [Mimari](${pagePath(root)})\n\n- [ ] Redis\n- [x] Postgres`,
      },
    });
    await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Ayrıntı', parentId: child.id, markdown: 'En alt' },
    });
    // The root links to its child, shows an image and links an attachment.
    const body = [
      '## Genel bakış',
      '',
      `Kuyruk **Redis** ile; ayrıntı: [Kilit](${pagePath(child)}).`,
      '',
      `![şema](node:${imageId})`,
      '',
      `Rapor: [rapor.pdf](node:${pdfId})`,
      '',
      '1. bir',
      '2. iki',
      '',
      '| Ad | Değer |',
      '| --- | --- |',
      '| a | 1 |',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      ':::note[Dikkat]',
      'Cuma deploy yok.',
      ':::',
    ].join('\n');
    await app.deps.db
      .update(pages)
      .set({ ydoc: stateFromJson(markdownToDoc(body)) })
      .where(eq(pages.nodeId, root.id));
  });
  afterAll(async () => {
    await app?.close();
  });

  it('Markdown: a ZIP with the page and its files, links pointing into ekler/', async () => {
    const job = await run(owner, root.id, 'md');
    expect(job.fileName).toBe('Mimari.zip');
    const files = unzip(await download(owner, job.id));
    expect(Object.keys(files).sort()).toEqual(['Mimari.md', 'ekler/rapor.pdf', 'ekler/şema.png']);
    const md = strFromU8(files['Mimari.md']!);
    expect(md.startsWith('# Mimari\n')).toBe(true);
    expect(md).toContain('![şema](ekler/%C5%9Fema.png)');
    expect(md).toContain('[rapor.pdf](ekler/rapor.pdf)');
    // The child page is not in this export: its link goes to the hub.
    expect(md).toContain(`(http://localhost:5173/p/${child.id})`);
    expect([...files['ekler/şema.png']!]).toEqual([...png]);
  });

  it('HTML: one self-contained file when the images can be embedded', async () => {
    const solo = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Görselli', markdown: `Önce\n\n![](node:${imageId})` },
    });
    const job = await run(owner, solo.id, 'html');
    expect(job.fileName).toBe('Görselli.html');
    const html = (await download(owner, job.id)).toString('utf8');
    expect(html).toContain('<h1 class="page-title">Görselli</h1>');
    expect(html).toContain(`src="data:image/png;base64,${png.toString('base64')}"`);
    expect(html).not.toContain('node:');
  });

  it('with sub-pages: a folder tree whose pages link to each other', async () => {
    const job = await run(owner, root.id, 'html', true);
    expect(job).toMatchObject({ fileName: 'Mimari.zip', pageCount: 3 });
    const files = unzip(await download(owner, job.id));
    expect(Object.keys(files).sort()).toEqual([
      'Mimari.html',
      'Mimari/Kilit stratejisi.html',
      'Mimari/Kilit stratejisi/Ayrıntı.html',
      'ekler/rapor.pdf',
    ]);
    expect(strFromU8(files['Mimari.html']!)).toContain('href="Mimari/Kilit%20stratejisi.html"');
    expect(strFromU8(files['Mimari/Kilit stratejisi.html']!)).toContain('href="../Mimari.html"');
    expect(strFromU8(files['Mimari.html']!)).toContain('href="ekler/rapor.pdf"');
  });

  it('DOCX: a Word document with the text and the embedded image', async () => {
    const job = await run(owner, root.id, 'docx');
    // The attachment travels next to it.
    const outer = unzip(await download(owner, job.id));
    const docx = unzip(Buffer.from(outer['Mimari.docx']!));
    const xml = strFromU8(docx['word/document.xml']!);
    expect(xml).toContain('Mimari');
    expect(xml).toContain('Genel bakış');
    expect(xml).toContain('Cuma deploy yok.');
    expect(Object.keys(docx).some((k) => k.startsWith('word/media/'))).toBe(true);
  });

  it('PDF: rendered on the server', async () => {
    const job = await run(owner, child.id, 'pdf');
    expect(job.fileName).toBe('Kilit stratejisi.pdf');
    const pdf = await download(owner, job.id);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(2000);
    const all = await run(owner, root.id, 'pdf', true);
    const files = unzip(await download(owner, all.id));
    expect(
      Object.keys(files)
        .filter((k) => k.endsWith('.pdf'))
        .sort(),
    ).toEqual([
      'Mimari.pdf',
      'Mimari/Kilit stratejisi.pdf',
      'Mimari/Kilit stratejisi/Ayrıntı.pdf',
      'ekler/rapor.pdf',
    ]);
  });

  it('removes the file and the record once the export expires', async () => {
    const job = await run(owner, child.id, 'md');
    await app.deps.db
      .update(pageExports)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(pageExports.id, job.id));
    expect(await purgePageExports(app.deps)).toBeGreaterThanOrEqual(1);
    await expect(
      owner.api.call('getPageExport', { params: { exportId: job.id } }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('nobody else gets the export; pages the person cannot open are not exported', async () => {
    const job = await run(owner, root.id, 'md');
    const { person: mert } = await join(app, owner, 'mert@milvasoft.com', 'member');
    await expect(
      mert.api.call('getPageExport', { params: { exportId: job.id } }),
    ).rejects.toMatchObject({ status: 404 });
    const res = await mert.fetch(`http://localhost:3000/api/v1/page-exports/${job.id}/download`);
    expect(res.status).toBe(404);

    const secret = await owner.api.call('createSpace', { body: { name: 'Finans', color: 's5' } });
    const hidden = await owner.api.call('createPage', {
      params: { spaceId: secret.id },
      body: { name: 'Bütçe' },
    });
    await expect(
      mert.api.call('createPageExport', {
        params: { nodeId: hidden.id },
        body: { format: 'pdf', children: false },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
