import { type DriveNode } from '@crewhall/shared';
import { api } from '@/lib/api';

/**
 * One file through the Drive multipart flow (doc 17 §8) into a folder; used for card
 * attachments and "Drive'a kaydet" of drawing exports. Big resumable uploads with the
 * panel stay with Drive's own uploader; these files are small.
 */
export async function uploadToFolder(
  file: Blob & { name?: string },
  target: { spaceId: string; folderId: string | null; name: string },
): Promise<DriveNode> {
  const upload = await api.call('createUpload', {
    body: {
      spaceId: target.spaceId,
      parentId: target.folderId,
      name: target.name,
      sizeBytes: file.size,
      mime: file.type || undefined,
      onConflict: 'rename',
    },
  });
  const numbers = Array.from({ length: upload.partCount }, (_, i) => i + 1);
  const { parts } = await api.call('getUploadPartUrls', {
    params: { uploadId: upload.id },
    body: { partNumbers: numbers },
  });
  const done: { partNumber: number; etag: string }[] = [];
  for (const p of parts) {
    const start = (p.partNumber - 1) * upload.partSize;
    const res = await fetch(p.url, {
      method: 'PUT',
      body: file.slice(start, start + upload.partSize),
    });
    if (!res.ok) throw new Error(`upload part ${p.partNumber}: ${res.status}`);
    done.push({ partNumber: p.partNumber, etag: res.headers.get('etag') ?? '' });
  }
  const completed = await api.call('completeUpload', {
    params: { uploadId: upload.id },
    body: { parts: done },
  });
  return completed.node;
}
