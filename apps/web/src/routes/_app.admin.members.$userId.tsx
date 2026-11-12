import { type OrgMember, type UpdateOrgMember } from '@crewhall/shared';
import {
  Avatar,
  Badge,
  Button,
  Icon,
  IconButton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
  DatePicker,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { type ReactNode } from 'react';
import { endOfDay, pickerDate } from '@/components/identity/GuestBadge';
import { PushDiagnosticsPanel } from '@/components/notifications/PushDiagnosticsPanel';
import { api, isApiError } from '@/lib/api';
import { formatDateLong, formatRelative, formatTime } from '@/lib/i18n/format';
import { useNow } from '@/lib/useNow';
import { useI18n } from '@/lib/i18n/I18nContext';
import { membersQuery } from '@/lib/queries';
import { usePermissions } from '@/lib/session';
import { ResizablePane } from '@/components/shell/ResizablePane';

export const Route = createFileRoute('/_app/admin/members/$userId')({
  component: MemberPanel,
});

/** Member detail panel, 340px on the right (doc 09 · 9.8). */
function MemberPanel() {
  const { t, locale } = useI18n();
  const { userId } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { me, role: myRole } = usePermissions();
  const members = useQuery(membersQuery());
  const now = useNow();
  const m = members.data?.items.find((x) => x.user.id === userId);

  const update = useMutation({
    mutationFn: (body: UpdateOrgMember) => api.call('updateMember', { params: { userId }, body }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['org', 'members'] });
      toast(t('ui.saved'));
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });

  const unlock = useMutation({
    mutationFn: () => api.call('unlockMember', { params: { userId } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['org', 'members'] });
      toast(t('admin.members.unlocked'));
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });

  const close = () => void navigate({ to: '/admin/members' });

  return (
    <ResizablePane id="admin-member" side="right" defaultWidth={340}>
      <aside
        aria-label={t('admin.members.panel')}
        className="flex w-full min-w-0 flex-col border-l border-line bg-bg"
      >
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line pr-3 pl-5">
          <span className="flex-1 text-sm font-semibold">{t('admin.members.panel')}</span>
          <IconButton aria-label={t('common.actions.close')} size="sm" tone="plain" onClick={close}>
            <Icon name="x" size={18} />
          </IconButton>
        </div>
        {!m ? null : (
          <div className="flex flex-col gap-5 overflow-y-auto p-5">
            <div className="flex items-center gap-3">
              <Avatar name={m.user.name} src={m.user.imageUrl} size="lg" />
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sub font-semibold">{m.user.name}</span>
                <span className="truncate text-cap text-fg2">{m.user.email}</span>
                {m.joinedAt ? (
                  <span className="text-xs text-fg3">
                    {t('admin.members.since', { date: formatDateLong(m.joinedAt, locale) })}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="flex flex-col text-[13.5px] leading-[18px]">
              <Kv label={t('admin.members.columns.role')}>
                <RoleSelect
                  m={m}
                  myRole={myRole}
                  self={m.user.id === me?.user.id}
                  onChange={(role) => update.mutate({ role })}
                />
              </Kv>
              {m.role === 'guest' ? (
                <Kv label={t('identity.guest.endDate')}>
                  <DatePicker
                    value={pickerDate(m.expiresAt)}
                    onChange={(d) => update.mutate({ expiresAt: d ? endOfDay(d) : null })}
                    min={pickerDate(new Date(now + 86_400_000).toISOString())}
                    placeholder={t('identity.guest.noEnd')}
                    aria-label={t('identity.guest.endDate')}
                  />
                </Kv>
              ) : null}
              <Kv label={t('admin.members.columns.lastSeen')}>
                {m.lastSeenAt ? formatRelative(m.lastSeenAt, locale) : '—'}
              </Kv>
              <Kv label={t('admin.members.columns.twoFactor')}>
                {m.twoFactorEnabled ? (
                  <Badge tone="ok">{t('admin.members.twoFactorOn')}</Badge>
                ) : (
                  <Badge tone="warn">{t('admin.members.twoFactorOff')}</Badge>
                )}
              </Kv>
              <Kv label={t('admin.members.columns.status')}>
                <Badge tone={m.status === 'active' ? 'ok' : 'danger'}>
                  {t(`admin.members.status.${m.status}`)}
                </Badge>
              </Kv>
            </div>
            {m.lockedUntil && new Date(m.lockedUntil).getTime() > now ? (
              <div className="flex items-start justify-between gap-3 rounded-xl bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] p-3.5">
                <div className="flex flex-col">
                  <span className="flex items-center gap-1.5 text-cap font-semibold">
                    <Icon name="lock" size={14} className="text-danger" />
                    {t('admin.members.lockedTitle')}
                  </span>
                  <span className="text-xs text-fg2">
                    {t('admin.members.lockedHint', { time: formatTime(m.lockedUntil, locale) })}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="inv"
                  loading={unlock.isPending}
                  onClick={() => unlock.mutate()}
                >
                  {t('admin.members.unlock')}
                </Button>
              </div>
            ) : null}
            {m.role !== 'owner' && m.user.id !== me?.user.id ? (
              <div className="mt-2 flex items-start justify-between gap-3 rounded-xl p-3.5 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--danger)_40%,transparent)]">
                <div className="flex flex-col">
                  <span className="text-cap font-semibold">
                    {m.status === 'suspended'
                      ? t('admin.members.reactivate')
                      : t('admin.members.suspend')}
                  </span>
                  <span className="text-xs text-fg2">
                    {m.status === 'suspended'
                      ? t('admin.members.reactivateHint')
                      : t('admin.members.suspendHint')}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant={m.status === 'suspended' ? 'out' : 'dng'}
                  loading={update.isPending}
                  onClick={() =>
                    update.mutate({ status: m.status === 'suspended' ? 'active' : 'suspended' })
                  }
                >
                  {m.status === 'suspended'
                    ? t('admin.members.reactivateAction')
                    : t('admin.members.suspendAction')}
                </Button>
              </div>
            ) : null}
            <PushDiagnosticsPanel userId={m.user.id} />
          </div>
        )}
      </aside>
    </ResizablePane>
  );
}

function Kv({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[38px] items-center justify-between gap-3 border-t border-line first:border-t-0">
      <span className="text-fg2">{label}</span>
      <span className="flex items-center">{children}</span>
    </div>
  );
}

function RoleSelect({
  m,
  myRole,
  self,
  onChange,
}: {
  m: OrgMember;
  myRole: string;
  self: boolean;
  onChange: (r: 'admin' | 'member' | 'guest') => void;
}) {
  const { t } = useI18n();
  if (m.role === 'owner' || self) {
    return <span className="font-semibold">{t(`admin.members.role.${m.role}`)}</span>;
  }
  return (
    <Select value={m.role} onValueChange={(v) => onChange(v as 'admin' | 'member' | 'guest')}>
      <SelectTrigger
        size="sm"
        className="h-8 w-auto gap-1.5 bg-transparent px-2.5 shadow-line2"
        aria-label={t('admin.members.columns.role')}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="admin" disabled={myRole !== 'owner'}>
          {t('admin.members.role.admin')}
        </SelectItem>
        <SelectItem value="member">{t('admin.members.role.member')}</SelectItem>
        <SelectItem value="guest">{t('admin.members.role.guest')}</SelectItem>
      </SelectContent>
    </Select>
  );
}
