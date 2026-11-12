import { createFileRoute } from '@tanstack/react-router';
import { StatsPage } from '@/components/stats/StatsPage';

/** Yönetim › İstatistikler (roadmap 21); the admin layout already keeps members out. */
export const Route = createFileRoute('/_app/admin/stats')({
  component: StatsPage,
});
