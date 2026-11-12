import { createFileRoute } from '@tanstack/react-router';
import { PublicVaultSharePage } from '@/components/vault/PublicVaultShare';

/** One-time vault link (roadmap 20): no app shell and no session; the key is in the fragment. */
export const Route = createFileRoute('/vault-share/$token')({
  component: function PublicVaultShareRoute() {
    const { token } = Route.useParams();
    return <PublicVaultSharePage token={token} />;
  },
});
