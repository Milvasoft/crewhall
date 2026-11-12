import { type DirectoryPerson, type UpdateDirectoryProfile } from '@crewhall/shared';
import {
  Avatar,
  Button,
  DatePicker,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Textarea,
  toast,
} from '@crewhall/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formatDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useMe } from '@/lib/session';
import { contactsKeys, directoryQuery, orgChartQuery, personQuery } from '@/lib/contacts/queries';
import { ActionContextMenu } from '@/components/common/ActionMenu';
import { usePersonEntries } from './ContactMenus';
import { ResizablePane } from '@/components/shell/ResizablePane';

/** Directory list (roadmap 15): people of the org with title, department and phones. */
export function DirectoryList({
  q,
  department,
  selected,
  onSelect,
}: {
  q: string;
  department?: string;
  selected: string | null;
  onSelect: (userId: string) => void;
}) {
  const { t } = useI18n();
  const list = useInfiniteQuery(directoryQuery({ q: q || undefined, department }));
  const menu = usePersonEntries();
  const people = list.data?.pages.flatMap((p) => p.items) ?? [];
  if (list.isLoading) return <Skeleton className="h-40" />;
  if (!people.length) {
    return (
      <EmptyState
        icon="users"
        title={t('contacts.directory.emptyTitle')}
        description={t('contacts.directory.empty')}
      />
    );
  }
  return (
    <div className="flex flex-col" data-testid="directory-list">
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-2 p-0">
        {people.map((p) => (
          <li key={p.user.id} className="min-w-0">
            <ActionContextMenu entries={menu(p)}>
              <button
                type="button"
                onClick={() => onSelect(p.user.id)}
                aria-pressed={selected === p.user.id}
                className="flex w-full items-center gap-3 rounded-xl bg-bg2 p-3 text-left hover:bg-capsule aria-pressed:shadow-line2"
              >
                <Avatar name={p.user.name} src={p.user.imageUrl} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-semibold">{p.user.name}</span>
                  <span className="truncate text-xs text-fg2">
                    {[p.title, p.department].filter(Boolean).join(' · ') || p.user.email}
                  </span>
                </span>
              </button>
            </ActionContextMenu>
          </li>
        ))}
      </ul>
      {list.hasNextPage ? (
        <Button
          variant="gh"
          size="sm"
          className="mt-3 self-center"
          loading={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t('contacts.more')}
        </Button>
      ) : null}
    </div>
  );
}

const FIELDS = ['title', 'department', 'team', 'phone', 'mobile', 'location'] as const;

/** Right panel: a person's directory card, their manager and reports; edit where allowed. */
export function PersonPanel({
  userId,
  onClose,
  onSelect,
}: {
  userId: string;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const person = useQuery(personQuery(userId));
  const reports = useQuery({
    ...orgChartQuery(),
    select: (d) => d.items.filter((n) => n.managerId === userId),
  });
  const [editing, setEditing] = useState(false);
  const p = person.data;
  return (
    <ResizablePane id="contacts-detail" side="right" defaultWidth={340}>
      <aside
        aria-label={p?.user.name ?? t('contacts.title')}
        className="flex w-full min-w-0 flex-col gap-4 overflow-y-auto border-l border-line bg-bg px-5 py-4"
        data-testid="person-panel"
      >
        <div className="flex items-start justify-end gap-1">
          {p?.permissions.edit && !editing ? (
            <IconButton
              size="sm"
              tone="plain"
              aria-label={t('contacts.actions.edit')}
              onClick={() => setEditing(true)}
            >
              <Icon name="edit" size={16} />
            </IconButton>
          ) : null}
          <IconButton
            size="sm"
            tone="plain"
            aria-label={t('common.actions.close')}
            onClick={onClose}
          >
            <Icon name="x" size={16} />
          </IconButton>
        </div>
        {!p ? (
          <Skeleton className="h-48" />
        ) : editing ? (
          <ProfileForm person={p} onDone={() => setEditing(false)} />
        ) : (
          <>
            <div className="flex flex-col items-center gap-2 text-center">
              <Avatar name={p.user.name} src={p.user.imageUrl} size="lg" />
              <h2 className="text-lg font-bold">{p.user.name}</h2>
              {p.title ? <span className="text-sm text-fg2">{p.title}</span> : null}
              <Button asChild size="sm" variant="out">
                <Link to="/people/$userId" params={{ userId: p.user.id }}>
                  {t('contacts.directory.openProfile')}
                </Link>
              </Button>
            </div>
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-fg3">{t('contacts.fields.email')}</dt>
              <dd className="m-0 truncate">
                <a href={`mailto:${p.user.email}`} className="hover:underline">
                  {p.user.email}
                </a>
              </dd>
              {FIELDS.map((f) =>
                p[f] ? (
                  <Row
                    key={f}
                    label={t(`contacts.fields.${f}`)}
                    value={p[f]!}
                    synced={p.syncedFields.includes(f)}
                  />
                ) : null,
              )}
            </dl>
            {p.about ? <p className="text-sm whitespace-pre-wrap">{p.about}</p> : null}
            {p.manager ? (
              <div className="flex flex-col gap-1.5">
                <span className="eyebrow">{t('contacts.fields.manager')}</span>
                <PersonLink user={p.manager} onSelect={onSelect} />
              </div>
            ) : null}
            {reports.data?.length ? (
              <div className="flex flex-col gap-1.5">
                <span className="eyebrow">
                  {t('contacts.directory.reports', { count: reports.data.length })}
                </span>
                {reports.data.map((r) => (
                  <PersonLink key={r.user.id} user={r.user} sub={r.title} onSelect={onSelect} />
                ))}
              </div>
            ) : null}
            {p.fromDirectory ? (
              <p className="text-xs text-fg3">{t('contacts.directory.fromDirectory')}</p>
            ) : null}
          </>
        )}
      </aside>
    </ResizablePane>
  );
}

function Row({ label, value, synced }: { label: string; value: string; synced: boolean }) {
  const { t } = useI18n();
  return (
    <>
      <dt className="text-fg3">{label}</dt>
      <dd className="m-0 flex items-center gap-1.5 truncate">
        <span className="truncate">{value}</span>
        {synced ? (
          <Icon
            name="lock"
            size={12}
            className="text-fg3"
            aria-label={t('contacts.directory.synced')}
          />
        ) : null}
      </dd>
    </>
  );
}

function PersonLink({
  user,
  sub,
  onSelect,
}: {
  user: DirectoryPerson['user'];
  sub?: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(user.id)}
      className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-bg2"
    >
      <Avatar name={user.name} src={user.imageUrl} size="sm" />
      <span className="min-w-0 flex-1 truncate font-semibold">{user.name}</span>
      {sub ? <span className="truncate text-xs text-fg3">{sub}</span> : null}
    </button>
  );
}

const NO_MANAGER = 'none';
const NO_DATE = 'none';

function ProfileForm({ person, onDone }: { person: DirectoryPerson; onDone: () => void }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const chart = useQuery({ ...orgChartQuery(), enabled: person.permissions.editManager });
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      [...FIELDS, 'about'].map((f) => [f, person[f as (typeof FIELDS)[number]] ?? '']),
    ),
  );
  const [managerId, setManagerId] = useState(person.manager?.id ?? NO_MANAGER);
  const own = useMe()?.user.id === person.user.id;
  const [birthMonth, setBirthMonth] = useState(person.birthday?.slice(0, 2) ?? NO_DATE);
  const [birthDay, setBirthDay] = useState(person.birthday?.slice(3) ?? NO_DATE);
  const [birthdayVisible, setBirthdayVisible] = useState(person.birthdayVisible ?? false);
  const [startedOn, setStartedOn] = useState(person.startedOn ?? '');
  const save = useMutation({
    mutationFn: () => {
      const body: UpdateDirectoryProfile = {};
      for (const f of [...FIELDS, 'about'] as const) {
        if (f !== 'about' && person.syncedFields.includes(f)) continue;
        const v = draft[f]!.trim();
        const old = person[f] ?? '';
        if (v !== old) body[f] = v || null;
      }
      if (person.permissions.editManager && !person.syncedFields.includes('managerId')) {
        const next = managerId === NO_MANAGER ? null : managerId;
        if (next !== (person.manager?.id ?? null)) body.managerId = next;
      }
      const birthday =
        birthMonth !== NO_DATE && birthDay !== NO_DATE ? `${birthMonth}-${birthDay}` : null;
      if (birthday !== (person.birthday ?? null)) body.birthday = birthday;
      if (own && birthdayVisible !== (person.birthdayVisible ?? false)) {
        body.birthdayVisible = birthdayVisible;
      }
      if ((startedOn || null) !== (person.startedOn ?? null)) body.startedOn = startedOn || null;
      return api.call('updateDirectoryProfile', { params: { userId: person.user.id }, body });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: contactsKeys.all });
      onDone();
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h2 className="text-base font-bold">{person.user.name}</h2>
      {FIELDS.map((f) => (
        <Field
          key={f}
          label={t(`contacts.fields.${f}`)}
          hint={person.syncedFields.includes(f) ? t('contacts.directory.synced') : undefined}
        >
          <Input
            value={draft[f]}
            maxLength={f === 'phone' || f === 'mobile' ? 40 : 120}
            disabled={person.syncedFields.includes(f)}
            onChange={(e) => setDraft((d) => ({ ...d, [f]: e.target.value }))}
          />
        </Field>
      ))}
      {person.permissions.editManager ? (
        <Field
          label={t('contacts.fields.manager')}
          hint={
            person.syncedFields.includes('managerId') ? t('contacts.directory.synced') : undefined
          }
        >
          <Select
            value={managerId}
            onValueChange={setManagerId}
            disabled={person.syncedFields.includes('managerId')}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_MANAGER}>{t('contacts.directory.noManager')}</SelectItem>
              {(chart.data?.items ?? [])
                .filter((n) => n.user.id !== person.user.id)
                .map((n) => (
                  <SelectItem key={n.user.id} value={n.user.id}>
                    {n.user.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      <Field label={t('announcements.kudos.profile.birthday')}>
        <div className="flex gap-2">
          <Select value={birthDay} onValueChange={setBirthDay}>
            <SelectTrigger aria-label={t('announcements.kudos.profile.birthDay')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_DATE}>—</SelectItem>
              {Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0')).map((d) => (
                <SelectItem key={d} value={d}>
                  {Number(d)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={birthMonth} onValueChange={setBirthMonth}>
            <SelectTrigger aria-label={t('announcements.kudos.profile.birthMonth')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_DATE}>—</SelectItem>
              {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')).map((m) => (
                <SelectItem key={m} value={m}>
                  {formatDate(`2000-${m}-15T12:00:00`, locale, { month: 'long' })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Field>
      {own ? (
        <label className="flex items-center gap-2.5 text-cap">
          <Switch
            checked={birthdayVisible}
            onCheckedChange={setBirthdayVisible}
            aria-label={t('announcements.kudos.profile.showBirthday')}
          />
          <span className="flex flex-col">
            {t('announcements.kudos.profile.showBirthday')}
            <span className="text-xs text-fg2">
              {t('announcements.kudos.profile.showBirthdayHint')}
            </span>
          </span>
        </label>
      ) : null}
      <Field label={t('announcements.kudos.profile.startedOn')}>
        <DatePicker
          value={startedOn || null}
          onChange={(v) => setStartedOn(v ?? '')}
          aria-label={t('announcements.kudos.profile.startedOn')}
        />
      </Field>
      <Field label={t('contacts.fields.about')}>
        <Textarea
          rows={3}
          maxLength={2000}
          value={draft.about}
          onChange={(e) => setDraft((d) => ({ ...d, about: e.target.value }))}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="gh" onClick={onDone}>
          {t('common.actions.cancel')}
        </Button>
        <Button type="submit" variant="pri" loading={save.isPending}>
          {t('common.actions.save')}
        </Button>
      </div>
    </form>
  );
}
