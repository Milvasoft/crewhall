import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { useCallback } from 'react';
import { OfficeEditor } from '@/components/office/OfficeEditor';
import { api } from '@/lib/api';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useSpaces } from '@/lib/useSpaces';
import { folderLocation } from '@/features/drive/paths';

/** Office editor for a Drive file: `/office/<nodeId>` (web and desktop). */
export const Route = createFileRoute('/_app/office/$nodeId')({
  component: function OfficeRoute() {
    const { nodeId } = Route.useParams();
    const navigate = useNavigate();
    const router = useRouter();
    const { items: spaces } = useSpaces();
    const node = useQuery({
      queryKey: ['office', 'node', nodeId],
      queryFn: () => api.call('getNode', { params: { nodeId } }),
    });
    useDocumentTitle(node.data?.name);
    const close = useCallback(() => {
      const slug = spaces.find((s) => s.id === node.data?.spaceId)?.slug;
      if (slug && node.data) {
        void navigate(folderLocation(slug, node.data.parentId, { preview: node.data.id }));
      } else {
        router.history.back();
      }
    }, [spaces, node.data, navigate, router]);
    return <OfficeEditor nodeId={nodeId} onClose={close} />;
  },
});
