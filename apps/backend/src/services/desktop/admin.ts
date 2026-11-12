import { createHash } from 'node:crypto';
import {
  can,
  DESKTOP_FEED_FILE,
  DESKTOP_UPLOAD_MAX_BYTES,
  DESKTOP_UPLOAD_PART_BYTES,
  DesktopPlatform,
  type CompleteDesktopUpload,
  type CreateDesktopUpload,
  type DesktopMultipartUpload,
  type DesktopReleaseFile,
  type DesktopFileKind,
  type DesktopPlatformReleases,
  type DesktopReleases,
  type DesktopReleaseVersion,
  type PublishDesktopRelease,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { OrgCtx, RequestInfo } from '../../http/types';
import { PART_URL_TTL_SECONDS, type Storage } from '../../storage/s3';
import { audit } from '../audit';
import { requireInstallAdmin } from '../backups/service';
import { orgContext } from '../membership';
import {
  compareVersions,
  dirSource,
  parseFeed,
  readRelease,
  resetDesktopCache,
  s3Source,
} from './releases';

/**
 * Yönetim › Masaüstü sürümleri. Files are uploaded straight to the bucket under
 * `<DESKTOP_UPDATES_S3_PREFIX><platform>/` (presigned PUT); publishing hashes them and writes the
 * electron-updater feed next to them. There is no table: the bucket and the feed are the state.
 * Install-wide like backups: only the install admin (owner of the setup wizard's org) does it
 * (kararlar.md).
 */

type ReleaseDeps = Pick<Deps, 'db' | 'env' | 'storage'>;

export async function requireReleaseManager(
  deps: Pick<Deps, 'db'>,
  ctx: Pick<OrgCtx<never>, 'actor' | 'org'>,
) {
  if (!can(ctx.actor, 'desktop.manage_releases', { type: 'org', org: orgContext(ctx.org) })) {
    throw new AppError('forbidden');
  }
  await requireInstallAdmin(deps.db, ctx.org.id, ctx.actor.orgRole);
}

function storageOf(deps: ReleaseDeps): Storage {
  if (!deps.storage) throw new AppError('desktop_storage_missing');
  return deps.storage;
}

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

/** What a file is on a platform; null when it does not belong there. */
export function fileKind(platform: DesktopPlatform, name: string): DesktopFileKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.blockmap')) {
    const base = lower.slice(0, -'.blockmap'.length);
    return fileKind(platform, base) && !base.endsWith('.blockmap') ? 'blockmap' : null;
  }
  if (platform === 'win') return lower.endsWith('.exe') ? 'installer' : null;
  if (lower.endsWith('.zip')) return 'update_zip';
  if (lower.endsWith('.dmg')) return 'dmg';
  return null;
}

/** The version in an electron-builder file name: Crewhall-Setup-0.2.5.exe, Crewhall-0.2.5-mac.zip. */
export function versionOf(name: string): string | null {
  const base = name.replace(/\.blockmap$/i, '').replace(/(-mac)?\.(exe|zip|dmg)$/i, '');
  const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(base);
  return m ? m[1]! : null;
}

const keyOf = (deps: ReleaseDeps, platform: DesktopPlatform, file: string) =>
  `${deps.env.DESKTOP_UPDATES_S3_PREFIX}${platform}/${file}`;

async function s3Feed(deps: ReleaseDeps, storage: Storage, platform: DesktopPlatform) {
  const text = await s3Source(storage, deps.env.DESKTOP_UPDATES_S3_PREFIX).readText(
    platform,
    DESKTOP_FEED_FILE[platform],
  );
  const feed = text === null ? null : parseFeed(text);
  return feed?.version ? feed : null;
}

async function folderRelease(deps: ReleaseDeps, platform: DesktopPlatform) {
  const dir = deps.env.DESKTOP_UPDATES_DIR;
  return dir ? readRelease(dirSource(dir), platform) : null;
}

export async function platformReleases(
  deps: ReleaseDeps,
  platform: DesktopPlatform,
): Promise<DesktopPlatformReleases> {
  const folder = await folderRelease(deps, platform);
  const storage = deps.storage;
  const feed = storage ? await s3Feed(deps, storage, platform) : null;
  const sha = new Map((feed?.files ?? []).map((f) => [f.url, f.sha512 ?? null]));
  const prefix = keyOf(deps, platform, '');
  const objects = storage ? await storage.list(prefix) : [];
  const byVersion = new Map<string, DesktopReleaseVersion>();
  for (const o of objects) {
    const name = o.key.slice(prefix.length);
    if (!name || name.includes('/')) continue;
    const kind = fileKind(platform, name);
    const version = versionOf(name);
    if (!kind || !version) continue;
    const entry = byVersion.get(version) ?? {
      version,
      current: !folder && feed?.version === version,
      files: [],
      uploadedAt: null,
    };
    const uploadedAt = o.lastModified?.toISOString() ?? null;
    entry.files.push({
      name,
      kind,
      sizeBytes: o.size,
      sha512: sha.get(name) ?? null,
      uploadedAt,
    });
    if (uploadedAt && (!entry.uploadedAt || uploadedAt > entry.uploadedAt)) {
      entry.uploadedAt = uploadedAt;
    }
    byVersion.set(version, entry);
  }
  const versions = [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version));
  for (const v of versions) v.files.sort((a, b) => a.name.localeCompare(b.name));
  return {
    platform,
    servedFrom: folder ? 'folder' : feed ? 's3' : null,
    current: folder
      ? { version: folder.version, releasedAt: folder.releasedAt }
      : feed
        ? { version: feed.version!, releasedAt: feed.releaseDate }
        : null,
    versions,
  };
}

export async function listDesktopReleases(deps: ReleaseDeps): Promise<DesktopReleases> {
  const platforms = [];
  for (const p of DesktopPlatform.options) platforms.push(await platformReleases(deps, p));
  return { storage: !!deps.storage, platforms };
}

/** The file fits the platform and is not one the published feed points to. */
async function uploadable(
  deps: ReleaseDeps,
  input: { platform: DesktopPlatform; fileName: string },
): Promise<Storage> {
  const storage = storageOf(deps);
  if (!fileKind(input.platform, input.fileName) || !versionOf(input.fileName)) {
    throw new AppError('desktop_file_invalid', { fileName: input.fileName });
  }
  // The published files must stay what their sha512 in the feed says.
  const feed = await s3Feed(deps, storage, input.platform);
  if (feed?.files.some((f) => f.url === input.fileName) || feed?.path === input.fileName) {
    throw new AppError('desktop_release_in_use', { fileName: input.fileName });
  }
  return storage;
}

async function auditUpload(
  deps: ReleaseDeps,
  a: { orgId: string; userId: string },
  input: CreateDesktopUpload,
  req?: Pick<RequestInfo, 'ip' | 'userAgent'>,
) {
  await audit(
    deps.db,
    {
      orgId: a.orgId,
      actorId: a.userId,
      action: 'desktop.release.upload',
      targetType: 'desktop_file',
      targetId: `${input.platform}/${input.fileName}`,
      meta: { sizeBytes: input.sizeBytes },
    },
    req,
  );
}

/**
 * Multipart like Drive: a proxy in front of S3 (Cloudflare, 100 MB per request) refuses a whole
 * installer in one PUT. Every part's URL comes at once (16 at most for 1 GiB).
 */
export async function startDesktopUpload(
  deps: ReleaseDeps,
  a: { orgId: string; userId: string },
  input: CreateDesktopUpload,
  req?: Pick<RequestInfo, 'ip' | 'userAgent'>,
): Promise<DesktopMultipartUpload> {
  const storage = await uploadable(deps, input);
  const key = keyOf(deps, input.platform, input.fileName);
  const count = Math.max(1, Math.ceil(input.sizeBytes / DESKTOP_UPLOAD_PART_BYTES));
  const resumed = await resumable(storage, key, input.sizeBytes, count);
  const uploadId =
    resumed?.uploadId ??
    (await storage.createMultipart(key, input.contentType ?? 'application/octet-stream'));
  const have = new Set(resumed?.parts.map((p) => p.partNumber));
  const parts = [];
  for (let n = 1; n <= count; n++) {
    if (!have.has(n))
      parts.push({ partNumber: n, url: await storage.presignPart(key, uploadId, n) });
  }
  if (!resumed) await auditUpload(deps, a, input, req);
  return {
    uploadId,
    partSize: DESKTOP_UPLOAD_PART_BYTES,
    parts,
    ...(resumed
      ? {
          uploadedParts: resumed.parts.map((p) => ({
            partNumber: p.partNumber,
            etag: p.etag,
            sizeBytes: p.size,
          })),
        }
      : {}),
    expiresAt: new Date(Date.now() + PART_URL_TTL_SECONDS * 1000).toISOString(),
  };
}

/**
 * An unfinished upload of the same file to continue (after a reload or a dropped connection).
 * S3 keeps no declared size, so the parts it has must fit this size: every part but the last is
 * a full part, the last one the remainder. Other unfinished uploads of the key are dropped.
 */
async function resumable(storage: Storage, key: string, size: number, count: number) {
  const expected = (n: number) =>
    n < count ? DESKTOP_UPLOAD_PART_BYTES : size - (count - 1) * DESKTOP_UPLOAD_PART_BYTES;
  type Uploaded = { partNumber: number; size: number; etag: string }[];
  let chosen: { uploadId: string; parts: Uploaded } | null = null;
  for (const u of await storage.listMultipartUploads(key)) {
    const parts: Uploaded | null = chosen
      ? null
      : await storage.listParts(key, u.uploadId).catch(() => null);
    if (parts && parts.every((p) => p.partNumber <= count && p.size === expected(p.partNumber))) {
      chosen = { uploadId: u.uploadId, parts };
    } else {
      await storage.abortMultipart(key, u.uploadId).catch(() => undefined);
    }
  }
  return chosen;
}

export async function completeDesktopUpload(
  deps: ReleaseDeps,
  uploadId: string,
  input: CompleteDesktopUpload,
): Promise<DesktopReleaseFile> {
  const storage = await uploadable(deps, input);
  const key = keyOf(deps, input.platform, input.fileName);
  try {
    await storage.completeMultipart(key, uploadId, input.parts);
  } catch {
    // Unknown upload id, missing parts or wrong ETags.
    throw new AppError('desktop_file_missing', { fileName: input.fileName });
  }
  const head = await storage.head(key);
  if (!head) throw new AppError('desktop_file_missing', { fileName: input.fileName });
  if (head.size > DESKTOP_UPLOAD_MAX_BYTES) {
    await storage.delete(key);
    throw new AppError('desktop_file_invalid', { fileName: input.fileName, reason: 'too_large' });
  }
  return {
    name: input.fileName,
    kind: fileKind(input.platform, input.fileName)!,
    sizeBytes: head.size,
    sha512: null,
    uploadedAt: head.lastModified?.toISOString() ?? null,
  };
}

/** Best effort: an upload S3 no longer knows is already gone. */
export async function abortDesktopUpload(
  deps: ReleaseDeps,
  uploadId: string,
  input: { platform: DesktopPlatform; fileName: string },
) {
  const storage = storageOf(deps);
  await storage
    .abortMultipart(keyOf(deps, input.platform, input.fileName), uploadId)
    .catch(() => undefined);
  return {};
}

/** Base64 SHA-512 of a stored object, streamed (installers are large). */
async function sha512Of(storage: Storage, key: string): Promise<string> {
  const hash = createHash('sha512');
  for await (const chunk of await storage.getStream(key)) hash.update(chunk as Uint8Array);
  return hash.digest('base64');
}

/** electron-builder's feed format, which electron-updater reads. */
export function feedYaml(
  version: string,
  files: { url: string; sha512: string; size: number }[],
  releaseDate: Date,
): string {
  const main = files[0]!;
  return [
    `version: ${version}`,
    'files:',
    ...files.flatMap((f) => [
      `  - url: ${f.url}`,
      `    sha512: ${f.sha512}`,
      `    size: ${f.size}`,
    ]),
    `path: ${main.url}`,
    `sha512: ${main.sha512}`,
    `releaseDate: '${releaseDate.toISOString()}'`,
    '',
  ].join('\n');
}

export async function publishDesktopRelease(
  deps: ReleaseDeps,
  a: { orgId: string; userId: string },
  input: PublishDesktopRelease,
  req?: Pick<RequestInfo, 'ip' | 'userAgent'>,
): Promise<DesktopPlatformReleases> {
  const storage = storageOf(deps);
  const { platform } = input;
  if (await folderRelease(deps, platform)) throw new AppError('desktop_served_from_folder');
  const wanted = platform === 'win' ? 'installer' : 'update_zip';
  if (fileKind(platform, input.installer) !== wanted) {
    throw new AppError('desktop_file_invalid', { fileName: input.installer });
  }
  if (input.dmg && (platform !== 'mac' || fileKind(platform, input.dmg) !== 'dmg')) {
    throw new AppError('desktop_file_invalid', { fileName: input.dmg });
  }
  const version = input.version ?? versionOf(input.installer);
  if (!version || !SEMVER.test(version)) {
    throw new AppError('desktop_version_invalid', { fileName: input.installer });
  }
  const files = [];
  for (const name of [input.installer, ...(input.dmg ? [input.dmg] : [])]) {
    const key = keyOf(deps, platform, name);
    const head = await storage.head(key);
    if (!head) throw new AppError('desktop_file_missing', { fileName: name });
    files.push({ url: name, sha512: await sha512Of(storage, key), size: head.size });
  }
  const previous = (await s3Feed(deps, storage, platform))?.version ?? null;
  await storage.put(
    keyOf(deps, platform, DESKTOP_FEED_FILE[platform]),
    Buffer.from(feedYaml(version, files, new Date()), 'utf8'),
    'text/yaml; charset=utf-8',
  );
  // Bootstrap and Yönetim › Genel show the new version at once.
  resetDesktopCache();
  await audit(
    deps.db,
    {
      orgId: a.orgId,
      actorId: a.userId,
      action: 'desktop.release.publish',
      targetType: 'desktop_release',
      targetId: `${platform}/${version}`,
      meta: {
        previous,
        rollback: previous !== null && compareVersions(version, previous) < 0,
        files: files.map((f) => f.url),
      },
    },
    req,
  );
  return platformReleases(deps, platform);
}

export async function deleteDesktopRelease(
  deps: ReleaseDeps,
  a: { orgId: string; userId: string },
  input: { platform: string; version: string; blockmaps: boolean },
  req?: Pick<RequestInfo, 'ip' | 'userAgent'>,
): Promise<DesktopPlatformReleases> {
  const storage = storageOf(deps);
  const platform = DesktopPlatform.safeParse(input.platform);
  if (!platform.success) throw new AppError('not_found');
  if (!SEMVER.test(input.version)) throw new AppError('desktop_version_invalid');
  const state = await platformReleases(deps, platform.data);
  const entry = state.versions.find((v) => v.version === input.version);
  if (!entry) throw new AppError('not_found');
  if (entry.current) throw new AppError('desktop_release_in_use', { version: input.version });
  // Blockmaps stay by default: an app still on this version needs its blockmap to update by
  // difference.
  const doomed = entry.files.filter((f) => input.blockmaps || f.kind !== 'blockmap');
  for (const f of doomed) await storage.delete(keyOf(deps, platform.data, f.name));
  resetDesktopCache();
  await audit(
    deps.db,
    {
      orgId: a.orgId,
      actorId: a.userId,
      action: 'desktop.release.delete',
      targetType: 'desktop_release',
      targetId: `${platform.data}/${input.version}`,
      meta: { files: doomed.map((f) => f.name) },
    },
    req,
  );
  return platformReleases(deps, platform.data);
}
