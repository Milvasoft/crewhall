import { z } from 'zod';

/**
 * Desktop app releases (apps/desktop). Each organization's server hands out the installers and the
 * electron-updater feed itself, from DESKTOP_UPDATES_DIR: there is no separate update server.
 */

export const DesktopPlatform = z.enum(['win', 'mac']);
export type DesktopPlatform = z.infer<typeof DesktopPlatform>;

/** The feed file electron-updater reads first, per platform. */
export const DESKTOP_FEED_FILE: Record<DesktopPlatform, string> = {
  win: 'latest.yml',
  mac: 'latest-mac.yml',
};

/**
 * No session (installers are not secret), rate limited per IP, Range supported. 404 when the
 * server has no release for the platform: the app reads that as "no update".
 */
export const DESKTOP_RAW_PATHS = {
  updateFile: '/api/v1/desktop/updates/:platform/:file',
} as const;

/** The generic feed URL the desktop app gives electron-updater for its org's server. */
export function desktopFeedUrl(origin: string, platform: DesktopPlatform): string {
  return `${origin.replace(/\/+$/, '')}/api/v1/desktop/updates/${platform}/`;
}

export const DesktopRelease = z.object({
  platform: DesktopPlatform,
  version: z.string(),
  /** Installer to download (Windows .exe, macOS .dmg when there is one, else .zip). */
  url: z.string(),
  sizeBytes: z.number().int().nullable(),
  releasedAt: z.string().nullable(),
});
export type DesktopRelease = z.infer<typeof DesktopRelease>;

/** In the public bootstrap when the server hosts desktop releases ("Masaüstü uygulamasını indir"). */
export const DesktopInfo = z.object({
  /** Newest version across platforms. */
  version: z.string(),
  platforms: z.array(DesktopRelease),
});
export type DesktopInfo = z.infer<typeof DesktopInfo>;

// ---------------------------------------------------------------------------------------
// Yönetim › Masaüstü sürümleri: files uploaded to the S3 bucket, feed written by the server
// ---------------------------------------------------------------------------------------

/** Largest release file accepted (installers are ~110 MB). */
export const DESKTOP_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * A plain file name: no path, no leading dot, and one of the release extensions
 * (.exe, .zip, .dmg, and their .blockmap).
 */
export const DesktopFileName = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.(exe|zip|dmg)(\.blockmap)?$/)
  .refine((n) => !n.includes('..'), { message: 'not a plain file name' });

export const DesktopFileKind = z.enum(['installer', 'blockmap', 'update_zip', 'dmg']);
export type DesktopFileKind = z.infer<typeof DesktopFileKind>;

export const DesktopReleaseFile = z.object({
  name: z.string(),
  kind: DesktopFileKind,
  sizeBytes: z.number().int(),
  /** Base64 SHA-512 as in latest.yml; known for the files of the published version. */
  sha512: z.string().nullable(),
  uploadedAt: z.string().nullable(),
});
export type DesktopReleaseFile = z.infer<typeof DesktopReleaseFile>;

export const DesktopReleaseVersion = z.object({
  /** Read from the file names (Crewhall-Setup-0.2.5.exe, Crewhall-0.2.5-mac.zip). */
  version: z.string(),
  /** The version the feed points to now. */
  current: z.boolean(),
  files: z.array(DesktopReleaseFile),
  /** Newest upload among its files. */
  uploadedAt: z.string().nullable(),
});
export type DesktopReleaseVersion = z.infer<typeof DesktopReleaseVersion>;

export const DesktopPlatformReleases = z.object({
  platform: DesktopPlatform,
  /**
   * Where the app's feed comes from: 'folder' (DESKTOP_UPDATES_DIR, managed outside this page;
   * publishing here is refused), 's3', or null when there is no release yet.
   */
  servedFrom: z.enum(['folder', 's3']).nullable(),
  current: z.object({ version: z.string(), releasedAt: z.string().nullable() }).nullable(),
  /** Newest first. */
  versions: z.array(DesktopReleaseVersion),
});
export type DesktopPlatformReleases = z.infer<typeof DesktopPlatformReleases>;

export const DesktopReleases = z.object({
  /** S3 is configured; without it nothing can be uploaded. */
  storage: z.boolean(),
  platforms: z.array(DesktopPlatformReleases),
});
export type DesktopReleases = z.infer<typeof DesktopReleases>;

export const CreateDesktopUpload = z.object({
  platform: DesktopPlatform,
  fileName: DesktopFileName,
  sizeBytes: z.number().int().positive().max(DESKTOP_UPLOAD_MAX_BYTES),
  contentType: z.string().min(1).max(100).optional(),
});
export type CreateDesktopUpload = z.infer<typeof CreateDesktopUpload>;

/**
 * Writes the platform's feed (latest.yml / latest-mac.yml) for uploaded files. Publishing an
 * older version rolls back. `installer` is the .exe (Windows) or the -mac.zip (macOS); the
 * blockmap is found by name (`<installer>.blockmap`).
 */
export const PublishDesktopRelease = z.object({
  platform: DesktopPlatform,
  installer: DesktopFileName,
  /** macOS: the .dmg offered for download. */
  dmg: DesktopFileName.optional(),
  /** Default: read from the installer's file name. */
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/)
    .optional(),
});
export type PublishDesktopRelease = z.infer<typeof PublishDesktopRelease>;

export const DeleteDesktopReleaseQuery = z.object({
  /** Also delete its blockmaps; kept by default so older apps can still update by difference. */
  blockmaps: z.enum(['true', 'false']).optional(),
});
export type DeleteDesktopReleaseQuery = z.infer<typeof DeleteDesktopReleaseQuery>;

/**
 * Release files go up in parts like Drive: a proxy in front of S3 (Cloudflare: 100 MB per
 * request) refuses a ~110 MB installer in one PUT. A file smaller than a part is one part.
 */
export const DESKTOP_UPLOAD_PART_BYTES = 64 * 1024 * 1024;

/** PUT part `partNumber` (bytes from (n-1)·partSize) to its URL; keep the ETag of each answer. */
export const DesktopMultipartUpload = z.object({
  /** S3's multipart upload id; pass it back to complete or abort. */
  uploadId: z.string(),
  partSize: z.number().int().positive(),
  /** The parts still to send (all of them for a new upload). */
  parts: z.array(z.object({ partNumber: z.number().int().positive(), url: z.url() })),
  /**
   * Resuming: the same platform, file name and size had an unfinished upload, so its id comes
   * back with the parts S3 already has. Pass their ETags to complete along with the new ones.
   */
  uploadedParts: z
    .array(
      z.object({
        partNumber: z.number().int().positive(),
        etag: z.string(),
        sizeBytes: z.number().int(),
      }),
    )
    .optional(),
  expiresAt: z.string(),
});
export type DesktopMultipartUpload = z.infer<typeof DesktopMultipartUpload>;

export const CompleteDesktopUpload = z.object({
  platform: DesktopPlatform,
  fileName: DesktopFileName,
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1) }))
    .min(1)
    .max(10_000),
});
export type CompleteDesktopUpload = z.infer<typeof CompleteDesktopUpload>;

export const AbortDesktopUploadQuery = z.object({
  platform: DesktopPlatform,
  fileName: DesktopFileName,
});
export type AbortDesktopUploadQuery = z.infer<typeof AbortDesktopUploadQuery>;
