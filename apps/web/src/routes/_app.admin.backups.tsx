import { createFileRoute, redirect } from '@tanstack/react-router';
import { BackupsPage } from '@/components/identity/BackupsPage';
import { meQuery } from '@/lib/queries';

/** Yönetim › Yedekler (roadmap 3): the install admin only. */
export const Route = createFileRoute('/_app/admin/backups')({
  beforeLoad: async ({ context: { queryClient } }) => {
    const me = await queryClient.ensureQueryData(meQuery);
    if (!me.installAdmin) throw redirect({ to: '/admin/general' });
  },
  component: BackupsPage,
});
