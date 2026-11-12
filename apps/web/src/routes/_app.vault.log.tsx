import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { LogPage } from '@/components/vault/LogPage';

/** Access log (design 8.11). */
export const Route = createFileRoute('/_app/vault/log')({
  validateSearch: z.object({ vaultId: z.uuid().optional().catch(undefined) }),
  component: function VaultLog() {
    return <LogPage vaultId={Route.useSearch().vaultId} />;
  },
});
