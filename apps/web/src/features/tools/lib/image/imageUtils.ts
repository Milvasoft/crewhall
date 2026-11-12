// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/lib/image/imageUtils.ts. See THIRD_PARTY.md.
/**
 * Shared, dependency-free image helpers for the image tools. Everything runs in
 * the browser (canvas / FileReader), images are never uploaded.
 */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export type ImageInputErrorCode = 'empty' | 'notImage' | 'notBase64';

/** Thrown by `parseImageInput`; `code` lets the UI show a translated message. */
export class ImageInputError extends Error {
  readonly code: ImageInputErrorCode;

  constructor(code: ImageInputErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'ImageInputError';
  }
}

export interface ParsedDataUri {
  mime: string;
  base64: string;
  dataUri: string;
}

/**
 * Accepts a full data URI (`data:image/png;base64,…`) or a bare base64 string
 * (assumed PNG). Returns the normalized parts. Pure and testable.
 */
export function parseImageInput(input: string): ParsedDataUri {
  const trimmed = input.trim().replace(/\s+/g, '');
  if (!trimmed) throw new ImageInputError('empty', 'No image data provided.');

  const match = trimmed.match(/^data:([^;,]+)(;base64)?,(.*)$/i);
  if (match) {
    // Groups 1 and 3 are not optional, so they exist whenever the regex matches.
    const mime = match[1]!;
    const base64 = match[3]!;
    if (!/^image\//i.test(mime)) {
      throw new ImageInputError('notImage', 'Data URI is not an image.');
    }
    return { mime, base64, dataUri: trimmed };
  }

  // Bare base64 → assume PNG.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new ImageInputError('notBase64', 'Input is not a data URI or valid base64.');
  }
  const mime = 'image/png';
  return { mime, base64: trimmed, dataUri: `data:${mime};base64,${trimmed}` };
}

/** Load a File as a data URI. */
export function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

/** Load an image element from any src (URL or data URI). */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode the image.'));
    img.src = src;
  });
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Encoding failed.'))),
      type,
      quality,
    );
  });
}

/** Trigger a client-side download of a Blob or object URL. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
