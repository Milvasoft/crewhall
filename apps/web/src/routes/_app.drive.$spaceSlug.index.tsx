import { createFileRoute } from '@tanstack/react-router';
import { FolderPage } from '@/features/drive/pages/FolderPage';
import { nodesQuery } from '@/features/drive/api';
import { driveSearch } from '@/features/drive/search';
import { cachedSpaceId, warm } from '@/lib/prefetch';

export const Route = createFileRoute('/_app/drive/$spaceSlug/')({
  validateSearch: driveSearch,
  // Hover or click: the root listing in FolderPage's default order.
  loader: ({ params, context: { queryClient } }) => {
    const spaceId = cachedSpaceId(queryClient, params.spaceSlug);
    if (spaceId) warm(queryClient, nodesQuery(spaceId, null, { sort: 'name', order: 'asc' }));
  },
  component: function DriveRoot() {
    const { spaceSlug } = Route.useParams();
    return <FolderPage spaceSlug={spaceSlug} folderId={null} search={Route.useSearch()} />;
  },
});
