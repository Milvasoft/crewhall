import { createFileRoute } from '@tanstack/react-router';
import { PagesListView } from '@/components/wiki/PagesListView';

/** Pages › Son açılanlar: pages the person opened or edited, grouped by day. */
export const Route = createFileRoute('/_app/pages/recent')({
  component: function PagesRecent() {
    return <PagesListView mode="recent" />;
  },
});
