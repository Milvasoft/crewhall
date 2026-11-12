import { unzipSync } from 'fflate';

/**
 * Plain text out of a file (roadmap 10): PDF through pdf.js, Office Open XML and
 * OpenDocument by reading the XML inside the zip (fflate), and text files as UTF-8 /
 * UTF-16. All permissive licences; no OCR (scanned PDFs come out empty).
 */

/** Text kept per file: enough for search and AI context, small enough for one tsvector. */
export const CONTENT_MAX_CHARS = 200_000;
/** Larger files are not read at all. */
export const CONTENT_MAX_BYTES = 100 * 1024 * 1024;
/** Inside a zip: entries above this size are skipped (zip bombs). */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_PDF_PAGES = 1000;

export type ContentKind = 'text' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'odf' | 'html';

const TEXT_EXT = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'xml',
  'yaml',
  'yml',
  'toml',
  'ini',
  'log',
  'sql',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'cs',
  'c',
  'h',
  'cpp',
  'hpp',
  'php',
  'sh',
  'ps1',
  'bat',
  'css',
  'scss',
  'vue',
  'svelte',
  'swift',
  'dart',
  'tex',
  'srt',
  'vtt',
  'env',
  'conf',
  'cfg',
  'properties',
  'gradle',
  'tf',
  'proto',
]);

const OOXML: Record<string, ContentKind> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odf',
  'application/vnd.oasis.opendocument.spreadsheet': 'odf',
  'application/vnd.oasis.opendocument.presentation': 'odf',
};

const EXT_KIND: Record<string, ContentKind> = {
  pdf: 'pdf',
  docx: 'docx',
  docm: 'docx',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  pptx: 'pptx',
  pptm: 'pptx',
  odt: 'odf',
  ods: 'odf',
  odp: 'odf',
  html: 'html',
  htm: 'html',
};

/** What extractor reads a file, from its type and name; null = not indexed. */
export function contentKind(mime: string | null, name: string | null): ContentKind | null {
  const m = mime?.split(';')[0]?.trim().toLowerCase() ?? '';
  const ext = name?.includes('.') ? name.split('.').at(-1)!.toLowerCase() : '';
  if (m === 'application/pdf') return 'pdf';
  if (OOXML[m]) return OOXML[m];
  if (m === 'text/html' || m === 'application/xhtml+xml') return 'html';
  if (EXT_KIND[ext] && (m === '' || m === 'application/octet-stream' || m === 'application/zip')) {
    return EXT_KIND[ext];
  }
  if (m.startsWith('text/')) return 'text';
  if (/^application\/(json|xml|yaml|x-yaml|javascript|x-sh|toml|sql|x-tex|ld\+json)$/.test(m)) {
    return 'text';
  }
  if ((m === '' || m === 'application/octet-stream') && TEXT_EXT.has(ext)) return 'text';
  return null;
}

const ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (all, e: string) => {
    if (e.startsWith('#')) {
      const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    }
    return ENTITIES[e] ?? all;
  });
}

/** Markup → text: block ends become line breaks, every other tag goes. */
export function xmlText(xml: string, breaks?: RegExp, tabs?: RegExp): string {
  let s = breaks ? xml.replace(breaks, '\n') : xml;
  if (tabs) s = s.replace(tabs, '\t');
  s = s.replace(/<[^>]*>/g, '');
  return decodeEntities(s);
}

export function tidy(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

function decodeText(buf: Uint8Array): string {
  if (buf[0] === 0xff && buf[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff)
    return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  // Mostly invalid UTF-8: an old Turkish code page (Windows-1254) is the likely source.
  const bad = (utf8.match(/�/g) ?? []).length;
  if (bad > 0 && bad > utf8.length / 200) {
    try {
      return new TextDecoder('windows-1254').decode(buf);
    } catch {
      return utf8;
    }
  }
  return utf8.replace(/^\uFEFF/, '');
}

function unzip(buf: Uint8Array, wanted: (name: string) => boolean) {
  const files = unzipSync(buf, {
    filter: (f) => wanted(f.name) && f.originalSize <= MAX_ENTRY_BYTES,
  });
  const out = new Map<string, string>();
  for (const [name, data] of Object.entries(files)) out.set(name, new TextDecoder().decode(data));
  return out;
}

/** Numbered parts in their natural order: slide2 before slide10. */
const byNumber = (a: string, b: string) =>
  Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0);

function docx(buf: Uint8Array): string {
  const parts = unzip(buf, (n) =>
    /^word\/(document|footnotes|endnotes|comments|header\d*|footer\d*)\.xml$/.test(n),
  );
  const order = [...parts.keys()].sort((a, b) =>
    a === 'word/document.xml' ? -1 : b === 'word/document.xml' ? 1 : a.localeCompare(b),
  );
  return order
    .map((n) => xmlText(parts.get(n)!, /<\/w:p>|<w:br\s*\/>|<w:cr\s*\/>/g, /<w:tab\s*\/>/g))
    .join('\n\n');
}

function xlsx(buf: Uint8Array): string {
  const parts = unzip(
    buf,
    (n) =>
      n === 'xl/sharedStrings.xml' ||
      n === 'xl/workbook.xml' ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
  );
  const out: string[] = [];
  const workbook = parts.get('xl/workbook.xml');
  if (workbook) {
    for (const m of workbook.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g))
      out.push(decodeEntities(m[1]!));
  }
  const shared = parts.get('xl/sharedStrings.xml');
  if (shared) {
    for (const si of shared.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      out.push(xmlText(si[1]!.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')));
    }
  }
  for (const name of [...parts.keys()]
    .filter((n) => n.startsWith('xl/worksheets/'))
    .sort(byNumber)) {
    for (const m of parts.get(name)!.matchAll(/<is>([\s\S]*?)<\/is>/g)) out.push(xmlText(m[1]!));
  }
  return out.join('\n');
}

function pptx(buf: Uint8Array): string {
  const parts = unzip(buf, (n) => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(n));
  const slides = [...parts.keys()].filter((n) => n.includes('/slides/')).sort(byNumber);
  const notes = [...parts.keys()].filter((n) => n.includes('/notesSlides/')).sort(byNumber);
  return [...slides, ...notes]
    .map((n) => xmlText(parts.get(n)!, /<\/a:p>|<a:br\s*\/>/g, /<a:tab\s*\/>/g))
    .join('\n\n');
}

function odf(buf: Uint8Array): string {
  const parts = unzip(buf, (n) => n === 'content.xml');
  const xml = parts.get('content.xml') ?? '';
  return xmlText(
    xml,
    /<\/text:(p|h)>|<text:line-break\s*\/>|<\/table:table-cell>/g,
    /<text:tab\s*\/>/g,
  );
}

function html(buf: Uint8Array): string {
  const src = decodeText(buf)
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  return xmlText(src, /<\/(p|div|li|h[1-6]|tr|section|article)>|<br\s*\/?>/gi);
}

async function pdf(buf: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    let chars = 0;
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PDF_PAGES) && chars < CONTENT_MAX_CHARS; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str + (item.hasEOL ? '\n' : '');
      }
      pages.push(text);
      chars += text.length;
      page.cleanup();
    }
    return pages.join('\n\n');
  } finally {
    await task.destroy();
  }
}

export interface Extracted {
  text: string;
  /** The file had more text than CONTENT_MAX_CHARS. */
  truncated: boolean;
}

/** Extracts and normalizes the text of a file of the given kind. */
export async function extractText(buf: Uint8Array, kind: ContentKind): Promise<Extracted> {
  let raw: string;
  switch (kind) {
    case 'text':
      raw = decodeText(buf);
      break;
    case 'html':
      raw = html(buf);
      break;
    case 'pdf':
      raw = await pdf(buf);
      break;
    case 'docx':
      raw = docx(buf);
      break;
    case 'xlsx':
      raw = xlsx(buf);
      break;
    case 'pptx':
      raw = pptx(buf);
      break;
    case 'odf':
      raw = odf(buf);
      break;
  }
  const text = tidy(raw);
  return text.length > CONTENT_MAX_CHARS
    ? { text: text.slice(0, CONTENT_MAX_CHARS), truncated: true }
    : { text, truncated: false };
}
