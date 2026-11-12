import { zipSync, type Zippable } from 'fflate';
import type { PageExportFormat } from '@crewhall/shared';
import type { DbOrTx } from '@crewhall/db';
import type { Storage } from '../../../storage/s3';
import type { DriveActor } from '../../drive/access';
import { walk, type PMDoc } from '../doc';
import { docToMarkdown } from '../markdown';
import { collectExport, fileIdOfRef, safeName, type ExportPage } from './collect';
import { renderDocx } from './docx';
import { HtmlRenderer, htmlDocument } from './html';
import { normalizeDoc, type ExportContext } from './normalize';
import { renderPdf } from './pdf';

/**
 * Builds an export (roadmap 6). A single page whose files can all be embedded is one file;
 * sub-pages, or files that cannot be embedded (attachments; every file for Markdown), make a
 * ZIP: pages in a folder tree that mirrors the page tree, files in `ekler/`.
 */

export const EXT: Record<PageExportFormat, string> = {
  md: '.md',
  html: '.html',
  docx: '.docx',
  pdf: '.pdf',
};

export const MIME: Record<PageExportFormat | 'zip', string> = {
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  zip: 'application/zip',
};

const NAMES = {
  tr: { untitled: 'Başlıksız', attachments: 'ekler' },
  en: { untitled: 'Untitled', attachments: 'attachments' },
};

export interface BuiltExport {
  fileName: string;
  contentType: string;
  data: Buffer;
  pageCount: number;
  skipped: string[];
}

/** Files a body links to (not shown inline): they go into the ZIP whatever the format. */
function linkedFileIds(doc: PMDoc) {
  const ids = new Set<string>();
  walk(doc, (n) => {
    for (const m of n.marks ?? []) {
      const id = m.type === 'link' ? fileIdOfRef(String(m.attrs?.href ?? '')) : null;
      if (id) ids.add(id);
    }
    if (n.type === 'embed' && typeof n.attrs?.nodeId === 'string') ids.add(n.attrs.nodeId);
  });
  return ids;
}

async function renderPage(
  format: PageExportFormat,
  ctx: ExportContext,
  page: ExportPage,
  lang: 'tr' | 'en',
): Promise<Buffer> {
  const doc = normalizeDoc(ctx, page);
  switch (format) {
    case 'md': {
      const body = docToMarkdown(doc);
      return Buffer.from(`# ${page.name}\n\n${body}${body ? '\n' : ''}`, 'utf8');
    }
    case 'html': {
      const body = new HtmlRenderer(ctx.set.files).body(doc);
      return Buffer.from(htmlDocument({ title: page.name, icon: page.icon, body, lang }), 'utf8');
    }
    case 'docx':
      return renderDocx(ctx.set.files, { title: page.name, icon: page.icon, doc });
    case 'pdf':
      return renderPdf(ctx.set.files, { title: page.name, doc });
  }
}

export async function buildExport(
  deps: { db: DbOrTx; storage: Storage | null; hubUrl: string },
  a: DriveActor,
  input: { nodeId: string; format: PageExportFormat; children: boolean; locale: 'tr' | 'en' },
): Promise<BuiltExport> {
  const names = NAMES[input.locale];
  const set = await collectExport(deps, a, input.nodeId, input.children, names);
  const root = set.pages[0]!;

  const needed = new Set<string>();
  for (const page of set.pages) {
    for (const id of linkedFileIds(page.doc)) {
      const file = set.files.get(id);
      // An embedded image is shown inline; any other linked or embedded file is shipped.
      if (file && !(file.isImage && input.format !== 'md')) needed.add(id);
    }
  }
  if (input.format === 'md') set.files.forEach((_, id) => needed.add(id));
  const zip = input.children || set.pages.length > 1 || needed.size > 0;

  const ctx: ExportContext = {
    hubUrl: deps.hubUrl.replace(/\/$/, ''),
    set,
    pageById: new Map(set.pages.map((p) => [p.id, p])),
    ext: EXT[input.format],
    zip,
    imagesAsFiles: input.format === 'md',
  };

  const base = safeName(root.name, names.untitled);
  if (!zip) {
    return {
      fileName: `${base}${EXT[input.format]}`,
      contentType: MIME[input.format],
      data: await renderPage(input.format, ctx, root, input.locale),
      pageCount: 1,
      skipped: set.skipped,
    };
  }

  const entries: Zippable = {};
  for (const page of set.pages) {
    entries[`${page.path}${EXT[input.format]}`] = [
      new Uint8Array(await renderPage(input.format, ctx, page, input.locale)),
      { level: input.format === 'docx' || input.format === 'pdf' ? 0 : 6 },
    ];
  }
  for (const id of needed) {
    const file = set.files.get(id)!;
    entries[file.path] = [new Uint8Array(file.data), { level: file.isImage ? 0 : 6 }];
  }
  return {
    fileName: `${base}.zip`,
    contentType: MIME.zip,
    data: Buffer.from(zipSync(entries)),
    pageCount: set.pages.length,
    skipped: set.skipped,
  };
}
