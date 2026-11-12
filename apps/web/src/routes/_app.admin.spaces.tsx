import { type OrgSpace } from '@crewhall/shared';
import { Avatar, Badge, Button, Icon, Progress, Skeleton, Table, Td, Th } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { PageHeader } from '@/components/admin/Settings';
import { Workspace } from '@/components/shell/Workspace';
import { SpaceAvatar } from '@/components/spaces/SpaceAvatar';
import { openDialog } from '@/lib/dialogs';
import { formatBytes, formatDate, formatPercent } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { orgSpacesQuery } from '@/lib/queries';
import { usePermissions } from '@/lib/session';

export const Route = createFileRoute('/_app/admin/spaces')({
  component: AdminSpacesPage,
});

const WARN_AT = 80;

/**
 * Every shared space of the org (doc 09 · 9.9), including ones the admin is not a member of:
 * metadata only, content stays closed. Personal spaces are summarized, never listed.
 */
function AdminSpacesPage() {
  const { t, locale } = useI18n();
  const { canOrg, canSpace } = usePermissions();
  const active = useQuery(orgSpacesQuery());
  const archived = useQuery(orgSpacesQuery(true));
  const shared = active.data?.items ?? [];
  const rows: OrgSpace[] = [...shared, ...(archived.data?.items ?? [])];
  const total = rows.reduce((n, s) => n + s.usedBytes, 0);
  const warn = shared.filter((s) => s.quotaBytes && (s.usedBytes / s.quotaBytes) * 100 >= WARN_AT);

  return (
    <Workspace crumbs={[{ label: t('admin.title') }, { label: t('admin.nav.spaces') }]}>
      <PageHeader
        title={t('admin.spaces.title')}
        subtitle={t('admin.spaces.subtitle', {
          active: shared.length,
          archived: archived.data?.items.length ?? 0,
        })}
        actions={
          canOrg('org.create_space') ? (
            <Button variant="pri" onClick={() => openDialog('newSpace')}>
              <Icon name="plus" size={18} />
              {t('spaces.create')}
            </Button>
          ) : null
        }
      />
      <div className="grid grid-cols-3 gap-3">
        <Kpi label={t('admin.spaces.kpiShared')} value={String(shared.length)} />
        <Kpi label={t('admin.spaces.kpiStorage')} value={formatBytes(total, locale)} />
        <Kpi
          label={t('admin.spaces.kpiQuota')}
          value={String(warn.length)}
          hint={warn.map((s) => s.name).join(', ')}
        />
      </div>
      <section className="overflow-hidden rounded-2xl bg-surface shadow-line">
        <Table>
          <thead>
            <tr>
              <Th>{t('admin.spaces.columns.space')}</Th>
              <Th>{t('admin.spaces.columns.members')}</Th>
              <Th>{t('admin.spaces.columns.storage')}</Th>
              <Th>{t('admin.spaces.columns.owner')}</Th>
              <Th>{t('admin.spaces.columns.yourRole')}</Th>
              <Th>{t('admin.spaces.columns.created')}</Th>
              <Th>{t('admin.spaces.columns.status')}</Th>
            </tr>
          </thead>
          <tbody>
            {active.isLoading
              ? Array.from({ length: 4 }, (_, i) => (
                  <tr key={i}>
                    <Td colSpan={7}>
                      <Skeleton className="h-8 w-full" />
                    </Td>
                  </tr>
                ))
              : rows.map((s) => {
                  const pct = s.quotaBytes ? (s.usedBytes / s.quotaBytes) * 100 : null;
                  const isArchived = s.archivedAt !== null;
                  return (
                    <tr key={s.id} className={isArchived ? 'opacity-70' : undefined}>
                      <Td>
                        <div className="flex items-center gap-2.5">
                          <SpaceAvatar space={s} />
                          <div className="flex min-w-0 flex-col">
                            {!isArchived &&
                            s.myRole &&
                            canSpace('space.update_settings', s.myRole) ? (
                              <Link
                                to="/spaces/$spaceSlug/settings"
                                params={{ spaceSlug: s.slug }}
                                className="font-semibold hover:underline"
                              >
                                {s.name}
                              </Link>
                            ) : (
                              <span className="font-semibold">{s.name}</span>
                            )}
                            <span className="text-xs text-fg2">
                              {isArchived
                                ? t('admin.spaces.readOnly')
                                : s.isDefault
                                  ? t('admin.spaces.default')
                                  : t('admin.spaces.byInvite')}
                            </span>
                          </div>
                        </div>
                      </Td>
                      <Td className="tn">{s.memberCount}</Td>
                      <Td>
                        <div className="flex w-[160px] flex-col gap-1">
                          <span className="text-xs tn">
                            {formatBytes(s.usedBytes, locale)}
                            {s.quotaBytes ? ` / ${formatBytes(s.quotaBytes, locale)}` : ''}
                            {pct !== null && pct >= WARN_AT ? (
                              <span className="ml-1.5 font-semibold text-warning">
                                {formatPercent(pct, locale)}
                              </span>
                            ) : null}
                          </span>
                          {pct !== null ? <Progress neutral value={pct} /> : null}
                        </div>
                      </Td>
                      <Td>
                        {s.owner ? (
                          <span className="flex items-center gap-2">
                            <Avatar name={s.owner.name} src={s.owner.imageUrl} size="sm" />
                            {s.owner.name.split(' ')[0]}
                          </span>
                        ) : (
                          <span className="text-fg3">—</span>
                        )}
                      </Td>
                      <Td className={s.myRole ? undefined : 'text-fg3'}>
                        {s.myRole
                          ? t(`common.roles.space.${s.myRole}`)
                          : t('admin.spaces.notMember')}
                      </Td>
                      <Td className="text-fg2">{formatDate(s.createdAt, locale)}</Td>
                      <Td>
                        {isArchived ? (
                          <Badge>{t('admin.spaces.status.archived')}</Badge>
                        ) : pct !== null && pct >= WARN_AT ? (
                          <Badge tone="warn">{t('admin.spaces.status.quota')}</Badge>
                        ) : (
                          <Badge tone="ok">{t('admin.spaces.status.active')}</Badge>
                        )}
                      </Td>
                    </tr>
                  );
                })}
          </tbody>
        </Table>
      </section>
      <p className="m-0 text-xs text-fg3">{t('admin.spaces.personalNote')}</p>
    </Workspace>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl bg-surface px-4 py-3.5 shadow-line">
      <span className="text-cap text-fg2">{label}</span>
      <span className="text-num font-bold tn">{value}</span>
      {hint ? <span className="truncate text-xs text-fg3">{hint}</span> : null}
    </div>
  );
}
