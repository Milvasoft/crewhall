import type { MountItem } from '@crewhall/shared';

/**
 * One external storage (SharePoint library, OneDrive, SMB share) as Drive sees it. Paths are
 * relative to the mount root, `/`-separated, without leading or trailing slashes.
 */
export interface MountAdapter {
  list(path: string): Promise<MountItem[]>;
  /** File content and what is known about it. */
  read(path: string): Promise<{ name: string; mime: string | null; size: number | null; body: Buffer }>;
  /** Writes `name` into `folder`; an existing name gets a free one (rename, never overwrite). */
  write(folder: string, name: string, content: Buffer, mime: string | null): Promise<MountItem>;
  mkdir(folder: string, name: string): Promise<MountItem>;
  /** Throws when the storage cannot be reached or listed. */
  check(): Promise<void>;
}

export const joinPath = (...parts: string[]) =>
  parts
    .flatMap((p) => p.split('/'))
    .filter((s) => s.length > 0)
    .join('/');

export const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? '';

/** A simple MIME guess from the extension, for storages that do not keep one (SMB). */
const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
};

export function mimeOf(name: string): string | null {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return MIME[ext] ?? null;
}
