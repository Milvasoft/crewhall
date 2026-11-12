import { PAGE_MARKDOWN_MAX, type SystemFolder } from '@crewhall/shared';
import { api, isApiError } from '@/lib/api';
import { uploadToFolder } from '@/lib/boards/upload';
import { AssetIndex, attachmentLinks, type PackageFile } from './importAssets';
import { readZip } from './unzip';

/**
 * Reading what the person picked for an import (design 5.15, H18): Markdown files, Word
 * documents, a folder, or an export package (.zip from Outline, Notion or Confluence). Pages come
 * back as Markdown text, every other file as a blob that may be uploaded to Drive.
 */

const MARKDOWN = /\.(md|markdown)$/i;
const WORD = /\.docx$/i;
const CONFLUENCE_INDEX = /(^|\/)index\.html?$/i;
/** The folders where export packages keep files that pages link to. */
const ATTACHMENTS = /(^|\/)(uploads|attachments)\//i;
/** The limit of one import request. */
const MAX_PAGES = 200;

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  pdf: 'application/pdf',
};
const mimeOf = (path: string) => MIME[path.split('.').at(-1)?.toLowerCase() ?? ''] ?? '';

export async function readPackage(list: FileList | File[]): Promise<PackageFile[]> {
  const out: PackageFile[] = [];
  for (const f of [...list]) {
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (/\.zip$/i.test(f.name)) {
      for (const e of await readZip(new Uint8Array(await f.arrayBuffer()))) {
        out.push(
          MARKDOWN.test(e.path)
            ? { path: e.path, text: new TextDecoder().decode(e.data) }
            : { path: e.path, blob: new Blob([e.data as BlobPart], { type: mimeOf(e.path) }) },
        );
      }
    } else if (MARKDOWN.test(path)) {
      out.push({ path, text: await f.text() });
    } else {
      out.push({ path, blob: f });
    }
  }
  return convertDocuments(out);
}

async function convertDocuments(files: PackageFile[]): Promise<PackageFile[]> {
  let out = files;
  if (out.some((f) => f.blob && CONFLUENCE_INDEX.test(f.path))) {
    const { convertConfluence } = await import('./importConfluence');
    out = await convertConfluence(out);
  }
  // A Word file a page links to is an attachment of that page.
  const index = new AssetIndex(out);
  const linked = new Set(
    out.flatMap((f) =>
      f.text === undefined ? [] : attachmentLinks(f.text).map((t) => index.resolve(t, f.path)),
    ),
  );
  const words = out.filter(
    (f) => f.blob && WORD.test(f.path) && !ATTACHMENTS.test(f.path) && !linked.has(f),
  );
  if (!words.length) return out;

  const { convertWord } = await import('./importWord');
  const converted = new Map<PackageFile, PackageFile[]>();
  for (const word of words) {
    converted.set(
      word,
      await convertWord(word).catch(() => [{ path: word.path, unreadable: true }]),
    );
  }
  return out.flatMap((f) => converted.get(f) ?? [f]);
}

export type SkippedPage = { path: string; code: 'too_large' | 'unreadable' | 'too_many' };

/**
 * What one import request can carry. Parents go first, so that going over the limit leaves out
 * the deepest pages and never leaves a page without its parent's content.
 */
export function pagesToImport(all: PackageFile[]) {
  const depth = (path: string) => path.split('/').length;
  const skipped: SkippedPage[] = all
    .filter((f) => f.unreadable)
    .map((f) => ({ path: f.path, code: 'unreadable' }));
  const fits: { path: string; content: string }[] = [];
  for (const f of all) {
    if (f.text === undefined) continue;
    if (f.text.length > PAGE_MARKDOWN_MAX) skipped.push({ path: f.path, code: 'too_large' });
    else fits.push({ path: f.path, content: f.text });
  }
  fits.sort((a, b) => depth(a.path) - depth(b.path));
  for (const f of fits.slice(MAX_PAGES)) skipped.push({ path: f.path, code: 'too_many' });
  return { markdown: fits.slice(0, MAX_PAGES), skipped };
}

/**
 * The folder's id, created on first use. With `system` it is the app's own folder of that role
 * (found again by role, hidden from Drive lists); otherwise a folder of that name is reused.
 */
export function lazyFolder(target: {
  spaceId: string;
  parentId: string | null;
  folderName: string;
  system?: SystemFolder;
}) {
  let folder: Promise<string> | null = null;
  return () => {
    folder ??= api
      .call('createFolder', {
        params: { spaceId: target.spaceId },
        body: {
          parentId: target.parentId,
          name: target.folderName,
          ...(target.system ? { system: target.system } : {}),
        },
      })
      .then((f) => f.id)
      .catch((e: unknown) => {
        const details = isApiError(e, 'node_name_taken')
          ? (e.details as { nodeId?: unknown })
          : null;
        const existing = details?.nodeId;
        if (typeof existing === 'string') return existing;
        // Failed: the next image tries again.
        folder = null;
        throw e;
      });
    return folder;
  };
}

/**
 * Uploads package files into one attachments folder under the import target, created on the
 * first upload (a folder of that name from an earlier import is reused). Returns the file id.
 */
export function attachmentUploader(target: {
  spaceId: string;
  parentId: string | null;
  folderName: string;
}) {
  const folderId = lazyFolder({ ...target, system: 'import_attachments' });
  return async (file: PackageFile) => {
    if (!file.blob) throw new Error('not a file');
    const node = await uploadToFolder(file.blob, {
      spaceId: target.spaceId,
      folderId: await folderId(),
      name: file.name ?? file.path.split('/').at(-1)!,
    });
    return node.id;
  };
}
