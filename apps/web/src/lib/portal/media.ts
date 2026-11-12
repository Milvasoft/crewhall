import { type PortalMedia } from '@crewhall/shared';
import { ApiError, api } from '@/lib/api';
import { config } from '@/config';

/**
 * Media for editors: stored srcs are site paths (`/media/img/a.png`); the Hub serves the bytes
 * to signed-in editors at GET /api/v1/portal/sites/:siteId/files/<path below /media/>.
 */
export function hubMediaUrl(siteId: string, src: string | null | undefined): string {
  if (!src) return '';
  if (/^(https?:|data:|blob:)/.test(src)) return src;
  if (!src.startsWith('/media/')) return src;
  return `${config.apiUrl}/api/v1/portal/sites/${siteId}/files/${src.slice('/media/'.length)}`;
}

export const isImage = (m: Pick<PortalMedia, 'mime'>) => Boolean(m.mime?.startsWith('image/'));

/** Raw upload: PUT the bytes to the media's content route (cookie session). */
async function putBytes(uploadPath: string, file: File): Promise<void> {
  const res = await fetch(new URL(uploadPath, config.apiUrl), {
    method: 'PUT',
    body: file,
    credentials: 'include',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
  });
  if (!res.ok) {
    throw new ApiError(
      res.status,
      res.status === 409 ? 'conflict' : 'internal',
      `HTTP ${res.status}`,
    );
  }
}

/** New media: createPortalMedia, then the bytes. Returns the media (path stays the same). */
export async function uploadPortalFile(
  siteId: string,
  file: File,
  folder = 'uploads',
): Promise<PortalMedia> {
  const { media, uploadPath } = await api.call('createPortalMedia', {
    params: { siteId },
    body: { fileName: file.name, mime: file.type || null, size: file.size, folder },
  });
  await putBytes(uploadPath, file);
  return { ...media, status: 'ready', size: file.size };
}

/** "Değiştir": new bytes at the same permanent path. */
export function replacePortalFile(mediaId: string, file: File): Promise<void> {
  return putBytes(`/api/v1/portal/media/${mediaId}/content`, file);
}
