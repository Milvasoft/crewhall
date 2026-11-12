import { queryKeys } from '@crewhall/api-client';
import { canGrantSpaceRole, type Space, type SpaceMember, type SpaceRole } from '@crewhall/shared';
import {
  Avatar,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  IconButton,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  Td,
  Th,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { ColorPicker } from '@/components/spaces/ColorPicker';
import { SpaceAvatar } from '@/components/spaces/SpaceAvatar';
import { SpaceSidebar } from '@/components/spaces/SpaceSidebar';
import { api, isApiError } from '@/lib/api';
import { formatBytes, formatDate, formatDateLong } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { membersQuery, spaceMembersQuery, spacesQuery } from '@/lib/queries';
import { usePermissions } from '@/lib/session';
import { useSpaces } from '@/lib/useSpaces';

export const Route = createFileRoute('/_app/spaces/$spaceSlug/settings')({
  beforeLoad: async ({ params, context: { queryClient } }) => {
    const { items } = await queryClient.ensureQueryData(spacesQuery());
    const space = items.find((s) => s.slug === params.spaceSlug);
    if (!space || space.kind === 'personal') throw notFound({ routeId: '/_app' });
  },
  component: SpaceSettingsPage,
});

const ROLES: SpaceRole[] = ['owner', 'admin', 'editor', 'viewer'];

/** Space settings: members and roles, general, danger zone (doc 03 · 3.3). */
function SpaceSettingsPage() {
  const { t, locale } = useI18n();
  const { spaceSlug } = Route.useParams();
  const navigate = useNavigate();
  const { bySlug } = useSpaces();
  const { canSpace } = usePermissions();
  const space = bySlug(spaceSlug);
  const [adding, setAdding] = useState(false);

  if (!space) return null;
  const manage = canSpace('space.manage_members', space.myRole);
  const settings = canSpace('space.update_settings', space.myRole);

  return (
    <Workspace
      sidebar={
        <SpaceSidebar
          space={space}
          onSelect={(s) =>
            void navigate(
              s.kind === 'shared' && canSpace('space.update_settings', s.myRole)
                ? { to: '/spaces/$spaceSlug/settings', params: { spaceSlug: s.slug } }
                : { to: '/$module/$spaceSlug', params: { module: 'drive', spaceSlug: s.slug } },
            )
          }
        />
      }
      crumbs={[{ label: space.name }, { label: t('spaces.settings') }]}
    >
      <div className="flex shrink-0 items-end justify-between gap-4">
        <div className="flex flex-col">
          <h1 className="m-0 text-wtitle font-bold">{t('spaces.settingsTitle')}</h1>
          <span className="text-[13.5px] leading-[18px] text-fg2">
            {t('spaces.settingsSub', {
              name: space.name,
              count: space.memberCount,
              date: formatDateLong(space.createdAt, locale),
            })}
          </span>
        </div>
        {manage ? (
          <Button variant="pri" onClick={() => setAdding(true)}>
            <Icon name="userPlus" size={18} />
            {t('spaces.addMember')}
          </Button>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-col gap-5 xl:flex-row xl:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <MembersCard space={space} manage={manage} />
          <div className="grid grid-cols-2 gap-3 2xl:grid-cols-4">
            {ROLES.map((r) => (
              <div key={r} className="flex flex-col gap-1 rounded-xl bg-surface p-3.5 shadow-line">
                <span className="text-cap font-semibold">{t(`common.roles.space.${r}`)}</span>
                <span className="text-xs text-fg2">{t(`spaces.roleHelp.${r}`)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="flex w-full shrink-0 flex-col gap-4 xl:w-[340px]">
          <GeneralCard space={space} editable={settings} />
          {canSpace('space.archive', space.myRole) ? <DangerCard space={space} /> : null}
        </div>
      </div>
      {adding ? <AddMemberDialog space={space} onClose={() => setAdding(false)} /> : null}
    </Workspace>
  );
}

function MembersCard({ space, manage }: { space: Space; manage: boolean }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const { me } = usePermissions();
  const [q, setQ] = useState('');
  const members = useQuery(spaceMembersQuery(space.id));

  const invalidate = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.spaceMembers(space.id) }),
      qc.invalidateQueries({ queryKey: queryKeys.spaces() }),
    ]);

  const update = useMutation({
    mutationFn: (v: { userId: string; role: Exclude<SpaceRole, 'owner'> }) =>
      api.call('updateSpaceMember', {
        params: { spaceId: space.id, userId: v.userId },
        body: { role: v.role },
      }),
    onSuccess: async () => {
      await invalidate();
      toast(t('spaces.roleChanged'));
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });
  const remove = useMutation({
    mutationFn: (userId: string) =>
      api.call('removeSpaceMember', { params: { spaceId: space.id, userId } }),
    onSuccess: invalidate,
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });

  const needle = q.trim().toLocaleLowerCase(locale);
  const rows = (members.data?.items ?? [])
    .filter(
      (m) =>
        !needle ||
        m.user.name.toLocaleLowerCase(locale).includes(needle) ||
        m.user.email.includes(needle),
    )
    .sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role));

  function editable(m: SpaceMember) {
    return (
      manage &&
      m.role !== 'owner' &&
      m.user.id !== me?.user.id &&
      canGrantSpaceRole(space.myRole, m.role)
    );
  }

  return (
    <section className="overflow-hidden rounded-2xl bg-surface shadow-line">
      <div className="flex items-center justify-between gap-3 px-5 pt-3.5 pb-2">
        <h2 className="m-0 text-sm font-semibold">{t('spaces.membersAndRoles')}</h2>
        <Input
          icon="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('spaces.searchMember')}
          aria-label={t('spaces.searchMember')}
          containerClassName="h-8 w-[220px] rounded-sm px-2.5 text-cap"
        />
      </div>
      <Table>
        <thead>
          <tr>
            <Th>{t('spaces.columns.member')}</Th>
            <Th>{t('spaces.columns.role')}</Th>
            <Th>{t('spaces.columns.added')}</Th>
            <Th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {members.isLoading
            ? Array.from({ length: 4 }, (_, i) => (
                <tr key={i}>
                  <Td colSpan={4}>
                    <Skeleton className="h-8 w-full" />
                  </Td>
                </tr>
              ))
            : rows.map((m) => (
                <tr key={m.user.id}>
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={m.user.name} src={m.user.imageUrl} size="sm" />
                      <div className="flex min-w-0 flex-col">
                        <span className="font-semibold">{m.user.name}</span>
                        <span className="text-xs text-fg2">{m.user.email}</span>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    {editable(m) ? (
                      <Select
                        value={m.role}
                        onValueChange={(role) =>
                          update.mutate({
                            userId: m.user.id,
                            role: role as Exclude<SpaceRole, 'owner'>,
                          })
                        }
                      >
                        <SelectTrigger
                          size="sm"
                          className="h-8 w-auto gap-1.5 bg-transparent px-2.5 shadow-line2"
                          aria-label={t('spaces.roleOf', { name: m.user.name })}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(['admin', 'editor', 'viewer'] as const).map((r) => (
                            <SelectItem
                              key={r}
                              value={r}
                              disabled={!canGrantSpaceRole(space.myRole, r)}
                            >
                              {t(`common.roles.space.${r}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="px-2.5 text-fg">{t(`common.roles.space.${m.role}`)}</span>
                    )}
                  </Td>
                  <Td className="text-fg2">{formatDate(m.addedAt, locale)}</Td>
                  <Td>
                    {editable(m) ? (
                      <Menu>
                        <MenuTrigger asChild>
                          <IconButton aria-label={t('ui.more')} size="xs" tone="plain">
                            <Icon name="dots" size={16} />
                          </IconButton>
                        </MenuTrigger>
                        <MenuContent align="end">
                          <MenuItem icon="trash" danger onSelect={() => remove.mutate(m.user.id)}>
                            {t('spaces.removeMember')}
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                    ) : null}
                  </Td>
                </tr>
              ))}
        </tbody>
      </Table>
    </section>
  );
}

function GeneralCard({ space, editable }: { space: Space; editable: boolean }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const update = useMutation({
    mutationFn: (body: { name?: string; color?: Space['color'] }) =>
      api.call('updateSpace', { params: { spaceId: space.id }, body }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.spaces() });
      toast(t('ui.saved'));
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });

  return (
    <section className="flex flex-col gap-4 rounded-2xl bg-surface p-5 shadow-line">
      <h2 className="m-0 text-sm font-semibold">{t('spaces.general')}</h2>
      <div className="flex items-center gap-3">
        <SpaceAvatar space={space} size="lg" />
        <Input
          key={space.name}
          defaultValue={space.name}
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name && name !== space.name) update.mutate({ name });
          }}
          disabled={!editable}
          aria-label={t('spaces.name')}
          containerClassName="flex-1"
          maxLength={60}
        />
      </div>
      {editable ? (
        <ColorPicker value={space.color} onChange={(color) => update.mutate({ color })} />
      ) : null}
      <div className="flex flex-col text-[13.5px] leading-[18px]">
        <div className="flex min-h-[38px] items-center justify-between gap-3 border-t border-line">
          <span className="text-fg2">{t('spaces.storage')}</span>
          <span className="font-semibold tn">
            {formatBytes(space.usedBytes, locale)}
            {space.quotaBytes
              ? ` / ${formatBytes(space.quotaBytes, locale)}`
              : ` · ${t('spaces.orgQuota')}`}
          </span>
        </div>
        <div className="flex min-h-[38px] items-center justify-between gap-3 border-t border-line">
          <span className="text-fg2">{t('spaces.address')}</span>
          <span className="font-mono text-cap">{space.slug}</span>
        </div>
      </div>
    </section>
  );
}

function DangerCard({ space }: { space: Space }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const archive = useMutation({
    mutationFn: () => api.call('archiveSpace', { params: { spaceId: space.id } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.spaces() });
      toast(t('spaces.archivedToast', { name: space.name }));
      await navigate({ to: '/' });
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });

  return (
    <section className="flex flex-col rounded-2xl bg-surface px-5 py-2 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--danger)_40%,transparent)]">
      <div className="flex min-h-[60px] items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-cap font-semibold">{t('spaces.archive')}</span>
          <span className="text-xs text-fg2">{t('spaces.archiveHint')}</span>
        </div>
        <Button size="sm" variant="out" onClick={() => setConfirm(true)}>
          {t('spaces.archiveAction')}
        </Button>
      </div>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader
            icon="archive"
            title={t('spaces.archiveConfirmTitle', { name: space.name })}
            description={t('spaces.archiveConfirmBody')}
          />
          <DialogFooter>
            <Button variant="gh" onClick={() => setConfirm(false)} autoFocus>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="inv" loading={archive.isPending} onClick={() => archive.mutate()}>
              {t('spaces.archiveAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function AddMemberDialog({ space, onClose }: { space: Space; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const people = useQuery(membersQuery({ status: 'active' }));
  const current = useQuery(spaceMembersQuery(space.id));
  const [userId, setUserId] = useState<string>('');
  const [role, setRole] = useState<Exclude<SpaceRole, 'owner'>>('editor');
  const [error, setError] = useState<string | null>(null);
  const taken = new Set(current.data?.items.map((m) => m.user.id));
  const options = (people.data?.items ?? []).filter((m) => !taken.has(m.user.id));
  const add = useMutation({
    mutationFn: () =>
      api.call('addSpaceMember', { params: { spaceId: space.id }, body: { userId, role } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.spaceMembers(space.id) });
      await qc.invalidateQueries({ queryKey: queryKeys.spaces() });
      onClose();
    },
    onError: (e) => setError(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });

  return (
    <Dialog open onOpenChange={(v) => (v ? null : onClose())}>
      <DialogContent>
        <DialogHeader icon="userPlus" title={t('spaces.addMemberTitle', { name: space.name })} />
        <Field label={t('spaces.person')} error={error ?? undefined}>
          <Select value={userId} onValueChange={setUserId}>
            <SelectTrigger aria-label={t('spaces.person')}>
              <SelectValue placeholder={t('spaces.pickPerson')} />
            </SelectTrigger>
            <SelectContent>
              {options.map((m) => (
                <SelectItem key={m.user.id} value={m.user.id}>
                  {m.user.name} · {m.user.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('spaces.role')}>
          <Select value={role} onValueChange={(v) => setRole(v as typeof role)}>
            <SelectTrigger aria-label={t('spaces.role')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['admin', 'editor', 'viewer'] as const).map((r) => (
                <SelectItem key={r} value={r} disabled={!canGrantSpaceRole(space.myRole, r)}>
                  {t(`common.roles.space.${r}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <DialogFooter>
          <Button variant="gh" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="pri"
            disabled={!userId}
            loading={add.isPending}
            onClick={() => add.mutate()}
          >
            {t('spaces.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
