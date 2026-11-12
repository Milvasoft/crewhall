import { UPLOAD_PART_SIZE } from '@crewhall/shared';
import type { Storage } from './s3';

export class TooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`body exceeds ${limit} bytes`);
  }
}

/**
 * Writes a body of unknown length into the store without holding it in memory: one PUT
 * when it fits a part, a multipart upload above that (Finder sends chunked bodies with no
 * Content-Length). Returns the stored size; throws TooLargeError past `maxBytes`.
 */
export async function putStream(
  storage: Storage,
  key: string,
  body: AsyncIterable<Uint8Array> | null,
  contentType: string,
  maxBytes: number,
): Promise<number> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let total = 0;
  let uploadId: string | null = null;
  const parts: { partNumber: number; etag: string }[] = [];

  const flush = async (all: boolean) => {
    while (pendingBytes >= UPLOAD_PART_SIZE || (all && pendingBytes > 0)) {
      const joined = Buffer.concat(pending);
      const part = joined.subarray(0, UPLOAD_PART_SIZE);
      const rest = joined.subarray(part.length);
      uploadId ??= await storage.createMultipart(key, contentType);
      const partNumber = parts.length + 1;
      parts.push({ partNumber, etag: await storage.uploadPart(key, uploadId, partNumber, part) });
      pending = rest.length ? [Buffer.from(rest)] : [];
      pendingBytes = rest.length;
    }
  };

  try {
    for await (const chunk of body ?? []) {
      total += chunk.length;
      if (total > maxBytes) throw new TooLargeError(maxBytes);
      pending.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      pendingBytes += chunk.length;
      if (pendingBytes >= UPLOAD_PART_SIZE) await flush(false);
    }
    if (uploadId === null) {
      await storage.put(key, Buffer.concat(pending), contentType);
      return total;
    }
    await flush(true);
    await storage.completeMultipart(key, uploadId, parts);
    return total;
  } catch (err) {
    if (uploadId) await storage.abortMultipart(key, uploadId).catch(() => undefined);
    throw err;
  }
}
