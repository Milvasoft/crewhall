import { queryKeys } from '@crewhall/api-client';
import { pagePath, type SpaceColor, type SpaceRole } from '@crewhall/shared';
import {
  Avatar,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogHeader,
  Field,
  Icon,
  IconButton,
  Input,
  Segmented,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SpaceBadge,
  toast,
  type IconName,
  SuggestionPanel,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ColorPicker } from '@/components/spaces/ColorPicker';
import { templatesQuery } from '@/components/templates/api';
import { SPACE_ICONS } from '@/components/spaces/spaceUtils';
import { api, idempotencyKey, isApiError } from '@/lib/api';
import { openDialog, useDialog } from '@/lib/dialogs';
import { useI18n } from '@/lib/i18n/I18nContext';
import { membersQuery } from '@/lib/queries';
import { useMe } from '@/lib/session';

type GrantRole = Exclude<SpaceRole, 'owner'>;
const GRANTABLE: GrantRole[] = ['admin', 'editor', 'viewer'];

/** "Yeni space" (doc 03 · 3.2): name, color, badge, members with roles. Creator becomes owner. */
export function NewSpaceDialog() {
  const open = useDialog() === 'newSpace';
  return (
    <Dialog open={open} onOpenChange={(v) => openDialog(v ? 'newSpace' : null)}>
      {open ? <NewSpaceForm /> : null}
    </Dialog>
  );
}

function NewSpaceForm() {
  const { t } = useI18n();
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [color, setColor] = useState<SpaceColor>('s5');
  const [badge, setBadge] = useState<'letter' | 'icon'>('letter');
  const [icon, setIcon] = useState<IconName>('folder');
  const [members, setMembers] = useState<{ userId: string; role: GrantRole }[]>([]);
  const [query, setQuery] = useState('');
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const people = useQuery(membersQuery({ status: 'active' }));
  // Space templates (roadmap 8): their pages and boards are added once the space exists.
  const spaceTemplates = (useQuery(templatesQuery()).data?.items ?? []).filter(
    (x) => x.kind === 'space',
  );
  const [templateRef, setTemplateRef] = useState('none');

  const create = useMutation({
    mutationFn: () =>
      api.call('createSpace', {
        body: { name: name.trim(), color, icon: badge === 'icon' ? icon : null, members },
        idempotencyKey: idempotencyKey(),
      }),
    onSuccess: async (space) => {
      await qc.invalidateQueries({ queryKey: queryKeys.spaces() });
      toast(t('spaces.created', { name: space.name }));
      if (templateRef !== 'none') {
        try {
          const res = await api.call('applyTemplate', {
            params: { templateRef },
            body: { spaceId: space.id, parentId: null },
          });
          if (res.skipped.length) {
            toast(t('templates.skipped', { modules: res.skipped.join(', ') }));
          }
          const first = res.nodes[0];
          openDialog(null);
          if (first?.type === 'page') {
            await navigate({ to: '/p/$pageRef', params: { pageRef: pagePath(first).slice(3) } });
            return;
          }
          if (first?.type === 'board') {
            await navigate({ to: '/b/$boardId', params: { boardId: first.id } });
            return;
          }
        } catch (e) {
          // The space exists; only its starting content failed.
          toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal'));
        }
      }
      openDialog(null);
      await navigate({ to: '/spaces/$spaceSlug/settings', params: { spaceSlug: space.slug } });
    },
    onError: (e) => setError(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });

  const byId = new Map(people.data?.items.map((m) => [m.user.id, m.user]) ?? []);
  const needle = query.trim().toLocaleLowerCase('tr');
  const suggestions = needle
    ? (people.data?.items ?? [])
        .filter((m) => m.user.id !== me?.user.id && !members.some((x) => x.userId === m.user.id))
        .filter(
          (m) =>
            m.user.name.toLocaleLowerCase('tr').includes(needle) || m.user.email.includes(needle),
        )
        .slice(0, 5)
    : [];

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return;
    create.mutate();
  }

  return (
    <DialogContent width={560} aria-describedby={undefined}>
      <div className="flex items-start justify-between">
        <DialogHeader title={t('spaces.new')} />
        <IconButton
          aria-label={t('common.actions.close')}
          tone="plain"
          size="sm"
          onClick={() => openDialog(null)}
        >
          <Icon name="x" size={18} />
        </IconButton>
      </div>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div className="flex gap-5">
          <div className="flex shrink-0 flex-col items-center gap-2.5">
            <SpaceBadge color={color} name={name || '?'} size="xl">
              {badge === 'icon' ? <Icon name={icon} size={28} strokeWidth={2.2} /> : undefined}
            </SpaceBadge>
            <Segmented
              size="sm"
              aria-label={t('spaces.badge')}
              value={badge}
              onValueChange={setBadge}
              options={[
                { value: 'letter', label: t('spaces.badgeLetter') },
                { value: 'icon', label: t('spaces.badgeIcon') },
              ]}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <Field label={t('spaces.name')} error={error ?? undefined}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                autoFocus
              />
            </Field>
            <Field label={t('spaces.color')}>
              <div className="flex items-center justify-between gap-3">
                <ColorPicker value={color} onChange={setColor} />
                <span className="text-xs text-fg3">{t('spaces.colorHint')}</span>
              </div>
            </Field>
            {badge === 'icon' ? (
              <div
                className="flex flex-wrap gap-1.5"
                role="radiogroup"
                aria-label={t('spaces.badgeIcon')}
              >
                {SPACE_ICONS.map((i) => (
                  <button
                    key={i}
                    type="button"
                    role="radio"
                    aria-checked={icon === i}
                    aria-label={i}
                    onClick={() => setIcon(i)}
                    className={cn(
                      'flex size-8 items-center justify-center rounded-sm bg-bg2 text-fg2 hover:text-fg',
                      icon === i && 'bg-fg text-bg hover:text-bg',
                    )}
                  >
                    <Icon name={i} size={16} />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-cap font-medium text-fg2">{t('spaces.membersAndRoles')}</span>
          <SuggestionPanel
            open={suggestions.length > 0 && dismissed !== query}
            onDismiss={() => setDismissed(query)}
            anchor={
              <div>
                <Input
                  icon="userPlus"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('spaces.addPerson')}
                  aria-label={t('spaces.addPerson')}
                />
              </div>
            }
          >
            <ul className="m-0 flex list-none flex-col gap-px p-0">
              {suggestions.map((m) => (
                <li key={m.user.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setMembers((x) => [...x, { userId: m.user.id, role: 'editor' }]);
                      setQuery('');
                    }}
                    className="flex h-11 w-full items-center gap-2.5 rounded-sm px-2 text-left hover:bg-capsule"
                  >
                    <Avatar name={m.user.name} size="sm" />
                    <span className="text-sm font-medium">{m.user.name}</span>
                    <span className="text-xs text-fg2">{m.user.email}</span>
                  </button>
                </li>
              ))}
            </ul>
          </SuggestionPanel>
          <div className="flex flex-col rounded-xl px-3 shadow-line">
            {me ? (
              <MemberRow name={me.user.name} email={me.user.email} you={t('spaces.you')}>
                <span className="px-3 text-cap font-medium text-fg">
                  {t('common.roles.space.owner')}
                </span>
              </MemberRow>
            ) : null}
            {members.map((m) => {
              const u = byId.get(m.userId);
              if (!u) return null;
              return (
                <MemberRow key={m.userId} name={u.name} email={u.email}>
                  <Select
                    value={m.role}
                    onValueChange={(role) =>
                      setMembers((x) =>
                        x.map((y) =>
                          y.userId === m.userId ? { ...y, role: role as GrantRole } : y,
                        ),
                      )
                    }
                  >
                    <SelectTrigger
                      size="sm"
                      className="h-8 w-auto bg-transparent shadow-line2"
                      aria-label={t('spaces.role')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GRANTABLE.map((r) => (
                        <SelectItem key={r} value={r}>
                          {t(`common.roles.space.${r}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <IconButton
                    aria-label={t('common.actions.delete')}
                    size="xs"
                    tone="plain"
                    onClick={() => setMembers((x) => x.filter((y) => y.userId !== m.userId))}
                  >
                    <Icon name="x" size={14} />
                  </IconButton>
                </MemberRow>
              );
            })}
          </div>
        </div>

        {spaceTemplates.length ? (
          <Field label={t('templates.newSpace.label')} hint={t('templates.newSpace.hint')}>
            <Select value={templateRef} onValueChange={setTemplateRef}>
              <SelectTrigger aria-label={t('templates.newSpace.label')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('templates.newSpace.none')}</SelectItem>
                {spaceTemplates.map((x) => (
                  <SelectItem key={x.id} value={x.id}>
                    {x.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-xs text-fg2">
            {members.length ? t('spaces.notify', { count: members.length }) : ''}
          </span>
          <div className="flex gap-2">
            <Button variant="gh" onClick={() => openDialog(null)}>
              {t('common.actions.cancel')}
            </Button>
            <Button type="submit" variant="pri" loading={create.isPending} disabled={!name.trim()}>
              {t('spaces.create')}
            </Button>
          </div>
        </div>
      </form>
    </DialogContent>
  );
}

function MemberRow({
  name,
  email,
  you,
  children,
}: {
  name: string;
  email: string;
  you?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-14 items-center gap-3 border-b border-line py-2 last:border-b-0">
      <Avatar name={name} size="md" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold">
          {name}
          {you ? <span className="font-normal text-fg2"> · {you}</span> : null}
        </span>
        <span className="truncate text-xs text-fg2">{email}</span>
      </div>
      {children}
    </div>
  );
}
