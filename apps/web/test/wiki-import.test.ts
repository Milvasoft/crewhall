import { describe, expect, it } from 'vitest';
import {
  AssetIndex,
  attachmentLinks,
  rewriteAttachments,
  type PackageFile,
} from '@/lib/wiki/importAssets';
import { readZip } from '@/lib/wiki/unzip';
import { makeZip } from './support/zip';

/** H18: images and attachments of Outline / Notion / Markdown packages come along. */

const enc = new TextEncoder();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const TEAM = '9b2c5a1e-3f44-4b8e-9d1a-6c0a2f9e1b77';
const SHOT = '1f0e8c3a-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const PDF = '7a1d2c3b-4e5f-4a6b-9c8d-7e6f5a4b3c2d';

/** What an Outline "Export collection (Markdown)" contains. */
const outline = () => [
  { path: 'Mühendislik/' },
  {
    path: 'Mühendislik/Mimari.md',
    data: enc.encode(
      [
        '# Mimari',
        '',
        `![Ekran Görüntüsü 2024-03-01.png](uploads/${TEAM}/${SHOT}/Ekran%20G%C3%B6r%C3%BCnt%C3%BCs%C3%BC%202024-03-01.png "Kuyruk")`,
        '',
        `Rapor: [rapor.pdf](/api/attachments.redirect?id=${PDF})`,
        '',
        '![silinmiş](/api/attachments.redirect?id=deadbeef-0000-4000-8000-000000000000)',
        '',
        '![logo](https://cdn.example.com/logo.png)',
      ].join('\n'),
    ),
  },
  {
    path: 'Mühendislik/Mimari/Kilit stratejisi.md',
    data: enc.encode(
      `Aynı görsel: ![](uploads/${TEAM}/${SHOT}/Ekran%20G%C3%B6r%C3%BCnt%C3%BCs%C3%BC%202024-03-01.png)\n\n<img src="https://outline.example.com/api/attachments.redirect?id=${PDF}" alt="pdf">`,
    ),
  },
  { path: `uploads/${TEAM}/${SHOT}/Ekran Görüntüsü 2024-03-01.png`, data: PNG },
  { path: `uploads/${TEAM}/${PDF}/rapor.pdf`, data: enc.encode('%PDF-1.4') },
];

async function packageFiles(zip: Uint8Array): Promise<PackageFile[]> {
  return (await readZip(zip)).map((e) =>
    /\.(md|markdown)$/i.test(e.path)
      ? { path: e.path, text: new TextDecoder().decode(e.data) }
      : { path: e.path, blob: new Blob([e.data as BlobPart]) },
  );
}

async function run(files: PackageFile[]) {
  const uploads: string[] = [];
  const result = await rewriteAttachments(
    files.filter((f) => f.text !== undefined).map((f) => ({ path: f.path, content: f.text! })),
    new AssetIndex(files),
    async (file) => {
      uploads.push(file.path);
      return `id-${uploads.length}`;
    },
  );
  return { ...result, uploads };
}

describe('import packages (H18)', () => {
  it('reads an Outline export: deflated entries, UTF-8 names, no folder entries', async () => {
    const entries = await readZip(await makeZip(outline()));
    expect(entries.map((e) => e.path)).toEqual([
      'Mühendislik/Mimari.md',
      'Mühendislik/Mimari/Kilit stratejisi.md',
      `uploads/${TEAM}/${SHOT}/Ekran Görüntüsü 2024-03-01.png`,
      `uploads/${TEAM}/${PDF}/rapor.pdf`,
    ]);
    expect([...entries[2]!.data]).toEqual([...PNG]);
  });

  it('uploads Outline images and attachments once and links them as node:<id>', async () => {
    const res = await run(await packageFiles(await makeZip(outline())));
    expect(res.uploads).toEqual([
      `uploads/${TEAM}/${SHOT}/Ekran Görüntüsü 2024-03-01.png`,
      `uploads/${TEAM}/${PDF}/rapor.pdf`,
    ]);
    const [mimari, kilit] = res.files;
    expect(mimari!.content).toContain('![Ekran Görüntüsü 2024-03-01.png](node:id-1 "Kuyruk")');
    expect(mimari!.content).toContain('Rapor: [rapor.pdf](node:id-2)');
    expect(mimari!.content).toContain('![logo](https://cdn.example.com/logo.png)');
    // A page deeper in the tree still links from the package root; <img> becomes Markdown.
    expect(kilit!.content).toBe('Aynı görsel: ![](node:id-1)\n\n![pdf](node:id-2)');
    expect(res.missing).toEqual([
      {
        path: 'Mühendislik/Mimari.md',
        target: '/api/attachments.redirect?id=deadbeef-0000-4000-8000-000000000000',
      },
    ]);
    expect(res.uploaded).toBe(2);
  });

  it('opens a Notion export (zip in zip) and matches page-relative, encoded links', async () => {
    const inner = await makeZip([
      {
        path: 'Proje Planı 8f3a2b.md',
        data: enc.encode(
          '# Proje Planı\n\n![image.png](Proje%20Plan%C4%B1%208f3a2b/image.png)\n\n![](Proje%20Plan%C4%B1%208f3a2b/yok.png)',
        ),
      },
      { path: 'Proje Planı 8f3a2b/image.png', data: PNG },
    ]);
    const outer = await makeZip([{ path: 'Export-5e1c-Part-1.zip', data: inner }]);
    const res = await run(await packageFiles(outer));
    expect(res.files[0]!.content).toContain('![image.png](node:id-1)');
    expect(res.missing.map((m) => m.target)).toEqual(['Proje%20Plan%C4%B1%208f3a2b/yok.png']);
  });

  it('matches plain Markdown folders: relative, parent and nested-root paths', () => {
    const files: PackageFile[] = [
      { path: 'Wiki/Ops/Yedekleme.md', text: '' },
      { path: 'Wiki/Ops/img/disk.png', blob: new Blob(['x']) },
      { path: 'Wiki/assets/logo.svg', blob: new Blob(['y']) },
    ];
    const index = new AssetIndex(files);
    expect(index.resolve('img/disk.png', 'Wiki/Ops/Yedekleme.md')?.path).toBe(
      'Wiki/Ops/img/disk.png',
    );
    expect(index.resolve('../assets/logo.svg', 'Wiki/Ops/Yedekleme.md')?.path).toBe(
      'Wiki/assets/logo.svg',
    );
    expect(index.resolve('<img/disk.png>', 'Wiki/Ops/Yedekleme.md')?.path).toBe(
      'Wiki/Ops/img/disk.png',
    );
    expect(index.resolve('https://x.test/disk.png', 'Wiki/Ops/Yedekleme.md')).toBeNull();
    expect(
      attachmentLinks('[site](https://x.test) [başka sayfa](#bölüm) ![a](img/disk.png)'),
    ).toEqual(['img/disk.png']);
  });

  it('leaves links to imported pages for the server and reports the rest', async () => {
    const files: PackageFile[] = [
      { path: 'Ops.md', text: '[alt](Ops/Yedek%20Plan.md#kurulum) [yok](Silinen.md)' },
      { path: 'Ops/Yedek Plan.md', text: '[üst](../Ops.md)' },
    ];
    const res = await run(files);
    expect(res.uploads).toEqual([]);
    expect(res.missing).toEqual([{ path: 'Ops.md', target: 'Silinen.md' }]);
    expect(res.files[0]!.content).toBe('[alt](Ops/Yedek%20Plan.md#kurulum) [yok](Silinen.md)');
    expect(res.files[1]!.content).toBe('[üst](../Ops.md)');
  });

  it('reports files whose upload failed', async () => {
    const files: PackageFile[] = [
      { path: 'a.md', text: '![x](x.png)' },
      { path: 'x.png', blob: new Blob(['x']) },
    ];
    const res = await rewriteAttachments(
      [{ path: 'a.md', content: '![x](x.png)' }],
      new AssetIndex(files),
      () => Promise.reject(new Error('quota')),
    );
    expect(res.files[0]!.content).toBe('![x](x.png)');
    expect(res.failed).toEqual([{ path: 'a.md', target: 'x.png' }]);
    expect(res.uploaded).toBe(0);
  });
});
