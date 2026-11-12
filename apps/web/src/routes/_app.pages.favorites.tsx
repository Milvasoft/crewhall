import { createFileRoute } from '@tanstack/react-router';
import { PagesListView } from '@/components/wiki/PagesListView';

/** Pages › Favoriler: starred pages across spaces (Drive's favorites). */
export const Route = createFileRoute('/_app/pages/favorites')({
  component: function PagesFavorites() {
    return <PagesListView mode="favorites" />;
  },
});
