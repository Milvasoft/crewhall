import { createFileRoute } from '@tanstack/react-router';
import { favoritesQuery, recentQuery } from '@/features/drive/api';
import { RecentPage } from '@/features/drive/pages/RecentPage';
import { warm } from '@/lib/prefetch';

export const Route = createFileRoute('/_app/drive/recent')({
  loader: ({ context: { queryClient } }) => {
    warm(queryClient, recentQuery);
    warm(queryClient, favoritesQuery);
  },
  component: RecentPage,
});
