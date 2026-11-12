import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

/**
 * The smallest XLSX reader and writer the tables import/export needs (no extra dependency):
 * the first worksheet, shared and inline strings, numbers and booleans. Styles are ignored, so
 * dates arrive as Excel serial numbers (the importer turns them into dates for date fields).
 */

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

const encode = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters (other than tab and line breaks) are not allowed in XML 1.0.
    .split('')
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 32 || code === 9 || code === 10 || code === 13;
    })
    .join('');

/** "AB12" → 27 (0-based column of AB). */
function columnOf(ref: string) {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const columnName = (i: number) => {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

/** Text of `<t>` runs inside a shared or inline string. */
const runs = (xml: string) =>
  [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1]!)).join('');

/** Rows of the first worksheet as strings ("" for empty cells). Throws on a non-XLSX file. */
export function readXlsx(bytes: Uint8Array): string[][] {
  const files = unzipSync(bytes);
  const shared = files['xl/sharedStrings.xml']
    ? [...strFromU8(files['xl/sharedStrings.xml']).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
        runs(m[1]!),
      )
    : [];
  const sheetName =
    Object.keys(files)
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
      .sort((a, b) => Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0]))[0] ?? '';
  const sheet = files[sheetName];
  if (!sheet) throw new Error('no worksheet');
  const xml = strFromU8(sheet);
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const c of rowMatch[1]!.matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!;
      const body = c[2] ?? '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /t="(\w+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let text: string;
      if (type === 's') text = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') text = runs(body);
      else if (type === 'b') text = v === '1' ? 'true' : 'false';
      else text = v !== undefined ? decode(v) : '';
      const col = ref ? columnOf(ref) : row.length;
      while (row.length < col) row.push('');
      row[col] = text;
    }
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** An .xlsx with one sheet: numbers stay numbers, everything else is an inline string. */
export function writeXlsx(
  rows: (string | number | boolean | null)[][],
  sheetName = 'Sheet1',
): Uint8Array {
  const sheetRows = rows
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => {
          const ref = `${columnName(ci)}${ri + 1}`;
          if (v === null || v === '') return '';
          if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
          if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${encode(String(v))}</t></is></c>`;
        })
        .join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join('');
  const name = encode(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
    ),
  });
}

/** Excel's day number (1900 system) as a date. */
export function excelSerialToDate(n: number) {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86_400_000)).toISOString();
}
