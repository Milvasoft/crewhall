import { type DriveNode } from '@crewhall/shared';
import { api } from '@/lib/api';
import { kindOf } from './fileKinds';
import { putPart } from './uploads';

/**
 * Text, code and Markdown editing in Drive (roadmap 7). Saving uploads the text as a new
 * version of the same file through the regular upload flow, so history, quota and previews
 * work as for any upload.
 */

/** Larger files open read-only: the browser editor stays fast and saves stay one part. */
export const TEXT_EDIT_MAX_BYTES = 2 * 1024 * 1024;

export type TextMode = 'edit' | 'readonly' | 'none';

/** Whether the viewer offers editing for this file, read-only text, or neither. */
export function textMode(node: DriveNode, canEdit: boolean): TextMode {
  if (node.type !== 'file') return 'none';
  const kind = kindOf(node.name, node.mime);
  if (kind !== 'text' && kind !== 'code') return 'none';
  return canEdit && node.sizeBytes <= TEXT_EDIT_MAX_BYTES ? 'edit' : 'readonly';
}

export function isMarkdown(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name);
}

/**
 * Uploads `text` as the next version of `node` (UTF-8, one part). With `baseVersion` the
 * server refuses with 409 version_conflict when the file moved on meanwhile; without it the
 * text is written anyway ("Yine de kaydet").
 */
export async function saveTextVersion(node: DriveNode, text: string, baseVersion?: number) {
  const blob = new Blob([text], { type: node.mime ?? 'text/plain' });
  const upload = await api.call('createUpload', {
    body: {
      spaceId: node.spaceId,
      parentId: node.parentId,
      name: node.name,
      sizeBytes: blob.size,
      mime: node.mime ?? undefined,
      onConflict: 'version',
      nodeId: node.id,
      baseVersion,
    },
  });
  const { parts } = await api.call('getUploadPartUrls', {
    params: { uploadId: upload.id },
    body: { partNumbers: [1] },
  });
  const etag = await putPart(parts[0]!.url, blob, new AbortController().signal, () => {});
  return api.call('completeUpload', {
    params: { uploadId: upload.id },
    body: { parts: [{ partNumber: 1, etag }] },
  });
}
