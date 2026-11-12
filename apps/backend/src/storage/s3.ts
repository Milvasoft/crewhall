import type { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type Part,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../env';

/** Presigned URLs live 5 minutes (doc 17 §2); part uploads get an hour for slow links. */
export const GET_URL_TTL_SECONDS = 300;
export const PART_URL_TTL_SECONDS = 3600;

export interface Storage {
  bucket: string;
  ensureBucket(): Promise<void>;
  createMultipart(key: string, contentType: string | undefined): Promise<string>;
  presignPart(key: string, uploadId: string, partNumber: number): Promise<string>;
  /** Server-side part upload (WebDAV PUT streams through the api); returns the ETag. */
  uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer): Promise<string>;
  listParts(
    key: string,
    uploadId: string,
  ): Promise<{ partNumber: number; size: number; etag: string }[]>;
  completeMultipart(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  /** Unfinished multipart uploads of exactly this key, newest first. */
  listMultipartUploads(key: string): Promise<{ uploadId: string; initiated: Date | null }[]>;
  head(key: string): Promise<{
    size: number;
    contentType: string | undefined;
    etag?: string | undefined;
    lastModified?: Date | undefined;
  } | null>;
  presignGet(
    key: string,
    options?: { fileName?: string; inline?: boolean; contentType?: string | null },
  ): Promise<{ url: string; expiresAt: Date }>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Objects under a prefix (all pages). */
  list(prefix: string): Promise<{ key: string; size: number; lastModified: Date | null }[]>;
  getStream(key: string, range?: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  /** Reachable at all (setup checks, readyz). */
  ping(): Promise<boolean>;
}

/** RFC 6266 / 5987 Content-Disposition with a UTF-8 file name. */
export function contentDisposition(fileName: string, inline = false): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function createStorage(env: Env): Storage | null {
  if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) return null;
  const credentials = { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY };
  // Checksums only when S3 requires them: browsers PUT presigned parts without checksum headers.
  const common = {
    region: env.S3_REGION,
    credentials,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED' as const,
    responseChecksumValidation: 'WHEN_REQUIRED' as const,
  };
  const client = new S3Client({ ...common, endpoint: env.S3_ENDPOINT });
  // Browsers and phones get URLs on the public address (s3.<domain> behind Caddy).
  const signer = new S3Client({ ...common, endpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT });
  const Bucket = env.S3_BUCKET;

  return {
    bucket: Bucket,
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket }));
      }
    },
    async createMultipart(key, contentType) {
      const res = await client.send(
        new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType }),
      );
      if (!res.UploadId) throw new Error('S3 returned no UploadId');
      return res.UploadId;
    },
    presignPart(key, uploadId, partNumber) {
      return getSignedUrl(
        signer,
        new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
        { expiresIn: PART_URL_TTL_SECONDS },
      );
    },
    async uploadPart(key, uploadId, partNumber, body) {
      const res = await client.send(
        new UploadPartCommand({
          Bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: body,
        }),
      );
      if (!res.ETag) throw new Error('S3 returned no ETag');
      return res.ETag;
    },
    async listParts(key, uploadId) {
      const out: { partNumber: number; size: number; etag: string }[] = [];
      let marker: string | undefined;
      for (;;) {
        const res = await client.send(
          new ListPartsCommand({ Bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }),
        );
        for (const p of res.Parts ?? []) {
          if (p.PartNumber && p.ETag) {
            out.push({ partNumber: p.PartNumber, size: p.Size ?? 0, etag: p.ETag });
          }
        }
        if (!res.IsTruncated || !res.NextPartNumberMarker) break;
        marker = res.NextPartNumberMarker;
      }
      return out;
    },
    async completeMultipart(key, uploadId, parts) {
      const sorted: Part[] = [...parts]
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag }));
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: sorted },
        }),
      );
    },
    async listMultipartUploads(key) {
      const out: { uploadId: string; initiated: Date | null }[] = [];
      let keyMarker: string | undefined;
      let idMarker: string | undefined;
      for (;;) {
        const res = await client.send(
          new ListMultipartUploadsCommand({
            Bucket,
            Prefix: key,
            KeyMarker: keyMarker,
            UploadIdMarker: idMarker,
          }),
        );
        for (const u of res.Uploads ?? []) {
          if (u.Key === key && u.UploadId) {
            out.push({ uploadId: u.UploadId, initiated: u.Initiated ?? null });
          }
        }
        if (!res.IsTruncated) break;
        keyMarker = res.NextKeyMarker;
        idMarker = res.NextUploadIdMarker;
      }
      return out.sort((a, b) => (b.initiated?.getTime() ?? 0) - (a.initiated?.getTime() ?? 0));
    },
    async abortMultipart(key, uploadId) {
      await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }));
    },
    async head(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return {
          size: Number(res.ContentLength ?? 0),
          contentType: res.ContentType,
          etag: res.ETag,
          lastModified: res.LastModified,
        };
      } catch {
        return null;
      }
    },
    async presignGet(key, options = {}) {
      const url = await getSignedUrl(
        signer,
        new GetObjectCommand({
          Bucket,
          Key: key,
          ResponseContentDisposition: options.fileName
            ? contentDisposition(options.fileName, options.inline)
            : undefined,
          ResponseContentType: options.contentType ?? undefined,
        }),
        { expiresIn: GET_URL_TTL_SECONDS },
      );
      return { url, expiresAt: new Date(Date.now() + GET_URL_TTL_SECONDS * 1000) };
    },
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async list(prefix) {
      const out: { key: string; size: number; lastModified: Date | null }[] = [];
      let token: string | undefined;
      do {
        const res = await client.send(
          new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const o of res.Contents ?? []) {
          if (o.Key)
            out.push({
              key: o.Key,
              size: Number(o.Size ?? 0),
              lastModified: o.LastModified ?? null,
            });
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async getStream(key, range) {
      const res = await client.send(new GetObjectCommand({ Bucket, Key: key, Range: range }));
      if (!res.Body) throw new Error(`empty object ${key}`);
      return res.Body as Readable;
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async ping() {
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
        return true;
      } catch {
        return false;
      }
    },
  };
}
