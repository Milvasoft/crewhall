/**
 * Tiny PDF writer for seeded documents, so the mock's download URL opens a real multi-page
 * PDF in the browser viewer. Helvetica only: Turkish letters are folded to ASCII.
 */

const FOLD: Record<string, string> = {
  ç: 'c',
  Ç: 'C',
  ğ: 'g',
  Ğ: 'G',
  ı: 'i',
  İ: 'I',
  ö: 'o',
  Ö: 'O',
  ş: 's',
  Ş: 'S',
  ü: 'u',
  Ü: 'U',
  '·': '-',
  '€': 'EUR',
};

function pdfText(text: string): string {
  const ascii = text.replace(/[^\x20-\x7e]/g, (c) => FOLD[c] ?? '?');
  return ascii.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function buildPdf(title: string, pages: string[][]): Uint8Array {
  const objects: string[] = [];
  const pageIds: number[] = [];
  // 1 catalog, 2 pages, 3 font; pages and contents follow.
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let next = 4;
  pages.forEach((lines, i) => {
    const pageId = next++;
    const contentId = next++;
    pageIds.push(pageId);
    const body = [
      'BT /F1 26 Tf 56 760 Td',
      `(${pdfText(i === 0 ? title : `${title} - ${i + 1}`)}) Tj ET`,
      ...lines.map((l, j) => `BT /F1 13 Tf 56 ${700 - j * 24} Td (${pdfText(l)}) Tj ET`),
      `BT /F1 10 Tf 530 40 Td (${i + 1}) Tj ET`,
    ].join('\n');
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
  });
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
