import { CrewhallMark } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { AiAdminNav } from '@/components/ai/AiAdminNav';
import { IdentityAdminNav } from '@/components/identity/IdentityAdminNav';
import { MailAdminNav } from '@/components/mail/MailAdminNav';
import { CalendarAdminNav } from '@/components/calendar/CalendarAdminNav';
import { NavItem } from '@/components/spaces/SpaceSidebar';
import { useI18n } from '@/lib/i18n/I18nContext';
import { membersQuery, meQuery, spacesQuery } from '@/lib/queries';
import { actorFrom, usePermissions } from '@/lib/session';
import { useBootstrap } from '@/lib/useBranding';
import { ModuleSidebar } from '@/components/shell/ModuleSidebar';

/** Admin area (doc 09): org owners and admins only; the rail hides it for everyone else. */
export const Route = createFileRoute('/_app/admin')({
  beforeLoad: async ({ context: { queryClient }, location }) => {
    const me = await queryClient.ensureQueryData(meQuery);
    const role = actorFrom(me).orgRole;
    if (role !== 'owner' && role !== 'admin') throw redirect({ to: '/' });
    if (location.pathname.replace(/\/$/, '') === '/admin') {
      throw redirect({ to: '/admin/general' });
    }
  },
  component: AdminLayout,
});

function AdminLayout() {
  return (
    <>
      <AdminSidebar />
      <Outlet />
    </>
  );
}

function AdminSidebar() {
  const { t } = useI18n();
  const { branding } = useBootstrap();
  const members = useQuery(membersQuery({ status: 'active' }));
  const spaces = useQuery(spacesQuery());
  const shared = spaces.data?.items.filter((s) => s.kind === 'shared').length;
  const { canOrg } = usePermissions();

  return (
    <ModuleSidebar label={t('admin.title')} className="gap-px overflow-y-auto px-2.5 py-3">
      <div className="mb-1.5 flex h-12 shrink-0 items-center gap-2.5 px-2">
        {branding.markUrl ? (
          <img src={branding.markUrl} alt="" className="size-7 rounded-sm" />
        ) : (
          <CrewhallMark size={26} />
        )}
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-semibold">{t('admin.title')}</span>
          <span className="truncate text-[11.5px] leading-[14px] text-fg2">
            {t('admin.subtitle', { org: branding.orgName })}
          </span>
        </div>
      </div>
      <Group label={t('admin.groups.org')} />
      <NavItem icon="settings" to="/admin/general" label={t('admin.nav.general')} />
      <NavItem
        icon="users"
        to="/admin/members"
        label={t('admin.nav.members')}
        count={members.data?.items.length}
        exact={false}
      />
      <NavItem icon="space" to="/admin/spaces" label={t('admin.nav.spaces')} count={shared} />
      {canOrg('org.view_stats') ? (
        <NavItem icon="activity" to="/admin/stats" label={t('stats.nav')} />
      ) : null}
      {canOrg('org.update_settings') ? (
        <NavItem icon="bell" to="/admin/delivery" label={t('admin.nav.delivery')} />
      ) : null}
      <Group label={t('admin.groups.brand')} />
      <NavItem icon="tag" to="/admin/brand" label={t('admin.nav.brand')} />
      <NavItem icon="sliders" to="/admin/theme" label={t('admin.nav.theme')} />
      <IdentityAdminNav />
      <AiAdminNav />
      <MailAdminNav />
      <CalendarAdminNav />
      <div className="mt-auto flex shrink-0 flex-col gap-px border-t border-line pt-2">
        <NavItem icon="user" to="/account/profile" label={t('account.title')} />
        <NavItem icon="arrowL" to="/" label={t('admin.backToApp')} />
      </div>
    </ModuleSidebar>
  );
}

function Group({ label }: { label: string }) {
  return <div className="eyebrow shrink-0 px-2.5 pt-3.5 pb-1.5">{label}</div>;
}
