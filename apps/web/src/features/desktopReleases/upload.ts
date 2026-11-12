import { type DesktopPlatform } from '@crewhall/shared';
import { api } from '@/lib/api';
import { UploadHttpError } from './files';

/**
 * Desktop release files go up in parts (startDesktopUpload → PUT each part → complete), like
 * Drive: a proxy in front of S3 refuses one ~110 MB PUT (Cloudflare: 100 MB per request). Only
 * missing parts are sent: the server hands back the parts it already has for the same file (after
 * a page reload too), and a failed upload keeps its state for the next attempt.
 */
export interface MultipartState {
  uploadId: string;
  partSize: number;
  urls: Map<number, string>;
  /** ETags of the parts the store already has. */
  etags: Map<number, string>;
  /** Sizes of those parts, for the progress. */
  sizes: Map<number, number>;
  expiresAt: string;
}

/** The part answered 2xx but its ETag was not readable: the bucket CORS does not expose ETag. */
export class MissingEtagError extends Error {
  constructor() {
    super('ETag not exposed');
  }
}

/** An upload that stopped; `state` (when the upload had started) lets it continue. */
export class DesktopUploadError extends Error {
  constructor(
    override readonly cause: unknown,
    readonly state: MultipartState | null,
  ) {
    super('desktop upload stopped');
  }
}

/** A dropped connection or a busy store: worth continuing later (not a refusal). */
export function canResume(e: unknown): boolean {
  return e instanceof UploadHttpError && (e.status === 0 || e.status >= 500);
}

const RETRIES = 3;
/** URLs this close to expiring are not used any more; fresh ones are asked for. */
const EXPIRY_MARGIN_MS = 60_000;

function putOnce(
  url: string,
  body: Blob,
  signal: AbortSignal,
  onProgress: (loaded: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new UploadHttpError(xhr.status));
        return;
      }
      const etag = xhr.getResponseHeader('ETag');
      if (etag) resolve(etag);
      else reject(new MissingEtagError());
    };
    // A proxy's error page has no CORS headers, so its status reads as 0.
    xhr.onerror = () => reject(new UploadHttpError(0));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

/** One part, retried with backoff while the failure is a dropped connection or a 5xx. */
async function putPart(
  url: string,
  body: Blob,
  signal: AbortSignal,
  onProgress: (loaded: number) => void,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await putOnce(url, body, signal, onProgress);
    } catch (e) {
      if (signal.aborted || !canResume(e) || attempt >= RETRIES) throw e;
      onProgress(0);
      await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
    }
  }
}

async function start(platform: DesktopPlatform, file: File): Promise<MultipartState> {
  const up = await api.call('startDesktopUpload', {
    body: {
      platform,
      fileName: file.name,
      sizeBytes: file.size,
      contentType: file.type || 'application/octet-stream',
    },
  });
  // An unfinished upload of the same file comes back with the parts S3 already has.
  const have = up.uploadedParts ?? [];
  return {
    uploadId: up.uploadId,
    partSize: up.partSize,
    urls: new Map(up.parts.map((p) => [p.partNumber, p.url])),
    etags: new Map(have.map((p) => [p.partNumber, p.etag])),
    sizes: new Map(have.map((p) => [p.partNumber, p.sizeBytes])),
    expiresAt: up.expiresAt,
  };
}

/** Drops an unfinished upload on the server (cancel); best effort. */
export function abortUpload(platform: DesktopPlatform, fileName: string, uploadId: string): void {
  void api
    .call('abortDesktopUpload', {
      params: { upload: uploadId },
      query: { platform, fileName },
    })
    .catch(() => undefined);
}

/**
 * Uploads `file` in parts, continuing `resume` when given (only the missing parts go up; when its
 * URLs expired the server is asked again and answers with the same upload). `onProgress` gets
 * the bytes the store has.
 */
export async function uploadDesktopFile(
  platform: DesktopPlatform,
  file: File,
  signal: AbortSignal,
  onProgress: (loaded: number) => void,
  resume?: MultipartState | null,
): Promise<void> {
  let state = resume ?? null;
  try {
    if (!state || Date.parse(state.expiresAt) - Date.now() < EXPIRY_MARGIN_MS) {
      state = await start(platform, file);
    }
    const s = state;
    let done = [...s.sizes.values()].reduce((a, b) => a + b, 0);
    onProgress(done);
    for (const n of [...s.urls.keys()].sort((a, b) => a - b)) {
      if (s.etags.has(n)) continue;
      const body = file.slice((n - 1) * s.partSize, n * s.partSize);
      const etag = await putPart(s.urls.get(n)!, body, signal, (b) => onProgress(done + b));
      s.etags.set(n, etag);
      s.sizes.set(n, body.size);
      done += body.size;
    }
    await api.call('completeDesktopUpload', {
      params: { upload: s.uploadId },
      body: {
        platform,
        fileName: file.name,
        parts: [...s.etags]
          .sort(([a], [b]) => a - b)
          .map(([partNumber, etag]) => ({ partNumber, etag })),
      },
    });
  } catch (e) {
    throw new DesktopUploadError(e, state);
  }
}
