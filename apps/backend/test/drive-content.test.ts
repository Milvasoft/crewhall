import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { strToU8, zipSync } from 'fflate';
import { blobContents, orgMembers, organizations, users } from '@crewhall/db';
import { SNIPPET_MARK_START } from '@crewhall/shared';
import { AppError } from '../src/http/errors';
import { toActor } from '../src/services/membership';
import {
  backfillContents,
  contentKind,
  extractText,
  fileText,
  searchContents,
} from '../src/services/drive/content';
import { Client, createTestApp, join, setupWithOwner, uploadFile, type TestApp } from './helpers';

/** A one-page PDF with a line of Helvetica text; offsets computed so the xref is valid. */
export function minimalPdf(text: string): Buffer {
  const content = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

export function docx(paragraphs: string[]): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      'word/document.xml': strToU8(
        `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
      ),
    }),
  );
}

describe('content extraction', () => {
  it('picks an extractor from the type, or from the name when the type is generic', () => {
    expect(contentKind('application/pdf', 'a.pdf')).toBe('pdf');
    expect(contentKind('application/zip', 'rapor.docx')).toBe('docx');
    expect(contentKind(null, 'notlar.md')).toBe('text');
    expect(contentKind('text/csv', 'x')).toBe('text');
    expect(contentKind('image/png', 'a.png')).toBeNull();
    expect(contentKind('application/octet-stream', 'setup.exe')).toBeNull();
  });

  it('reads PDF text with pdf.js', async () => {
    const out = await extractText(minimalPdf('Quarterly revenue report Ankara'), 'pdf');
    expect(out.text).toContain('Quarterly revenue report Ankara');
  });

  it('reads Word, Excel, PowerPoint and OpenDocument text from their XML', async () => {
    expect(
      (await extractText(docx(['Kira sözleşmeleri', 'yenilendi &amp; imzalandı']), 'docx')).text,
    ).toBe('Kira sözleşmeleri\nyenilendi & imzalandı');
    const xlsx = zipSync({
      'xl/workbook.xml': strToU8(
        '<workbook><sheets><sheet name="Bütçe" sheetId="1"/></sheets></workbook>',
      ),
      'xl/sharedStrings.xml': strToU8(
        '<sst><si><t>Gelir</t></si><si><r><t>Gider </t></r><r><t>kalemi</t></r></si></sst>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        '<worksheet><c t="inlineStr"><is><t>Satır içi</t></is></c></worksheet>',
      ),
    });
    expect((await extractText(xlsx, 'xlsx')).text).toBe('Bütçe\nGelir\nGider kalemi\nSatır içi');
    const pptx = zipSync({
      'ppt/slides/slide10.xml': strToU8(
        `<p:sld ${A}><a:p><a:r><a:t>Onuncu</a:t></a:r></a:p></p:sld>`,
      ),
      'ppt/slides/slide2.xml': strToU8(
        `<p:sld ${A}><a:p><a:r><a:t>İkinci slayt</a:t></a:r></a:p></p:sld>`,
      ),
    });
    expect((await extractText(pptx, 'pptx')).text).toBe('İkinci slayt\n\nOnuncu');
    const odt = zipSync({
      'content.xml': strToU8(
        '<office:document-content><text:p>Açık</text:p><text:p>belge</text:p></office:document-content>',
      ),
    });
    expect((await extractText(odt, 'odf')).text).toBe('Açık\nbelge');
  });

  it('decodes UTF-16 and Windows-1254 text files and caps the length', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('şçğ metin', 'utf16le')]);
    expect((await extractText(utf16, 'text')).text).toBe('şçğ metin');
    // "şık" in Windows-1254: fe e7 fd ... ş=0xFE ı=0xFD
    const cp1254 = Buffer.from([0x6b, 0x61, 0x70, 0xfe, 0x31, 0x20, 0x61, 0xe7, 0xfd, 0x6b]);
    expect((await extractText(cp1254, 'text')).text).toBe('kapş1 açık');
    const big = await extractText(Buffer.from('a '.repeat(150_000)), 'text');
    expect(big.truncated).toBe(true);
    expect(big.text.length).toBe(200_000);
  });

  it('drops scripts and tags from HTML', async () => {
    const out = await extractText(
      Buffer.from(
        '<html><head><script>alert(1)</script></head><body><p>Merhaba</p><p>dünya &amp; herkes</p></body></html>',
      ),
      'html',
    );
    expect(out.text).toBe('Merhaba\ndünya & herkes');
  });
});

describe('file content search', () => {
  let app: TestApp;
  let owner: Client;
  let mert: Client;
  let orgId: string;
  let sharedId: string;
  let altyapiId: string;
  let pdfId: string;
  let noteId: string;

  beforeAll(async () => {
    app = await createTestApp();
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    orgId = setup.orgId;
    const spaces = await owner.api.call('listSpaces');
    sharedId = spaces.items.find((s) => s.name === 'Milvasoft')!.id;
    altyapiId = spaces.items.find((s) => s.name === 'Altyapı')!.id;
    mert = (await join(app, owner, 'mert@milvasoft.com', 'member', [sharedId])).person;

    await uploadFile(owner, {
      spaceId: sharedId,
      name: 'kira.docx',
      content: docx(['Ofis kira sözleşmeleri 2026 yılında yenilendi.']),
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const pdf = await uploadFile(owner, {
      spaceId: altyapiId,
      name: 'q3.pdf',
      content: minimalPdf('Quarterly revenue report for the infrastructure team'),
      mime: 'application/pdf',
    });
    pdfId = pdf.node.id;
    const note = await uploadFile(owner, {
      spaceId: sharedId,
      name: 'notlar.md',
      content: Buffer.from('# Toplantı\nSunucuların yedekleri gece alınacak.'),
      mime: 'text/markdown',
    });
    noteId = note.node.id;
    await uploadFile(owner, {
      spaceId: sharedId,
      name: 'sözleşme listesi.txt',
      content: Buffer.from('boş'),
      mime: 'text/plain',
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('indexes uploads in the worker and finds them by content, Turkish forms included', async () => {
    const rows = await app.deps.db.select().from(blobContents).where(eq(blobContents.orgId, orgId));
    expect(rows.filter((r) => r.status === 'ready')).toHaveLength(4);

    const hits = await owner.api.call('searchNodes', { query: { q: 'sözleşme', limit: 20 } });
    const names = hits.items.map((h) => h.node.name);
    // The name match comes before the content match.
    expect(names.slice(0, 2)).toEqual(['sözleşme listesi.txt', 'kira.docx']);
    const kira = hits.items.find((h) => h.node.name === 'kira.docx')!;
    expect(kira.matchedIn).toBe('content');
    expect(kira.snippet).toContain(SNIPPET_MARK_START);
    expect(hits.items[0]!.matchedIn).toBe('name');

    const turkish = await owner.api.call('searchNodes', {
      query: { q: 'sunucu yedek', limit: 20 },
    });
    expect(turkish.items.map((h) => h.node.name)).toEqual(['notlar.md']);
  });

  it('matches English stems in PDFs and keeps to what the caller may see', async () => {
    const mine = await owner.api.call('searchNodes', { query: { q: 'revenues', limit: 20 } });
    expect(mine.items.map((h) => h.node.name)).toEqual(['q3.pdf']);
    const theirs = await mert.api.call('searchNodes', { query: { q: 'revenue', limit: 20 } });
    expect(theirs.items).toEqual([]);
    const scoped = await owner.api.call('searchNodes', {
      query: { q: 'revenue', spaceId: sharedId, limit: 20 },
    });
    expect(scoped.items).toEqual([]);
  });

  it('can search names only', async () => {
    const hits = await owner.api.call('searchNodes', {
      query: { q: 'sözleşme', content: 'false', limit: 20 },
    });
    expect(hits.items.map((h) => h.node.name)).toEqual(['sözleşme listesi.txt']);
  });

  it('a new version replaces the indexed text', async () => {
    await uploadFile(owner, {
      spaceId: sharedId,
      name: 'notlar.md',
      nodeId: noteId,
      content: Buffer.from('Bütçe görüşmesi ertelendi.'),
      mime: 'text/markdown',
    });
    const old = await owner.api.call('searchNodes', { query: { q: 'yedekleri', limit: 20 } });
    expect(old.items).toEqual([]);
    const fresh = await owner.api.call('searchNodes', { query: { q: 'bütçe', limit: 20 } });
    expect(fresh.items.map((h) => h.node.name)).toEqual(['notlar.md']);
  });

  it('backfills files stored before the indexer', async () => {
    await app.deps.db.delete(blobContents).where(eq(blobContents.orgId, orgId));
    expect(await backfillContents(app.deps)).toBeGreaterThanOrEqual(4);
    const hits = await owner.api.call('searchNodes', { query: { q: 'kira', limit: 20 } });
    expect(hits.items.map((h) => h.node.name)).toContain('kira.docx');
    // Nothing left: the next run finds no work.
    expect(await backfillContents(app.deps)).toBe(0);
  });

  it('exposes text and search to other modules within the caller rights (AI, roadmap 11)', async () => {
    const actorOf = async (email: string) => {
      const [row] = await app.deps.db
        .select({ member: orgMembers, org: organizations })
        .from(orgMembers)
        .innerJoin(organizations, eq(organizations.id, orgMembers.organizationId))
        .innerJoin(users, eq(users.id, orgMembers.userId))
        .where(and(eq(orgMembers.organizationId, orgId), eq(users.email, email)));
      return { org: row!.org, actor: toActor(row!.member), userId: row!.member.userId };
    };
    const me = await actorOf('bugra@milvasoft.com');
    expect((await fileText(app.deps.db, me, pdfId))?.text).toContain('Quarterly revenue');
    const matches = await searchContents(app.deps.db, me, {
      q: 'infrastructure',
      spaceIds: [sharedId, altyapiId],
      limit: 5,
    });
    expect(matches.map((m) => m.node.id)).toEqual([pdfId]);

    const other = await actorOf('mert@milvasoft.com');
    await expect(fileText(app.deps.db, other, pdfId)).rejects.toBeInstanceOf(AppError);
    expect(
      await searchContents(app.deps.db, other, {
        q: 'infrastructure',
        spaceIds: [altyapiId],
        limit: 5,
      }),
    ).toEqual([]);
  });
});
