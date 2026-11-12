import type { DriveNode } from '@crewhall/shared';
import type { ApiClient } from '@crewhall/api-client';

/** Raised when the browser needs the person's permission to reach an address. */
export class NeedsPermissionError extends Error {
  constructor(readonly origin: string) {
    super('needs permission');
    this.name = 'NeedsPermissionError';
  }
}

const hasOrigin = (origin: string) => chrome.permissions.contains({ origins: [`${origin}/*`] });

/** Presigned multipart upload (doc 17 §8), one part at a time: clips are small. */
export async function uploadBlob(
  client: ApiClient,
  blob: Blob,
  target: { spaceId: string; parentId: string | null; name: string },
  onProgress?: (done: number, total: number) => void,
): Promise<DriveNode> {
  const upload = await client.call('createUpload', {
    body: {
      spaceId: target.spaceId,
      parentId: target.parentId,
      name: target.name,
      sizeBytes: blob.size,
      mime: blob.type || undefined,
      onConflict: 'rename',
    },
  });
  try {
    const partNumbers = Array.from({ length: upload.partCount }, (_, i) => i + 1);
    const parts: { partNumber: number; etag: string }[] = [];
    for (let i = 0; i < partNumbers.length; i += 100) {
      const { parts: urls } = await client.call('getUploadPartUrls', {
        params: { uploadId: upload.id },
        body: { partNumbers: partNumbers.slice(i, i + 100) },
      });
      for (const { partNumber, url } of urls) {
        // The store can live on another address than Crewhall (S3_PUBLIC_ENDPOINT).
        const storeOrigin = new URL(url).origin;
        if (!(await hasOrigin(storeOrigin))) throw new NeedsPermissionError(storeOrigin);
        const start = (partNumber - 1) * upload.partSize;
        const res = await fetch(url, {
          method: 'PUT',
          body: blob.slice(start, start + upload.partSize),
        });
        const etag = res.headers.get('etag');
        if (!res.ok || !etag) throw new Error(`part ${partNumber} failed`);
        parts.push({ partNumber, etag });
        onProgress?.(parts.length, upload.partCount);
      }
    }
    const done = await client.call('completeUpload', {
      params: { uploadId: upload.id },
      body: { parts },
    });
    return done.node;
  } catch (e) {
    await client.call('abortUpload', { params: { uploadId: upload.id } }).catch(() => undefined);
    throw e;
  }
}

const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
};

/** A file name from the address, with an extension from the type when it has none. */
export function fileNameFor(url: string, mime: string, fallback: string): string {
  let name = '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'data:' && u.protocol !== 'blob:') {
      name = decodeURIComponent(u.pathname.split('/').pop() ?? '');
    }
  } catch {
    // Not an address: the fallback name is used.
  }
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').trim().slice(0, 200) || fallback;
  const extension = EXTENSIONS[mime.split(';')[0]?.trim() ?? ''];
  return extension && !/\.[a-z0-9]{2,5}$/i.test(name) ? `${name}${extension}` : name;
}

/** Downloads what was right-clicked, with the site's cookies once the site is allowed. */
export async function fetchSource(url: string): Promise<Blob> {
  const parsed = new URL(url);
  if (parsed.protocol === 'data:') return (await fetch(url)).blob();
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('unsupported address');
  }
  const allowed = await hasOrigin(parsed.origin);
  try {
    const res = await fetch(url, { credentials: allowed ? 'include' : 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.blob();
  } catch (e) {
    if (!allowed) throw new NeedsPermissionError(parsed.origin);
    throw e;
  }
}
