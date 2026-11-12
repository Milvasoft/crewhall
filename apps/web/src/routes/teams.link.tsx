import { createFileRoute, redirect } from '@tanstack/react-router';
import { TeamsLinkPage } from '@/components/microsoft/TeamsPages';
import { isApiError } from '@/lib/api';
import { meQuery } from '@/lib/queries';

/** The Teams message extension's sign-in popup: links the Teams person to this account. */
export const Route = createFileRoute('/teams/link')({
  beforeLoad: async ({ context: { queryClient }, location }) => {
    try {
      await queryClient.ensureQueryData(meQuery);
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) {
        throw redirect({ to: '/login', search: { redirect: location.href } });
      }
      throw e;
    }
  },
  component: TeamsLinkPage,
});
