import { EmptyState, Spinner } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { Workspace } from '@/components/shell/Workspace';
import { VaultSidebar } from '@/components/vault/VaultSidebar';
import { useI18n } from '@/lib/i18n/I18nContext';
import { vaultsQuery } from '@/lib/vault/api';

/** `/vault` opens the personal vault (or the first one). */
export const Route = createFileRoute('/_app/vault/')({
  component: function VaultIndex() {
    const { t } = useI18n();
    const vaults = useQuery(vaultsQuery);
    const first = vaults.data?.find((v) => v.kind === 'personal') ?? vaults.data?.[0];
    if (first) {
      return (
        <Navigate
          to="/vault/$vaultId/$category"
          params={{ vaultId: first.id, category: 'all' }}
          replace
        />
      );
    }
    return (
      <Workspace
        sidebar={<VaultSidebar vaults={vaults.data ?? []} />}
        crumbs={[{ label: t('vault.title') }]}
      >
        {vaults.isPending ? (
          <Spinner className="m-auto" />
        ) : (
          <EmptyState className="m-auto" icon="vault" title={t('vault.noPersonal')} />
        )}
      </Workspace>
    );
  },
});
