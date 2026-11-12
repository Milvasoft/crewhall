import { queryKeys } from '@crewhall/api-client';
import { type Invitation, type OrgMember } from '@crewhall/shared';
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  Chip,
  cn,
  Icon,
  IconButton,
  Input,
  SelectAllCheckbox,
  Skeleton,
  Table,
  Td,
  Th,
  toast,
  Tooltip,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { InviteDialog } from '@/components/admin/InviteDialog';
import { SelectionBar, SelectionButton } from '@/components/common/SelectionBar';
import { ConfirmDialog } from '@/components/forms/parts';
import { PageHeader } from '@/components/admin/Settings';
import { Workspace } from '@/components/shell/Workspace';
import { GuestBadge } from '@/components/identity/GuestBadge';
import { api, idempotencyKey, isApiError } from '@/lib/api';
import { formatDate, formatRelative, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { invitationsQuery, membersQuery } from '@/lib/queries';
import { useSelection, useSelectionKeys } from '@/lib/selection';
import { usePermissions } from '@/lib/session';
import { useNow } from '@/lib/useNow';

export const Route = createFileRoute('/_app/admin/members')({
  validateSearch: z.object({ invite: z.boolean().optional() }),
  component: MembersPage,
});

type Filter = 'all' | 'admins' | 'no2fa' | 'invites' | 'suspended';

const ONLINE_MS = 5 * 60_000;

/** Sign-in lock still running (1.16); admins can lift it from the member panel. */
function isLocked(m: OrgMember, now: number): boolean {
  return Boolean(m.lockedUntil && new Date(m.lockedUntil).getTime() > now);
}

/** Members and pending invitations in one table (doc 09 · 9.6); row opens the panel (9.8). */
function MembersPage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { invite } = Route.useSearch();
  const { me } = usePermissions();
  const selected = useParams({ strict: false, select: (p) => (p as { userId?: string }).userId });
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const members = useQuery(membersQuery());
  const invitations = useQuery(invitationsQuery);
  const now = useNow();

  const all = members.data?.items ?? [];
  const invites = invitations.data?.items ?? [];
  const needle = q.trim().toLocaleLowerCase(locale);
  const matches = (name: string, email: string) =>
    !needle || name.toLocaleLowerCase(locale).includes(needle) || email.includes(needle);

  const counts: Record<Filter, number> = {
    all: all.length + invites.length,
    admins: all.filter((m) => m.role === 'owner' || m.role === 'admin').length,
    no2fa: all.filter((m) => !m.twoFactorEnabled).length,
    invites: invites.length,
    suspended: all.filter((m) => m.status === 'suspended').length,
  };

  const shownMembers =
    filter === 'invites'
      ? []
      : all
          .filter((m) => matches(m.user.name, m.user.email))
          .filter((m) =>
            filter === 'admins'
              ? m.role === 'owner' || m.role === 'admin'
              : filter === 'no2fa'
                ? !m.twoFactorEnabled
                : filter === 'suspended'
                  ? m.status === 'suspended'
                  : true,
          );
  const shownInvites =
    filter === 'all' || filter === 'invites'
      ? invites.filter((i) => matches(i.email, i.email))
      : [];

  const resend = useMutation({
    mutationFn: (i: Invitation) =>
      api.call('createInvitation', {
        body: { email: i.email, role: i.role, spaceIds: [] },
        idempotencyKey: idempotencyKey(),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.invitations });
      toast(t('invite.resent'));
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.call('revokeInvitation', { params: { invitationId: id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.invitations }),
  });

  const pending = invites.filter((i) => new Date(i.expiresAt).getTime() > now).length;

  // Selection: yourself and owners keep to the member panel; invitations carry a prefix.
  const canPick = (m: OrgMember) => m.role !== 'owner' && m.user.id !== me?.user.id;
  const selection = useSelection([
    ...shownMembers.filter(canPick).map((m) => m.user.id),
    ...shownInvites.map((i) => `invite:${i.id}`),
  ]);
  useSelectionKeys(selection);
  const pickedMembers = shownMembers.filter((m) => selection.has(m.user.id));
  const pickedInvites = shownInvites.filter((i) => selection.has(`invite:${i.id}`));
  const toSuspend = pickedMembers.filter((m) => m.status !== 'suspended');
  const toActivate = pickedMembers.filter((m) => m.status === 'suspended');
  const [confirmSuspend, setConfirmSuspend] = useState(false);
  const bulk = useMutation({
    mutationFn: async (run: {
      members?: OrgMember[];
      status?: 'active' | 'suspended';
      invites?: Invitation[];
    }) => {
      for (const m of run.members ?? []) {
        await api.call('updateMember', {
          params: { userId: m.user.id },
          body: { status: run.status },
        });
      }
      for (const i of run.invites ?? []) {
        await api.call('revokeInvitation', { params: { invitationId: i.id } });
      }
      return (run.members?.length ?? 0) + (run.invites?.length ?? 0);
    },
    onSuccess: (count) => toast(t('admin.members.bulk.done', { count })),
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
    onSettled: async () => {
      setConfirmSuspend(false);
      selection.clear();
      await qc.invalidateQueries({ queryKey: queryKeys.invitations });
      await qc.invalidateQueries({ queryKey: membersQuery().queryKey });
    },
  });

  return (
    <Workspace
      crumbs={[
        { label: t('admin.title') },
        { label: t('admin.nav.members') },
        ...(selected ? [{ label: all.find((m) => m.user.id === selected)?.user.name ?? '' }] : []),
      ]}
      panel={<Outlet />}
    >
      <PageHeader
        title={t('admin.members.title')}
        subtitle={t('admin.members.subtitle', { members: all.length, invites: pending })}
        actions={
          <Button
            variant="pri"
            onClick={() => void navigate({ to: '/admin/members', search: { invite: true } })}
          >
            <Icon name="userPlus" size={18} />
            {t('admin.members.invite')}
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <Input
          icon="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('admin.members.search')}
          aria-label={t('admin.members.search')}
          containerClassName="h-9 w-[240px] rounded-md"
        />
        {(['all', 'admins', 'no2fa', 'invites', 'suspended'] as const).map((f) => (
          <Chip key={f} size="sm" on={filter === f} onClick={() => setFilter(f)}>
            {t(`admin.members.filter.${f}`)} · {counts[f]}
          </Chip>
        ))}
      </div>
      <section className="overflow-hidden rounded-2xl bg-surface shadow-line">
        <Table>
          <thead>
            <tr>
              <Th className="w-9">
                {selection.state !== 'none' || shownMembers.some(canPick) || shownInvites.length ? (
                  <SelectAllCheckbox
                    state={selection.state}
                    onChange={selection.setAll}
                    label={t('ui.selectAll')}
                  />
                ) : null}
              </Th>
              <Th>{t('admin.members.columns.member')}</Th>
              <Th>{t('admin.members.columns.role')}</Th>
              <Th>{t('admin.members.columns.twoFactor')}</Th>
              <Th>{t('admin.members.columns.lastSeen')}</Th>
              <Th>{t('admin.members.columns.status')}</Th>
              <Th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {members.isLoading
              ? Array.from({ length: 5 }, (_, i) => (
                  <tr key={i}>
                    <Td colSpan={7}>
                      <Skeleton className="h-8 w-full" />
                    </Td>
                  </tr>
                ))
              : shownMembers.map((m) => (
                  <MemberRow
                    key={m.user.id}
                    m={m}
                    you={m.user.id === me?.user.id}
                    selected={selected === m.user.id}
                    picked={selection.has(m.user.id)}
                    onPick={canPick(m) ? () => selection.toggle(m.user.id) : undefined}
                    now={now}
                    onOpen={() =>
                      void navigate({
                        to: '/admin/members/$userId',
                        params: { userId: m.user.id },
                      })
                    }
                  />
                ))}
            {shownInvites.map((i) => {
              const expired = new Date(i.expiresAt).getTime() < now;
              return (
                <tr key={i.id} className={cn(!selection.has(`invite:${i.id}`) && 'opacity-70')}>
                  <Td>
                    <Checkbox
                      checked={selection.has(`invite:${i.id}`)}
                      onCheckedChange={() => selection.toggle(`invite:${i.id}`)}
                      aria-label={t('admin.members.select', { name: i.email })}
                    />
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <span className="flex size-6 items-center justify-center rounded-full bg-bg2 text-fg2">
                        <Icon name="mail" size={13} />
                      </span>
                      <div className="flex flex-col">
                        <span className="font-semibold">{i.email}</span>
                        <span className="text-xs text-fg2">
                          {expired
                            ? t('admin.members.expiredOn', {
                                date: formatDate(i.expiresAt, locale),
                              })
                            : t('admin.members.invitedBy', {
                                name: i.invitedBy.name,
                                when: formatRelative(i.createdAt, locale),
                              })}
                        </span>
                      </div>
                    </div>
                  </Td>
                  <Td>{t(`common.roles.org.${i.role}`)}</Td>
                  <Td className="text-fg3">—</Td>
                  <Td className="text-fg3">—</Td>
                  <Td>
                    <Badge tone={expired ? 'danger' : 'info'}>
                      {expired
                        ? t('admin.members.status.expired')
                        : t('admin.members.status.invited')}
                    </Badge>
                  </Td>
                  <Td>
                    <div className="flex gap-1">
                      <Tooltip content={t('invite.resend')}>
                        <IconButton
                          aria-label={t('invite.resend')}
                          size="xs"
                          tone="plain"
                          onClick={() => resend.mutate(i)}
                        >
                          <Icon name="refresh" size={15} />
                        </IconButton>
                      </Tooltip>
                      <Tooltip content={t('invite.revoke')}>
                        <IconButton
                          aria-label={t('invite.revoke')}
                          size="xs"
                          tone="plain"
                          onClick={() => revoke.mutate(i.id)}
                        >
                          <Icon name="x" size={15} />
                        </IconButton>
                      </Tooltip>
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </section>
      {selection.count ? (
        <SelectionBar
          label={t('ui.selectionActions')}
          count={t('ui.selectedCount', { count: selection.count })}
          clearLabel={t('ui.clearSelection')}
          onClear={selection.clear}
        >
          {toSuspend.length ? (
            <SelectionButton
              icon="lock"
              label={t('admin.members.suspendAction')}
              onClick={() => setConfirmSuspend(true)}
            />
          ) : null}
          {toActivate.length ? (
            <SelectionButton
              icon="unlock"
              label={t('admin.members.reactivateAction')}
              disabled={bulk.isPending}
              onClick={() => bulk.mutate({ members: toActivate, status: 'active' })}
            />
          ) : null}
          {pickedInvites.length ? (
            <SelectionButton
              icon="x"
              label={t('admin.members.bulk.revoke')}
              disabled={bulk.isPending}
              onClick={() => bulk.mutate({ invites: pickedInvites })}
            />
          ) : null}
        </SelectionBar>
      ) : null}
      <ConfirmDialog
        open={confirmSuspend}
        onOpenChange={setConfirmSuspend}
        title={t('admin.members.bulk.suspendTitle', { count: toSuspend.length })}
        body={t('admin.members.suspendHint')}
        confirm={t('admin.members.suspendAction')}
        pending={bulk.isPending}
        onConfirm={() => bulk.mutate({ members: toSuspend, status: 'suspended' })}
      />
      <InviteDialog
        open={Boolean(invite)}
        onClose={() => void navigate({ to: '/admin/members', search: {} })}
      />
    </Workspace>
  );
}

function MemberRow({
  m,
  you,
  selected,
  picked,
  onPick,
  now,
  onOpen,
}: {
  m: OrgMember;
  you: boolean;
  selected: boolean;
  picked: boolean;
  /** Absent for yourself and owners: they keep to the member panel. */
  onPick?: () => void;
  now: number;
  onOpen: () => void;
}) {
  const { t, locale } = useI18n();
  const online = m.lastSeenAt && now - new Date(m.lastSeenAt).getTime() < ONLINE_MS;
  return (
    <tr
      onClick={onOpen}
      aria-selected={selected || undefined}
      className={cn(
        'cursor-pointer hover:[&>td]:bg-bg2',
        (selected || picked) && '[&>td]:bg-capsule',
      )}
    >
      <Td onClick={(e) => e.stopPropagation()}>
        {onPick ? (
          <Checkbox
            checked={picked}
            onCheckedChange={onPick}
            aria-label={t('admin.members.select', { name: m.user.name })}
          />
        ) : null}
      </Td>
      <Td>
        <div className="flex items-center gap-2.5">
          <Avatar
            name={m.user.name}
            src={m.user.imageUrl}
            size="sm"
            presence={online ? 'online' : null}
          />
          <div className="flex min-w-0 flex-col">
            <span className="font-semibold">
              {m.user.name}
              {you ? <span className="font-normal text-fg2"> ({t('spaces.you')})</span> : null}
            </span>
            <span className="text-xs text-fg2">{m.user.email}</span>
          </div>
        </div>
      </Td>
      <Td>
        {m.role === 'guest' ? (
          <GuestBadge expiresAt={m.expiresAt} />
        ) : (
          t(`admin.members.role.${m.role}`)
        )}
      </Td>
      <Td>
        {m.twoFactorEnabled ? (
          <span className="flex items-center gap-1.5">
            <Icon name="shield" size={14} className="text-success" />
            {t('admin.members.twoFactorOn')}
          </span>
        ) : (
          <Badge tone="warn">{t('admin.members.twoFactorOff')}</Badge>
        )}
      </Td>
      <Td className="text-fg2">
        {online
          ? t('admin.members.online')
          : m.lastSeenAt
            ? formatRelative(m.lastSeenAt, locale)
            : '—'}
      </Td>
      <Td>
        {isLocked(m, now) ? (
          <Badge tone="danger">
            <Icon name="lock" size={11} />
            {t('admin.members.locked', { time: formatTime(m.lockedUntil ?? '', locale) })}
          </Badge>
        ) : (
          <Badge tone={m.status === 'active' ? 'ok' : m.status === 'suspended' ? 'danger' : 'info'}>
            {t(`admin.members.status.${m.status}`)}
          </Badge>
        )}
      </Td>
      <Td>
        <Icon name="chevR" size={16} className="text-fg3" />
      </Td>
    </tr>
  );
}
