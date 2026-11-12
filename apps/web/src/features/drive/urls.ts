import { RAW_PATHS, type PreviewKind } from '@crewhall/shared';
import { config } from '@/config';

/** `<img src>` for a node's preview: the server answers with a 302 to a signed URL. */
export function rawPreviewUrl(
  nodeId: string,
  kind: PreviewKind = 'thumb_256',
  version?: number,
): string {
  const path = RAW_PATHS.preview.replace(':nodeId', nodeId);
  return `${config.apiUrl}${path}?kind=${kind}${version ? `&v=${version}` : ''}`;
}
