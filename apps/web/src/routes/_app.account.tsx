import { Avatar, Icon } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Outlet, redirect, useNavigate } from '@tanstack/react-router';
import { McpNavGroup } from '@/components/mcp/McpNav';
import { NavItem } from '@/components/spaces/SpaceSidebar';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useModuleEnabled } from '@/lib/identity/modules';
import { signOutWithSso } from '@/lib/identity/signOut';
import { usePermissions } from '@/lib/session';
import { ModuleSidebar } from '@/components/shell/ModuleSidebar';

/** "Hesabım" (doc 09 · 9.18-9.19, 19 · 19.19): personal settings, open to everyone. */
export const Route = createFileRoute('/_app/account')({
  beforeLoad: ({ location }) => {
    if (location.pathname.replace(/\/$/, '') === '/account') {
      throw redirect({ to: '/account/profile' });
    }
  },
  component: AccountLayout,
});

function AccountLayout() {
  const { t } = useI18n();
  const { me, canOrg } = usePermissions();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const mcpOn = useModuleEnabled('mcp');
  return (
    <>
      <ModuleSidebar label={t('account.title')} className="gap-px px-2.5 py-3">
        {me ? (
          <div className="mb-1.5 flex h-12 shrink-0 items-center gap-2.5 px-2">
            <Avatar name={me.user.name} src={me.user.imageUrl} size="md" />
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-semibold">{t('account.title')}</span>
              <span className="truncate text-[11.5px] leading-[14px] text-fg2">
                {me.user.email}
              </span>
            </div>
          </div>
        ) : null}
        <div className="eyebrow shrink-0 px-2.5 pt-3.5 pb-1.5">{t('account.personal')}</div>
        <NavItem icon="user" to="/account/profile" label={t('account.nav.profile')} />
        <NavItem icon="shield" to="/account/security" label={t('account.nav.security')} />
        <NavItem icon="sun" to="/account/appearance" label={t('account.nav.appearance')} />
        <NavItem icon="bell" to="/account/notifications" label={t('account.nav.notifications')} />
        <NavItem icon="laptop" to="/account/webdav" label={t('webdav.nav')} />
        <NavItem icon="info" to="/account/about" label={t('account.nav.about')} />
        {mcpOn ? <McpNavGroup /> : null}
        <div className="mt-auto flex shrink-0 flex-col gap-px border-t border-line pt-2">
          {canOrg('org.manage_members') ? (
            <NavItem icon="admin" to="/admin/general" label={t('shell.modules.admin')} />
          ) : null}
          <button
            type="button"
            onClick={async () => {
              if (!(await signOutWithSso(qc))) await navigate({ to: '/login' });
            }}
            className="flex h-[var(--nv-h)] items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg"
          >
            <Icon name="logout" size={16} />
            {t('shell.signOut')}
          </button>
        </div>
      </ModuleSidebar>
      <Outlet />
    </>
  );
}
