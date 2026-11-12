import { createFileRoute } from '@tanstack/react-router';
import { AccessPage } from '@/components/vault/AccessPage';

/** Space vault access (design 8.10). */
export const Route = createFileRoute('/_app/vault/$vaultId/access')({
  component: function VaultAccess() {
    return <AccessPage vaultId={Route.useParams().vaultId} />;
  },
});
