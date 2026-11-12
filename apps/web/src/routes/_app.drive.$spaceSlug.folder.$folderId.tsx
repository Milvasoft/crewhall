import { createFileRoute } from '@tanstack/react-router';
import { FolderPage } from '@/features/drive/pages/FolderPage';
import { nodeQuery, nodesQuery } from '@/features/drive/api';
import { driveSearch } from '@/features/drive/search';
import { cachedSpaceId, warm } from '@/lib/prefetch';

export const Route = createFileRoute('/_app/drive/$spaceSlug/folder/$folderId')({
  validateSearch: driveSearch,
  // Hover or click: the folder and its listing in FolderPage's default order.
  loader: ({ params, context: { queryClient } }) => {
    warm(queryClient, nodeQuery(params.folderId));
    const spaceId = cachedSpaceId(queryClient, params.spaceSlug);
    if (spaceId) {
      warm(queryClient, nodesQuery(spaceId, params.folderId, { sort: 'name', order: 'asc' }));
    }
  },
  component: function DriveFolder() {
    const { spaceSlug, folderId } = Route.useParams();
    // Not keyed by folder: the page (and its sidebar tree) stays mounted from folder to folder;
    // FolderPage starts its own state over when the folder changes.
    return <FolderPage spaceSlug={spaceSlug} folderId={folderId} search={Route.useSearch()} />;
  },
});
