import { useQuery } from '@tanstack/react-query';
import { NavItem } from '@/components/spaces/SpaceSidebar';
import { useI18n } from '@/lib/i18n/I18nContext';
import { mcpKeys, overviewQuery, orgConnectionsQuery } from '@/lib/mcp/queries';

/** Hesabım › "Yapay zekâ ve API" group (design 18.1). */
export function McpNavGroup() {
  const { t } = useI18n();
  const overview = useQuery({ ...overviewQuery, refetchInterval: 60_000 });
  const o = overview.data;
  if (o && !o.enabled) return null;
  return (
    <>
      <div className="eyebrow shrink-0 px-2.5 pt-3.5 pb-1.5">{t('mcp.nav.group')}</div>
      <NavItem
        icon="plug"
        to="/account/mcp"
        label={t('mcp.nav.mcp')}
        count={o ? o.grants + o.tokens || undefined : undefined}
      />
      <NavItem
        icon="shield"
        to="/account/approvals"
        label={t('mcp.nav.approvals')}
        count={o?.pendingApprovals || undefined}
        exact={false}
      />
      <NavItem icon="activity" to="/account/mcp/activity" label={t('mcp.nav.activity')} />
      <NavItem icon="code" to="/account/mcp/docs" label={t('mcp.nav.docs')} />
      <NavItem icon="terminal" to="/account/mcp/api" label={t('mcp.nav.api')} />
    </>
  );
}

/** Yönetim › Güvenlik › MCP ve API (design 18.10). `grouped={false}`: item only, no header. */
export function McpAdminNav({ grouped = true }: { grouped?: boolean }) {
  const { t } = useI18n();
  const connections = useQuery({ ...orgConnectionsQuery, queryKey: mcpKeys.orgConnections });
  return (
    <>
      {grouped ? (
        <div className="eyebrow shrink-0 px-2.5 pt-3.5 pb-1.5">{t('mcp.nav.adminGroup')}</div>
      ) : null}
      <NavItem
        icon="plug"
        to="/admin/mcp"
        label={t('mcp.nav.admin')}
        count={connections.data?.items.length || undefined}
      />
    </>
  );
}
