import { z } from 'zod';
import { ERROR_CODES } from '../errors';

export const Id = z.uuid();
export type Id = z.infer<typeof Id>;

export const Timestamp = z.iso.datetime({ offset: true });

export const Locale = z.enum(['tr', 'en']);
export type Locale = z.infer<typeof Locale>;

/** Every error response body: `code` doubles as the i18n key under `errors.*`. */
export const ApiErrorBody = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

/** Cursor pagination: request `?cursor=&limit=`, response `{ items, nextCursor }`. */
export const PageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type PageQuery = z.infer<typeof PageQuery>;

export const page = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });

/** Profile photos and brand images (H5): up to 8 MB before encoding. */
export const IMAGE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

/**
 * An image sent inline as base64 (JPEG, PNG, WebP, GIF or AVIF; SVG is refused). `crop` is a
 * square in the original image's pixels (the cropper's result); without it the server crops
 * to the centre where a square is needed.
 */
export const ImageUpload = z.object({
  data: z
    .string()
    .min(1)
    .max(Math.ceil((IMAGE_UPLOAD_MAX_BYTES * 4) / 3) + 4),
  crop: z
    .object({
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      size: z.number().int().min(16),
    })
    .optional(),
});
export type ImageUpload = z.infer<typeof ImageUpload>;
