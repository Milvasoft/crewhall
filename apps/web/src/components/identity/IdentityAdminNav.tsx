import { useQuery } from '@tanstack/react-query';
import { McpAdminNav } from '@/components/mcp/McpNav';
import { NavItem } from '@/components/spaces/SpaceSidebar';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useModuleEnabled } from '@/lib/identity/modules';
import { useMe } from '@/lib/session';
import { identityProvidersQuery, oidcProviderQuery } from '@/lib/identity/queries';
import { useBootstrap } from '@/lib/useBranding';

/** Yönetim sidebar: "Güvenlik" (policies, SSO apps, MCP when on) and "Sistem" groups (9.11-9.14). */
export function IdentityAdminNav() {
  const { t } = useI18n();
  const mcpOn = useModuleEnabled('mcp');
  const installAdmin = useMe()?.installAdmin === true;
  // A server that lists its capabilities and lacks this one cannot manage desktop releases.
  const capabilities = useBootstrap().data?.server?.capabilities;
  const desktopReleases = !capabilities || capabilities.includes('desktop.releases');
  const oidc = useQuery(oidcProviderQuery);
  const providers = useQuery(identityProvidersQuery);
  const failing = providers.data?.items.some((p) => p.enabled && p.status.lastTestOk === false);
  return (
    <>
      <div className="eyebrow shrink-0 px-2.5 pt-3.5 pb-1.5">{t('identity.nav.group')}</div>
      <NavItem icon="shield" to="/admin/security" label={t('identity.nav.security')} />
      <NavItem
        icon="key"
        to="/admin/sso"
        label={t('identity.nav.sso')}
        count={oidc.data?.clients.length || undefined}
      />
      <NavItem icon="flag" to="/admin/compliance" label={t('identity.nav.compliance')} />
      {mcpOn ? <McpAdminNav grouped={false} /> : null}
      <NavItem icon="globe" to="/admin/federation" label={t('federation.nav')} />
      <div className="eyebrow shrink-0 px-2.5 pt-3.5 pb-1.5">{t('identity.nav.systemGroup')}</div>
      <NavItem icon="layers" to="/admin/plugins" label={t('plugins.nav')} />
      <NavItem
        icon="plug"
        to="/admin/integrations"
        label={t('identity.nav.integrations')}
        exact={false}
        count={
          failing ? (
            <span
              role="img"
              aria-label={t('identity.idp.status.error')}
              className="inline-block size-2 rounded-full bg-danger"
            />
          ) : undefined
        }
      />
      {installAdmin ? (
        <>
          <NavItem icon="archive" to="/admin/backups" label={t('identity.nav.backups')} />
          {desktopReleases ? (
            <NavItem icon="laptop" to="/admin/desktop" label={t('admin.desktop.nav')} />
          ) : null}
        </>
      ) : null}
    </>
  );
}
