import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Manifest, ObjectEntry, Repo } from './repo';

/** What backups need from the bucket. */
export interface ObjectStore {
  bucket: string;
  list(): AsyncIterable<{ key: string; size: number; etag: string | null }>;
  get(key: string): Promise<{ body: Readable; contentType: string | null }>;
  put(key: string, file: string, size: number, contentType: string | null): Promise<void>;
  delete(keys: string[]): Promise<void>;
}

export interface S3Settings {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function s3ObjectStore(s: S3Settings): ObjectStore {
  const client = new S3Client({
    endpoint: s.endpoint,
    region: s.region,
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const Bucket = s.bucket;
  return {
    bucket: Bucket,
    async *list() {
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket, ContinuationToken: token }),
        );
        for (const o of page.Contents ?? []) {
          if (o.Key) yield { key: o.Key, size: o.Size ?? 0, etag: o.ETag ?? null };
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    },
    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      return { body: res.Body as Readable, contentType: res.ContentType ?? null };
    },
    async put(key, file, size, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: createReadStream(file),
          ContentLength: size,
          ContentType: contentType ?? undefined,
        }),
      );
    },
    async delete(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        await client.send(
          new DeleteObjectsCommand({ Bucket, Delete: { Objects: batch.map((Key) => ({ Key })) } }),
        );
      }
    },
  };
}

/**
 * Copies every object into the repository's content pool. An object whose key, size and
 * ETag match the previous snapshot (and whose content is still pooled) is not downloaded.
 */
export async function backupObjects(
  store: ObjectStore,
  repo: Repo,
  previous: Manifest | null,
): Promise<ObjectEntry[]> {
  const known = new Map((previous?.objects.items ?? []).map((o) => [o.key, o]));
  const out: ObjectEntry[] = [];
  for await (const o of store.list()) {
    const prev = known.get(o.key);
    if (
      prev &&
      prev.size === o.size &&
      prev.etag === o.etag &&
      (await repo.hasObject(prev.sha256))
    ) {
      out.push(prev);
      continue;
    }
    const { body, contentType } = await store.get(o.key);
    const tmp = repo.tmpObjectPath(randomUUID());
    const hash = createHash('sha256');
    let size = 0;
    try {
      await pipeline(
        body,
        new Transform({
          transform(chunk: Buffer, _enc, done) {
            hash.update(chunk);
            size += chunk.length;
            done(null, chunk);
          },
        }),
        createWriteStream(tmp),
      );
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    const sha256 = hash.digest('hex');
    await repo.adoptObject(tmp, sha256);
    out.push({ key: o.key, size, etag: o.etag, contentType, sha256 });
  }
  return out;
}

/**
 * Makes the bucket match the snapshot: missing or changed objects are uploaded from the
 * pool, objects the snapshot does not know are deleted (nothing in the restored database
 * refers to them).
 */
export async function restoreObjects(store: ObjectStore, repo: Repo, manifest: Manifest) {
  const current = new Map<string, { size: number; etag: string | null }>();
  for await (const o of store.list()) current.set(o.key, o);
  let uploaded = 0;
  for (const item of manifest.objects.items) {
    const cur = current.get(item.key);
    current.delete(item.key);
    if (cur && cur.size === item.size && cur.etag === item.etag) continue;
    const file = repo.objectPath(item.sha256);
    const info = await stat(file).catch(() => null);
    if (!info) throw new Error(`object missing from the backup: ${item.key} (${item.sha256})`);
    await store.put(item.key, file, info.size, item.contentType);
    uploaded++;
  }
  const extra = [...current.keys()];
  await store.delete(extra);
  return { uploaded, deleted: extra.length };
}
