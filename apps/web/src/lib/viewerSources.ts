import { api } from '@/lib/api';
import { type ViewerSource } from '@/lib/viewer';

/** Viewer items for Drive files wherever they show up (board cards, page links, Drive). */
export function driveNodeSource(node: {
  id: string;
  name: string;
  mime: string | null;
  sizeBytes?: number;
}): ViewerSource {
  const url = (disposition: 'inline' | 'attachment') =>
    api
      .call('getDownloadUrl', { params: { nodeId: node.id }, query: { disposition } })
      .then((r) => r.url);
  return {
    key: `node:${node.id}`,
    name: node.name,
    mime: node.mime,
    sizeBytes: node.sizeBytes,
    url: () => url('inline'),
    download: () => url('attachment'),
  };
}
