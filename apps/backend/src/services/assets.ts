import { and, eq } from 'drizzle-orm';
import sharp, { type Metadata } from 'sharp';
import { mediaAssets, newId, organizations, users, type DbOrTx } from '@crewhall/db';
import {
  IMAGE_UPLOAD_MAX_BYTES,
  RAW_PATHS,
  type BrandAssetSlot,
  type ImageUpload,
} from '@crewhall/shared';
import type { Deps } from '../deps';
import { AppError } from '../http/errors';
import type { OrgRow } from '../http/types';
import { requireStorage } from './drive/files';

/**
 * Profile photos and brand images (H5). The upload is decoded, checked with sharp (real image
 * types only, never SVG), cropped and resized, stored in S3 under `assets/` and served from
 * `/api/assets/<id>` without a session. Replacing an image deletes the previous file.
 */

export type AssetKind = 'avatar' | BrandAssetSlot;

const ALLOWED = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'heif']);
/** Decompression bombs: refuse anything above ~50 megapixels. */
const MAX_PIXELS = 50_000_000;

interface Processed {
  data: Buffer;
  mime: string;
  ext: string;
  width: number;
  height: number;
}

export function decodeImage(input: ImageUpload): Buffer {
  const b64 = input.data.replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) throw new AppError('image_invalid');
  if (buf.length > IMAGE_UPLOAD_MAX_BYTES) throw new AppError('image_too_large');
  return buf;
}

/** Turns an upload into the stored file for its slot. */
export async function processImage(
  raw: Buffer,
  kind: AssetKind,
  crop?: ImageUpload['crop'],
): Promise<Processed> {
  let meta: Metadata;
  try {
    meta = await sharp(raw, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw new AppError('image_invalid');
  }
  if (!meta.format || !ALLOWED.has(meta.format) || !meta.width || !meta.height) {
    throw new AppError('image_invalid', { format: meta.format ?? null });
  }
  // EXIF orientation first, so crop coordinates match what the person saw.
  let img = sharp(raw, { limitInputPixels: MAX_PIXELS, animated: false }).rotate();
  const oriented = (meta.orientation ?? 1) >= 5;
  const w = oriented ? meta.height : meta.width;
  const h = oriented ? meta.width : meta.height;
  if (crop) {
    if (crop.x + crop.size > w || crop.y + crop.size > h) {
      throw new AppError('validation_failed', {
        in: 'body',
        issues: [{ path: ['crop'], code: 'out_of_bounds', message: 'crop outside the image' }],
      });
    }
    img = sharp(await img.toBuffer()).extract({
      left: crop.x,
      top: crop.y,
      width: crop.size,
      height: crop.size,
    });
  }
  try {
    switch (kind) {
      case 'avatar': {
        // JPEG: shown in e-mails too, where WebP is not safe.
        const { data, info } = await img
          .resize(512, 512, { fit: 'cover', position: 'attention' })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: 85, mozjpeg: true })
          .toBuffer({ resolveWithObject: true });
        return { data, mime: 'image/jpeg', ext: 'jpg', width: info.width, height: info.height };
      }
      case 'logoLight':
      case 'logoDark': {
        const { data, info } = await img
          .resize(1024, 256, { fit: 'inside', withoutEnlargement: true })
          .png({ compressionLevel: 9 })
          .toBuffer({ resolveWithObject: true });
        return { data, mime: 'image/png', ext: 'png', width: info.width, height: info.height };
      }
      case 'mark':
      case 'favicon': {
        const size = kind === 'mark' ? 512 : 64;
        const { data, info } = await img
          .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png({ compressionLevel: 9 })
          .toBuffer({ resolveWithObject: true });
        return { data, mime: 'image/png', ext: 'png', width: info.width, height: info.height };
      }
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('image_invalid');
  }
}

export const assetUrl = (apiUrl: string, id: string) =>
  `${apiUrl.replace(/\/$/, '')}${RAW_PATHS.asset.replace(':assetId', id)}`;

/** The asset id inside one of our URLs, else null (external or old URLs are left alone). */
function assetIdOf(apiUrl: string, url: string | null | undefined): string | null {
  if (!url) return null;
  const prefix = assetUrl(apiUrl, '');
  if (!url.startsWith(prefix)) return null;
  const id = url.slice(prefix.length);
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

async function store(
  deps: Pick<Deps, 'db' | 'storage'>,
  kind: AssetKind,
  file: Processed,
  owner: { orgId: string | null; userId: string | null },
) {
  const storage = requireStorage(deps);
  const id = newId();
  const storageKey = `assets/${id}.${file.ext}`;
  await storage.put(storageKey, file.data, file.mime);
  await deps.db.insert(mediaAssets).values({
    id,
    orgId: owner.orgId,
    ownerUserId: owner.userId,
    kind,
    storageKey,
    mime: file.mime,
    sizeBytes: file.data.length,
    width: file.width,
    height: file.height,
  });
  return id;
}

/** Removes an asset we stored (no-op for external URLs). */
async function dropAsset(deps: Pick<Deps, 'db' | 'storage' | 'env'>, url: string | null) {
  const id = assetIdOf(deps.env.API_URL, url);
  if (!id) return;
  const [row] = await deps.db.delete(mediaAssets).where(eq(mediaAssets.id, id)).returning();
  if (row && deps.storage) await deps.storage.delete(row.storageKey).catch(() => undefined);
}

export async function setAvatar(
  deps: Pick<Deps, 'db' | 'storage' | 'env'>,
  user: { id: string; image?: string | null },
  orgId: string | null,
  input: ImageUpload,
) {
  const file = await processImage(decodeImage(input), 'avatar', input.crop);
  const id = await store(deps, 'avatar', file, { orgId, userId: user.id });
  const imageUrl = assetUrl(deps.env.API_URL, id);
  const [before] = await deps.db
    .select({ image: users.image })
    .from(users)
    .where(eq(users.id, user.id));
  await deps.db.update(users).set({ image: imageUrl }).where(eq(users.id, user.id));
  await dropAsset(deps, before?.image ?? null);
  return { imageUrl };
}

export async function removeAvatar(deps: Pick<Deps, 'db' | 'storage' | 'env'>, userId: string) {
  const [before] = await deps.db
    .select({ image: users.image })
    .from(users)
    .where(eq(users.id, userId));
  await deps.db.update(users).set({ image: null }).where(eq(users.id, userId));
  await dropAsset(deps, before?.image ?? null);
}

const FIELD: Record<BrandAssetSlot, 'logoLightUrl' | 'logoDarkUrl' | 'markUrl' | 'faviconUrl'> = {
  logoLight: 'logoLightUrl',
  logoDark: 'logoDarkUrl',
  mark: 'markUrl',
  favicon: 'faviconUrl',
};

export async function setBrandAsset(
  deps: Pick<Deps, 'db' | 'storage' | 'env'>,
  org: OrgRow,
  userId: string,
  slot: BrandAssetSlot,
  input: ImageUpload,
) {
  const file = await processImage(decodeImage(input), slot, input.crop);
  const id = await store(deps, slot, file, { orgId: org.id, userId });
  return replaceBrandField(deps, org, slot, assetUrl(deps.env.API_URL, id));
}

export async function clearBrandAsset(
  deps: Pick<Deps, 'db' | 'storage' | 'env'>,
  org: OrgRow,
  slot: BrandAssetSlot,
) {
  return replaceBrandField(deps, org, slot, null);
}

async function replaceBrandField(
  deps: Pick<Deps, 'db' | 'storage' | 'env'>,
  org: OrgRow,
  slot: BrandAssetSlot,
  url: string | null,
) {
  const [current] = await deps.db
    .select({ branding: organizations.branding })
    .from(organizations)
    .where(eq(organizations.id, org.id));
  const before = current?.branding[FIELD[slot]] ?? null;
  const branding = { ...(current?.branding ?? org.branding), [FIELD[slot]]: url };
  const [row] = await deps.db
    .update(organizations)
    .set({ branding })
    .where(eq(organizations.id, org.id))
    .returning({ branding: organizations.branding });
  if (before !== url) await dropAsset(deps, before);
  return row!.branding;
}

/** For the public route: the stored file of an asset. */
export async function assetFile(db: DbOrTx, id: string) {
  const [row] = await db
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.id, id)));
  return row ?? null;
}
