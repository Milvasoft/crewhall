import { createFileRoute, redirect } from '@tanstack/react-router';
import { DesktopReleasesPage } from '@/components/admin/DesktopReleasesPage';
import { meQuery } from '@/lib/queries';

/** Yönetim › Masaüstü sürümleri: the install admin only (the update files are server-wide). */
export const Route = createFileRoute('/_app/admin/desktop')({
  beforeLoad: async ({ context: { queryClient } }) => {
    const me = await queryClient.ensureQueryData(meQuery);
    if (!me.installAdmin) throw redirect({ to: '/admin/general' });
  },
  component: DesktopReleasesPage,
});
