import { createFileRoute } from '@tanstack/react-router';
import { TrashPage } from '@/features/drive/pages/TrashPage';

export const Route = createFileRoute('/_app/drive/$spaceSlug/trash')({
  component: function DriveTrash() {
    return <TrashPage spaceSlug={Route.useParams().spaceSlug} />;
  },
});
