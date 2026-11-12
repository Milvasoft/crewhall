import sharp from 'sharp';
import type { ExportFile } from './collect';

/**
 * Images for Word and PDF (roadmap 6): measured, scaled to the page width and converted when
 * the format cannot embed them as they are (WebP, AVIF, SVG; PDF takes only PNG and JPEG).
 */

export interface PreparedImage {
  type: 'png' | 'jpg' | 'gif';
  data: Buffer;
  /** Display size in pixels (96 dpi), within the width limit. */
  width: number;
  height: number;
}

export async function prepareImage(
  file: ExportFile,
  target: 'docx' | 'pdf',
  maxWidth: number,
): Promise<PreparedImage | null> {
  if (!file.isImage) return null;
  try {
    const meta = await sharp(file.data, { animated: false }).metadata();
    const format = meta.format;
    const native =
      format === 'png' || format === 'jpeg'
        ? format
        : target === 'docx' && format === 'gif'
          ? format
          : null;
    const data = native ? file.data : await sharp(file.data, { animated: false }).png().toBuffer();
    const type = native === 'jpeg' ? 'jpg' : ((native ?? 'png') as PreparedImage['type']);
    const w = meta.width ?? maxWidth;
    const h = meta.height ?? Math.round(maxWidth * 0.6);
    const scale = Math.min(1, maxWidth / w);
    return { type, data, width: Math.round(w * scale), height: Math.round(h * scale) };
  } catch {
    return null;
  }
}
