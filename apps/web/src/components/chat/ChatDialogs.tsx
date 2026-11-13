import { FederationDomain, type UserSummary } from '@crewhall/shared';
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  Input,
  Radio,
  RadioGroup,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  SpaceBadge,
  toast,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { excerptOf } from '@/lib/chat/names';
import { removeConversation, upsertConversation } from '@/lib/chat/cache';
import { enqueue } from '@/lib/chat/outbox';
import { chatKeys, conversationsQuery, membersQuery as chatMembersQuery } from '@/lib/chat/queries';
import { type Conversation, type HistoryShare, type Message } from '@/lib/chat/types';
import { errorKey } from '@/lib/errors';
import {
  conversationSharesQuery,
  federationKeys,
  isFederatedAddress,
  sharedFoldersQuery,
} from '@/lib/federation/queries';
import { formatDate, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { membersQuery, spaceMembersQuery } from '@/lib/queries';
import { useSpaces } from '@/lib/useSpaces';
import { ConversationAvatar, PersonAvatar, useMyId } from './common';
import { EmojiField } from './EmojiField';
import { openChatDialog, useChatDialog } from './dialogs';

const close = () => openChatDialog(null);

export function ChatDialogs() {
  const d = useChatDialog();
  return (
    <Dialog open={d !== null} onOpenChange={(o) => !o && close()}>
      {d?.kind === 'rename' ? <RenameBody conv={d.conv} /> : null}
      {d?.kind === 'addPeople' ? <AddPeopleBody conv={d.conv} /> : null}
      {d?.kind === 'members' ? <MembersBody conv={d.conv} /> : null}
      {d?.kind === 'linkSpace' ? <LinkSpaceBody conv={d.conv} /> : null}
      {d?.kind === 'privacy' ? <PrivacyBody conv={d.conv} /> : null}
      {d?.kind === 'leave' ? <LeaveBody conv={d.conv} /> : null}
      {d?.kind === 'clear' ? <ClearBody conv={d.conv} /> : null}
      {d?.kind === 'addRemote' ? <AddRemoteBody conv={d.conv} /> : null}
      {d?.kind === 'shareOrg' ? <ShareOrgBody conv={d.conv} /> : null}
      {d?.kind === 'sharedFolders' ? <SharedFoldersBody conv={d.conv} /> : null}
      {d?.kind === 'deleteAll' ? <DeleteAllBody conv={d.conv} /> : null}
      {d?.kind === 'deleteMessage' ? <DeleteBody m={d.message} others={d.others} /> : null}
      {d?.kind === 'forward' ? <ForwardBody m={d.message} /> : null}
      {d?.kind === 'messageInfo' ? <MessageInfoBody m={d.message} conv={d.conv} /> : null}
    </Dialog>
  );
}

/** "Mesaj bilgisi" (own messages): who saw it and when, who has not yet. */
function MessageInfoBody({ m, conv }: { m: Message; conv: Conversation }) {
  const { t, locale } = useI18n();
  const { data, isPending, isError } = useQuery({
    queryKey: ['chat', 'messageInfo', m.id],
    queryFn: () => api.call('getMessageInfo', { params: { messageId: m.id } }),
  });
  const when = (at: string | null) =>
    at
      ? `${formatDate(at, locale, { day: 'numeric', month: 'short' })} ${formatTime(at, locale)}`
      : t('chat.info.unknownTime');
  const direct = conv.type === 'direct';
  return (
    <DialogContent width={440}>
      <DialogHeader
        title={t('chat.info.title')}
        description={
          data && !direct
            ? t('chat.info.summary', { count: data.seenCount, total: data.total })
            : undefined
        }
      />
      {isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : isError || !data ? (
        <p className="m-0 text-cap text-fg2">{t('errors.internal')}</p>
      ) : direct ? (
        <p className="m-0 text-cap">
          {data.seen[0]
            ? t('chat.info.directSeen', { when: when(data.seen[0].at) })
            : t('chat.info.directNotSeen')}
        </p>
      ) : (
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
          <section aria-label={t('chat.info.seen')} className="flex flex-col gap-1">
            <h3 className="m-0 text-[11px] font-bold tracking-[.06em] text-fg3 uppercase">
              {t('chat.info.seen')} · {data.seen.length}
            </h3>
            {data.seen.map((s) => (
              <div key={s.user.id} className="flex items-center gap-2 py-1">
                <PersonAvatar user={s.user} size="sm" />
                <span className="min-w-0 flex-1 truncate text-cap font-semibold">
                  {s.user.name}
                </span>
                <span className="text-xs text-fg2">{when(s.at)}</span>
              </div>
            ))}
          </section>
          <section aria-label={t('chat.info.notSeen')} className="flex flex-col gap-1">
            <h3 className="m-0 text-[11px] font-bold tracking-[.06em] text-fg3 uppercase">
              {t('chat.info.notSeen')} · {data.notSeen.length}
            </h3>
            {data.notSeen.map((u) => (
              <div key={u.id} className="flex items-center gap-2 py-1">
                <PersonAvatar user={u} size="sm" />
                <span className="min-w-0 flex-1 truncate text-cap">{u.name}</span>
              </div>
            ))}
          </section>
        </div>
      )}
      <DialogFooter>
        <Button variant="gh" onClick={close}>
          {t('common.actions.close')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function useFail() {
  const { t } = useI18n();
  return (e: unknown) => toast.error(t(errorKey(e)));
}

/** 4.6 "Gruba ad ver": the name changes for everyone and a system line is written. */
function RenameBody({ conv }: { conv: Conversation }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  const [name, setName] = useState(conv.name ?? '');
  const [emoji, setEmoji] = useState<string | null>(conv.emoji ?? null);
  const [busy, setBusy] = useState(false);
  const emojiChanged = emoji !== (conv.emoji ?? null);
  const save = async (value: string | null) => {
    setBusy(true);
    try {
      upsertConversation(
        qc,
        await api.call('updateConversation', {
          params: { conversationId: conv.id },
          body: {
            ...(value !== (conv.name ?? null) ? { name: value } : {}),
            ...(emojiChanged ? { emoji } : {}),
          },
        }),
      );
      close();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogContent width={440}>
      <DialogHeader
        title={t(
          conv.type === 'group' ? 'chat.dialogs.rename.groupTitle' : 'chat.dialogs.rename.title',
        )}
        description={conv.type === 'group' ? t('chat.dialogs.rename.hint') : undefined}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void save(name.trim());
          else if (emojiChanged) void save(conv.name ?? null);
        }}
        className="flex flex-col gap-4"
      >
        <Field label={t('chat.dialogs.rename.name')}>
          <Input
            value={name}
            maxLength={80}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder={conv.title}
          />
        </Field>
        <Field label={t('chat.emoji.label')} hint={t('chat.emoji.hint')}>
          <EmojiField value={emoji} onChange={setEmoji} />
        </Field>
        <DialogFooter>
          {conv.type === 'group' && conv.name ? (
            <Button
              variant="gh"
              className="mr-auto"
              disabled={busy}
              onClick={() => void save(null)}
            >
              {t('chat.dialogs.rename.clear')}
            </Button>
          ) : null}
          <Button variant="gh" onClick={close}>
            {t('common.actions.cancel')}
          </Button>
          <Button
            type="submit"
            variant="inv"
            loading={busy}
            disabled={!name.trim() && !emojiChanged}
          >
            {t('common.actions.save')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/**
 * Org people with search; `exclude` hides people who are already in. With `spaceId` only that
 * space's members are offered (private channels take people from their space).
 */
export function PeoplePicker({
  selected,
  onToggle,
  exclude = [],
  spaceId,
}: {
  selected: string[];
  onToggle: (u: UserSummary) => void;
  exclude?: string[];
  spaceId?: string | null | undefined;
}) {
  const { t, locale } = useI18n();
  const me = useMyId();
  const [q, setQ] = useState('');
  const org = useQuery({
    ...membersQuery({ q: q.trim() || undefined, status: 'active' }),
    enabled: !spaceId,
  });
  const space = useQuery({ ...spaceMembersQuery(spaceId ?? ''), enabled: Boolean(spaceId) });
  const needle = q.trim().toLocaleLowerCase(locale);
  const pool = spaceId
    ? (space.data?.items ?? [])
        .map((m) => m.user)
        .filter(
          (u) =>
            !needle ||
            u.name.toLocaleLowerCase(locale).includes(needle) ||
            u.email.toLocaleLowerCase(locale).includes(needle),
        )
    : (org.data?.items ?? []).map((m) => m.user);
  const people = pool.filter((u) => u.id !== me && !exclude.includes(u.id));
  return (
    <div className="flex flex-col gap-2">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('chat.dialogs.people.search')}
        aria-label={t('chat.dialogs.people.search')}
        autoFocus
      />
      <ul className="m-0 flex max-h-[260px] list-none flex-col overflow-y-auto p-0">
        {people.map((u) => (
          <li key={u.id}>
            <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-bg2">
              <Checkbox
                checked={selected.includes(u.id)}
                onCheckedChange={() => onToggle(u)}
                aria-label={u.name}
              />
              <PersonAvatar user={u} size="md" card={false} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-cap font-semibold">{u.name}</span>
                <span className="truncate text-xs text-fg2">{u.email}</span>
              </span>
            </label>
          </li>
        ))}
        {people.length === 0 ? (
          <li className="px-2 py-4 text-center text-cap text-fg2">
            {t('chat.dialogs.people.none')}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/** 4.8: add people to a group, choosing how much history they see (default 7 days). */
function AddPeopleBody({ conv }: { conv: Conversation }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  const { data: members } = useQuery(chatMembersQuery(conv.id));
  const [picked, setPicked] = useState<UserSummary[]>([]);
  const [history, setHistory] = useState<HistoryShare>('days7');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.call('addConversationMembers', {
        params: { conversationId: conv.id },
        body: { userIds: picked.map((u) => u.id), history },
      });
      void qc.invalidateQueries({ queryKey: chatKeys.members(conv.id) });
      upsertConversation(
        qc,
        await api.call('getConversation', { params: { conversationId: conv.id } }),
      );
      close();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogContent width={500}>
      <DialogHeader
        title={t('chat.dialogs.add.title')}
        description={t('chat.dialogs.add.subtitle', { name: conv.title, count: conv.memberCount })}
      />
      <PeoplePicker
        selected={picked.map((u) => u.id)}
        exclude={(members ?? []).map((m) => m.user.id)}
        spaceId={conv.private ? conv.spaceId : null}
        onToggle={(u) =>
          setPicked((cur) =>
            cur.some((x) => x.id === u.id) ? cur.filter((x) => x.id !== u.id) : [...cur, u],
          )
        }
      />
      {conv.type === 'group' || conv.private ? (
        <div className="flex flex-col gap-2">
          <span className="text-cap font-semibold">{t('chat.dialogs.add.history')}</span>
          <RadioGroup
            value={history}
            onValueChange={(v) => setHistory(v as HistoryShare)}
            className="flex flex-col gap-1.5"
          >
            {(['none', 'days7', 'days30', 'all'] as const).map((h) => (
              <label
                key={h}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 shadow-line',
                  history === h && 'shadow-[inset_0_0_0_1.5px_var(--fg)]',
                )}
              >
                <Radio
                  value={h}
                  aria-label={t(`chat.dialogs.add.historyOptions.${h}`)}
                  className="mt-0.5"
                />
                <span className="flex flex-col">
                  <span className="text-cap font-semibold">
                    {t(`chat.dialogs.add.historyOptions.${h}`)}
                  </span>
                  <span className="text-xs text-fg2">
                    {t(`chat.dialogs.add.historyHints.${h}`)}
                  </span>
                </span>
              </label>
            ))}
          </RadioGroup>
          <p className="m-0 text-xs text-fg2">{t('chat.dialogs.add.systemLine')}</p>
        </div>
      ) : null}
      <DialogFooter>
        <Button variant="gh" onClick={close}>
          {t('common.actions.cancel')}
        </Button>
        <Button
          variant="inv"
          loading={busy}
          disabled={picked.length === 0}
          onClick={() => void save()}
        >
          {t('chat.dialogs.add.submit', { count: picked.length })}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** Roadmap 26: a person on a peered installation joins a group or space channel homed here. */
function AddRemoteBody({ conv }: { conv: Conversation }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = isFederatedAddress(address.trim().toLowerCase());
  const save = async () => {
    setBusy(true);
    try {
      const next = await api.call('addRemoteConversationMember', {
        params: { conversationId: conv.id },
        body: { address: address.trim().toLowerCase() },
      });
      upsertConversation(qc, next);
      const added = next.federation?.remoteMembers.find(
        (m) => m.address === address.trim().toLowerCase(),
      );
      close();
      toast(t('federation.chat.addedRemote', { name: added?.name ?? address }));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogContent width={460}>
      <DialogHeader
        icon="globe"
        title={t('federation.chat.addRemote')}
        description={t('federation.chat.addRemoteHint')}
      />
      <Field label={t('federation.chat.address')}>
        <Input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ok && !busy) void save();
          }}
          placeholder="ayse@hub.ornek.com"
          autoFocus
        />
      </Field>
      <DialogFooter>
        <Button variant="gh" onClick={close}>
          {t('common.actions.cancel')}
        </Button>
        <Button variant="pri" loading={busy} disabled={!ok} onClick={() => void save()}>
          {t('federation.chat.add')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** Shared channels: invite a peered organization; the shares so far, which can be closed. */
function ShareOrgBody({ conv }: { conv: Conversation }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  const shares = useQuery(conversationSharesQuery(conv.id));
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const value = domain.trim().toLowerCase();
  const ok = FederationDomain.safeParse(value).success;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: federationKeys.shares });
    void qc.invalidateQueries({ queryKey: chatKeys.all });
  };
  const invite = async () => {
    setBusy('invite');
    try {
      await api.call('shareChannel', {
        params: { conversationId: conv.id },
        body: { domain: value },
      });
      setDomain('');
      refresh();
      toast(t('federation.shared.invitedToast', { domain: value }));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };
  const end = async (shareId: string) => {
    setBusy(shareId);
    try {
      await api.call('endSharedChannel', { params: { shareId } });
      refresh();
      toast(t('federation.shared.ended'));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };
  const open = (shares.data?.items ?? []).filter(
    (s) => s.status === 'active' || s.status === 'invited',
  );
  return (
    <DialogContent width={480}>
      <DialogHeader
        icon="globe"
        title={t('federation.shared.shareTitle')}
        description={t('federation.shared.shareHint')}
      />
      <Field label={t('federation.shared.domain')}>
        <Input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ok && !busy) void invite();
          }}
          placeholder="hub.ornek.com"
          className="font-mono"
          autoFocus
        />
      </Field>
      {open.length ? (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-bold tracking-[.06em] text-fg3 uppercase">
            {t('federation.shared.sharedWith')}
          </span>
          <ul className="m-0 flex list-none flex-col p-0">
            {open.map((s) => (
              <li key={s.id} className="flex items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-cap">
                  {s.orgName ?? s.domain}
                  <span className="ml-1.5 font-mono text-xs text-fg2">{s.domain}</span>
                </span>
                <Badge tone={s.status === 'active' ? 'ok' : 'warn'}>
                  {t(`federation.shared.status.${s.status}`)}
                </Badge>
                <Button
                  size="xs"
                  variant="dng"
                  loading={busy === s.id}
                  onClick={() => void end(s.id)}
                >
                  {s.status === 'invited'
                    ? t('federation.shared.withdraw')
                    : t('federation.shared.remove')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <DialogFooter>
        <Button variant="gh" onClick={close}>
          {t('common.actions.cancel')}
        </Button>
        <Button
          variant="pri"
          loading={busy === 'invite'}
          disabled={!ok}
          onClick={() => void invite()}
        >
          {t('federation.shared.invite')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** Shared channels 2: the channel's shared folders; on the host, a folder of the space joins it. */
function SharedFoldersBody({ conv }: { conv: Conversation }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  const { items: spaces } = useSpaces();
  const space = spaces.find((s) => s.id === conv.spaceId);
  const host = conv.federation?.shared?.role === 'host';
  const folders = useQuery(sharedFoldersQuery(conv.id));
  const candidates = useQuery({
    queryKey: ['federation', 'folder-candidates', conv.spaceId],
    enabled: host && !!conv.spaceId,
    queryFn: ({ signal }) =>
      api.call('listNodes', {
        params: { spaceId: conv.spaceId! },
        query: { type: 'folder' },
        signal,
      }),
  });
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const items = folders.data?.items ?? [];
  const active = items.filter((f) => f.status === 'active');
  const taken = new Set(active.map((f) => f.nodeId));
  const options = (candidates.data?.items ?? []).filter((n) => !taken.has(n.id));
  const refresh = () =>
    void qc.invalidateQueries({ queryKey: federationKeys.sharedFolders(conv.id) });
  const share = async () => {
    setBusy('share');
    try {
      const f = await api.call('shareFolder', {
        params: { conversationId: conv.id },
        body: { nodeId: chosen },
      });
      setChosen('');
      refresh();
      toast(t('federation.shared.folderShared', { name: f.name }));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };
  const stop = async (folderId: string) => {
    setBusy(folderId);
    try {
      await api.call('endSharedFolder', { params: { conversationId: conv.id, folderId } });
      refresh();
      toast(t('federation.shared.folderStopped'));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <DialogContent width={500}>
      <DialogHeader
        icon="folder"
        title={t('federation.shared.folders')}
        description={
          host ? t('federation.shared.foldersHint') : t('federation.shared.foldersGuestHint')
        }
      />
      {items.length === 0 ? (
        <p className="m-0 text-cap text-fg2">{t('federation.shared.foldersEmpty')}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {items.map((f) => (
            <li key={f.id} className="flex items-center gap-2 py-1.5">
              <Icon name="folder" size={15} />
              <span className="min-w-0 flex-1 truncate text-cap">{f.name}</span>
              <Badge tone={f.status === 'active' ? 'ok' : undefined}>
                {t(`federation.shared.folderStatus.${f.status}`)}
              </Badge>
              {f.nodeId && space ? (
                <Button size="xs" variant="gh" asChild>
                  <Link
                    to="/drive/$spaceSlug/folder/$folderId"
                    params={{ spaceSlug: space.slug, folderId: f.nodeId }}
                    onClick={close}
                  >
                    {t('federation.shared.folderOpen')}
                  </Link>
                </Button>
              ) : null}
              {f.status === 'active' && (host || f.role === 'guest') ? (
                <Button
                  size="xs"
                  variant="dng"
                  loading={busy === f.id}
                  onClick={() => void stop(f.id)}
                >
                  {t('federation.shared.folderStop')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {host ? (
        <Field label={t('federation.shared.folderPick')}>
          <Select value={chosen} onValueChange={setChosen}>
            <SelectTrigger aria-label={t('federation.shared.folderPick')}>
              <SelectValue placeholder={t('federation.shared.folderPick')} />
            </SelectTrigger>
            <SelectContent>
              {options.map((n) => (
                <SelectItem key={n.id} value={n.id}>
                  {n.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      <DialogFooter>
        <Button variant="gh" onClick={close}>
          {t('common.actions.close')}
        </Button>
        {host ? (
          <Button
            variant="pri"
            loading={busy === 'share'}
            disabled={!chosen}
            onClick={() => void share()}
          >
            {t('federation.shared.shareFolder')}
          </Button>
        ) : null}
      </DialogFooter>
    </DialogContent>
  );
}

function MembersBody({ conv }: { conv: Conversation }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  const me = useMyId();
  const { data } = useQuery(chatMembersQuery(conv.id));
  const canRemove = conv.permissions.manage && (conv.type !== 'space' || conv.private === true);
  // Private channels: owners (and space admins) make others owners; one owner always stays.
  const owners = (data ?? []).filter((m) => m.role === 'owner').length;
  const setRole = async (userId: string, role: 'owner' | 'member') => {
    try {
      qc.setQueryData(
        chatKeys.members(conv.id),
        (
          await api.call('updateConversationMember', {
            params: { conversationId: conv.id, userId },
            body: { role },
          })
        ).items,
      );
    } catch (e) {
      fail(e);
    }
  };
  return (
    <DialogContent width={460}>
      <DialogHeader
        title={t('chat.dialogs.members.title', { count: conv.memberCount })}
        description={conv.title}
      />
      <ul className="m-0 flex max-h-[380px] list-none flex-col overflow-y-auto p-0">
        {(data ?? []).map((m) => (
          <li key={m.user.id} className="flex items-center gap-3 rounded-md px-2 py-1.5">
            <PersonAvatar user={m.user} size="md" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-cap font-semibold">
                {m.user.name}
                {m.user.id === me ? ` ${t('chat.dialogs.members.you')}` : ''}
              </span>
              <span className="truncate text-xs text-fg2">
                {m.spaceRole ? t(`common.roles.space.${m.spaceRole}`) : m.user.email}
                {m.isGuest ? ` · ${t('chat.person.guest')}` : ''}
              </span>
            </span>
            {m.role === 'owner' ? <Badge>{t('chat.dialogs.members.owner')}</Badge> : null}
            {conv.private && conv.permissions.manage && !m.isGuest ? (
              m.role === 'owner' ? (
                owners > 1 ? (
                  <Button size="xs" variant="gh" onClick={() => void setRole(m.user.id, 'member')}>
                    {t('chat.dialogs.members.makeMember')}
                  </Button>
                ) : null
              ) : (
                <Button size="xs" variant="gh" onClick={() => void setRole(m.user.id, 'owner')}>
                  {t('chat.dialogs.members.makeOwner')}
                </Button>
              )
            ) : null}
            {canRemove && m.user.id !== me ? (
              <Button
                size="xs"
                variant="dng"
                onClick={async () => {
                  try {
                    await api.call('removeConversationMember', {
                      params: { conversationId: conv.id, userId: m.user.id },
                    });
                    void qc.invalidateQueries({ queryKey: chatKeys.members(conv.id) });
                    upsertConversation(
                      qc,
                      await api.call('getConversation', { params: { conversationId: conv.id } }),
                    );
                  } catch (e) {
                    fail(e);
                  }
                }}
              >
                {t('chat.dialogs.members.remove')}
              </Button>
            ) : null}
          </li>
        ))}
        {conv.federation?.remoteMembers.length ? (
          <li className="px-2 pt-3 pb-1 text-[11px] font-bold tracking-[.06em] text-fg3 uppercase">
            {t('federation.chat.remoteMembers')}
          </li>
        ) : null}
        {(conv.federation?.remoteMembers ?? []).map((r) => {
          const blocked = conv.federation?.blocked?.includes(r.address) ?? false;
          return (
            <li key={r.address} className="flex items-center gap-3 rounded-md px-2 py-1.5">
              <Avatar name={r.name} size="md" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-cap font-semibold">{r.name}</span>
                <span className="truncate text-xs text-fg2">{r.address}</span>
              </span>
              {blocked ? <Badge tone="warn">{t('federation.shared.blocked')}</Badge> : null}
              {conv.permissions.manage && conv.federation?.shared ? (
                <Button
                  size="xs"
                  variant={blocked ? 'out' : 'dng'}
                  onClick={async () => {
                    try {
                      upsertConversation(
                        qc,
                        await api.call('blockRemoteMember', {
                          params: { conversationId: conv.id },
                          body: { address: r.address, blocked: !blocked },
                        }),
                      );
                      close();
                      toast(
                        t(
                          blocked
                            ? 'federation.shared.unblockedToast'
                            : 'federation.shared.blockedToast',
                          { address: r.address },
                        ),
                      );
                    } catch (e) {
                      fail(e);
                    }
                  }}
                >
                  {blocked ? t('federation.shared.unblock') : t('federation.shared.block')}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <DialogFooter>
        {(conv.type === 'group' || conv.type === 'alert' || conv.private) &&
        conv.permissions.manage ? (
          <Button
            variant="out"
            className="mr-auto"
            onClick={() => openChatDialog({ kind: 'addPeople', conv })}
          >
            <Icon name="userPlus" size={15} />
            {t('chat.menu.addPeople')}
          </Button>
        ) : null}
        <Button variant="inv" onClick={close}>
          {t('common.actions.close')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** 4.6 "Space'e bağla": the group becomes a space chat; history and files stay. */
function LinkSpaceBody({ conv }: { conv: Conversation }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  const { items: spaces } = useSpaces();
  const options = spaces.filter(
    (s) => s.kind === 'shared' && (s.myRole === 'owner' || s.myRole === 'admin'),
  );
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <DialogContent width={460}>
      <DialogHeader
        title={t('chat.dialogs.link.title')}
        description={t('chat.dialogs.link.hint')}
      />
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {options.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              aria-pressed={spaceId === s.id}
              onClick={() => setSpaceId(s.id)}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-bg2',
                spaceId === s.id && 'bg-capsule hover:bg-capsule',
              )}
            >
              <SpaceBadge color={s.color} name={s.name} size="md" />
              <span className="text-cap font-semibold">{s.name}</span>
            </button>
          </li>
        ))}
        {options.length === 0 ? (
          <li className="text-cap text-fg2">{t('chat.dialogs.link.none')}</li>
        ) : null}
      </ul>
      <DialogFooter>
        <Button variant="gh" onClick={close}>
          {t('common.actions.cancel')}
        </Button>
        <Button
          variant="inv"
          loading={busy}
          disabled={!spaceId}
          onClick={async () => {
            if (!spaceId) return;
            setBusy(true);
            try {
              upsertConversation(
                qc,
                await api.call('linkConversationSpace', {
                  params: { conversationId: conv.id },
                  body: { spaceId },
                }),
              );
              close();
            } catch (e) {
              fail(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('chat.dialogs.link.submit')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/**
 * Open ↔ private (Teams-like). Going private adds everyone in the space now, who can then be
 * removed; going open hands the channel and its history to the whole space.
 */
function PrivacyBody({ conv }: { conv: Conversation }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  const [busy, setBusy] = useState(false);
  const toPrivate = !conv.private;
  return (
    <DialogContent width={460}>
      <DialogHeader
        title={t(
          toPrivate ? 'chat.dialogs.privacy.privateTitle' : 'chat.dialogs.privacy.openTitle',
          {
            name: conv.title,
          },
        )}
        description={t(
          toPrivate ? 'chat.dialogs.privacy.privateBody' : 'chat.dialogs.privacy.openBody',
        )}
      />
      <DialogFooter>
        <Button variant="gh" onClick={close}>
          {t('common.actions.cancel')}
        </Button>
        <Button
          variant="inv"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              upsertConversation(
                qc,
                await api.call('updateConversation', {
                  params: { conversationId: conv.id },
                  body: { private: toPrivate },
                }),
              );
              void qc.invalidateQueries({ queryKey: chatKeys.members(conv.id) });
              close();
            } catch (e) {
              fail(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t(toPrivate ? 'chat.dialogs.privacy.privateSubmit' : 'chat.dialogs.privacy.openSubmit')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function LeaveBody({ conv }: { conv: Conversation }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const fail = useFail();
  const [busy, setBusy] = useState(false);
  return (
    <DialogContent width={420}>
      <DialogHeader
        icon="logout"
        title={t('chat.dialogs.leave.title', { name: conv.title })}
        description={t('chat.dialogs.leave.body')}
      />
      <DialogFooter>
        <Button variant="gh" onClick={close}>
          {t('common.actions.cancel')}
        </Button>
        <Button
          variant="dngf"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.call('leaveConversation', { params: { conversationId: conv.id } });
              removeConversation(qc, conv.id);
              close();
              await navigate({ to: '/chat' });
            } catch (e) {
              fail(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('chat.dialogs.leave.submit')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** H19 "Benim için sil": hidden from me only; a new message brings the chat back empty. */
function ClearBody({ conv }: { conv: Conversation }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const fail = useFail();
  const [busy, setBusy] = useState(false);
  return (
    <DialogContent width={440}>
      <DialogHeader
        icon="trash"
        title={t('chat.dialogs.clear.title', { name: conv.title })}
        description={t('chat.dialogs.clear.body')}
      />
      <DialogFooter>
        <Button variant="gh" onClick={close}>
          {t('common.actions.cancel')}
        </Button>
        <Button
          variant="dngf"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.call('clearConversation', { params: { conversationId: conv.id } });
              removeConversation(qc, conv.id);
              void qc.invalidateQueries({ queryKey: chatKeys.archived });
              close();
              toast(t('chat.archive.cleared'));
              await navigate({ to: '/chat' });
            } catch (e) {
              fail(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('chat.dialogs.clear.submit')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** H19 "Herkes için sil": owner or org admin; typed name confirms, everyone loses it. */
function DeleteAllBody({ conv }: { conv: Conversation }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const fail = useFail();
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const ok = typed.trim() === conv.title.trim();
  return (
    <DialogContent width={460}>
      <DialogHeader
        icon="alert"
        title={t('chat.dialogs.deleteAll.title', { name: conv.title })}
        description={t('chat.dialogs.deleteAll.body')}
      />
      <Field label={t('chat.dialogs.deleteAll.confirm')}>
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={conv.title} />
      </Field>
      <DialogFooter>
        <Button variant="gh" onClick={close}>
          {t('common.actions.cancel')}
        </Button>
        <Button
          variant="dngf"
          loading={busy}
          disabled={!ok}
          onClick={async () => {
            setBusy(true);
            try {
              await api.call('deleteConversation', { params: { conversationId: conv.id } });
              removeConversation(qc, conv.id);
              void qc.invalidateQueries({ queryKey: chatKeys.archived });
              close();
              toast(t('chat.archive.deleted'));
              await navigate({ to: '/chat' });
            } catch (e) {
              fail(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('chat.dialogs.deleteAll.submit')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function DeleteBody({ m, others }: { m: Message; others: boolean }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  const [busy, setBusy] = useState(false);
  return (
    <DialogContent width={420}>
      <DialogHeader
        icon="trash"
        title={t('chat.dialogs.delete.title')}
        description={t(others ? 'chat.dialogs.delete.others' : 'chat.dialogs.delete.body', {
          name: m.author?.name ?? '',
        })}
      />
      {m.attachments.length ? (
        <p className="m-0 text-cap text-fg2">
          {t('chat.dialogs.delete.files', { count: m.attachments.length })}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="gh" onClick={close}>
          {t('common.actions.cancel')}
        </Button>
        <Button
          variant="dngf"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const res = await api.call('deleteMessage', { params: { messageId: m.id } });
              qc.setQueryData(
                chatKeys.messages(m.conversationId),
                (w: { items: Message[] } | undefined) =>
                  w ? { ...w, items: w.items.map((x) => (x.id === res.id ? res : x)) } : w,
              );
              close();
            } catch (e) {
              fail(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('common.actions.delete')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** "İlet": the text goes to another chat as a new message (files stay where they are). */
function ForwardBody({ m }: { m: Message }) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const { data } = useQuery(conversationsQuery);
  const [q, setQ] = useState('');
  const list = useMemo(
    () =>
      (data ?? [])
        .filter((c) => c.permissions.write && c.id !== m.conversationId)
        .filter(
          (c) => !q || c.title.toLocaleLowerCase(locale).includes(q.toLocaleLowerCase(locale)),
        ),
    [data, q, m.conversationId, locale],
  );
  return (
    <DialogContent width={460}>
      <DialogHeader
        title={t('chat.dialogs.forward.title')}
        description={excerptOf(m).slice(0, 140)}
      />
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('chat.list.search')}
        aria-label={t('chat.list.search')}
        autoFocus
      />
      <ul className="m-0 flex max-h-[320px] list-none flex-col overflow-y-auto p-0">
        {list.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-bg2"
              onClick={() => {
                const who = m.author?.name ?? m.webhook?.name ?? '';
                enqueue({
                  conversationId: c.id,
                  text: t('chat.dialogs.forward.text', { name: who, text: m.text || excerptOf(m) }),
                  replyTo: null,
                  attachments: [],
                  ...(m.refs?.length && !c.federation ? { refs: m.refs } : {}),
                });
                close();
                void navigate({ to: '/chat/c/$conversationId', params: { conversationId: c.id } });
              }}
            >
              <ConversationAvatar conv={c} size="md" />
              <span className="truncate text-cap font-semibold">{c.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </DialogContent>
  );
}
