import { type UserSummary } from '@crewhall/shared';
import {
  Avatar,
  Button,
  cn,
  Field,
  Icon,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SpaceBadge,
  SuggestionPanel,
  toast,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState, type KeyboardEvent } from 'react';
import { api } from '@/lib/api';
import { upsertConversation } from '@/lib/chat/cache';
import { conversationsQuery } from '@/lib/chat/queries';
import { firstName } from '@/lib/chat/text';
import { errorKey } from '@/lib/errors';
import { domainOf, isFederatedAddress, myFederationAddressQuery } from '@/lib/federation/queries';
import { BarClose } from '@/components/shell/BarClose';
import { useTitleBarProps } from '@/lib/desktop-titlebar';
import { useI18n } from '@/lib/i18n/I18nContext';
import { membersQuery } from '@/lib/queries';
import { useSpaces } from '@/lib/useSpaces';
import { newId } from '@/lib/ids';
import { PersonAvatar, useMyId } from './common';
import { PhoneBack } from '@/components/shell/ModuleSidebar';
import { EmojiField } from './EmojiField';

/** 4.7 "Yeni sohbet": one person → direct (or the existing one), 2+ → group; exists on the first message. */
export function NewChat() {
  const { t, locale } = useI18n();
  // In the desktop app this bar is the window's title bar (lib/desktop-titlebar).
  const titleBar = useTitleBarProps<HTMLElement>();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMyId();
  const { items: spaces } = useSpaces();
  const { data: convs } = useQuery(conversationsQuery);
  const [q, setQ] = useState('');
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [picked, setPicked] = useState<UserSummary[]>([]);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<string | null>(null);
  const [spaceId, setSpaceId] = useState<string>('none');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const { data } = useQuery(membersQuery({ q: q.trim() || undefined, status: 'active' }));
  const fed = useQuery(myFederationAddressQuery);
  // `handle@domain` of another installation (roadmap 26): offered next to local people.
  const typed = q.trim().toLowerCase();
  const remoteAddress =
    fed.data?.enabled &&
    isFederatedAddress(typed) &&
    domainOf(typed) !== domainOf(fed.data.address) &&
    picked.length === 0
      ? typed
      : null;

  const people = (data?.items ?? [])
    .map((m) => m.user)
    .filter((u) => !picked.some((p) => p.id === u.id))
    .slice(0, 8);
  const needle = q.trim().toLocaleLowerCase(locale);
  const spaceChats = useMemo(
    () =>
      needle
        ? (convs ?? [])
            .filter((c) => c.type === 'space' && c.title.toLocaleLowerCase(locale).includes(needle))
            .slice(0, 4)
        : [],
    [convs, needle, locale],
  );
  const adminSpaces = spaces.filter(
    (s) => s.kind === 'shared' && (s.myRole === 'owner' || s.myRole === 'admin'),
  );
  const spaceMode = spaceId !== 'none';
  const group = picked.length >= 2;
  const existing =
    picked.length === 1
      ? convs?.find((c) => c.type === 'direct' && c.peer?.id === picked[0]?.id)
      : undefined;

  const add = (u: UserSummary) => {
    setPicked((cur) => [...cur, u]);
    setQ('');
    setActive(0);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = people.length || 1;
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const u = people[active];
      if (u && q.trim()) add(u);
      else if (remoteAddress && !busy) void openRemote(remoteAddress);
    } else if (e.key === 'Backspace' && !q && picked.length) {
      setPicked((cur) => cur.slice(0, -1));
    }
  };

  const openRemote = async (address: string) => {
    setBusy(true);
    try {
      const conv = await api.call('createRemoteConversation', { body: { address } });
      if (text.trim()) {
        await api.call('sendMessage', {
          params: { conversationId: conv.id },
          body: { clientMsgId: newId(), text: text.trim(), attachmentNodeIds: [] },
        });
      }
      upsertConversation(qc, conv);
      await navigate({ to: '/chat/c/$conversationId', params: { conversationId: conv.id } });
    } catch (e) {
      toast.error(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    const message = text.trim()
      ? { clientMsgId: newId(), text: text.trim(), attachmentNodeIds: [] }
      : undefined;
    setBusy(true);
    try {
      const conv = spaceMode
        ? await api.call('createConversation', {
            body: {
              type: 'space',
              spaceId,
              name: name.trim(),
              message,
              ...(emoji ? { emoji } : {}),
            },
          })
        : picked.length === 1 && picked[0]
          ? await api.call('createConversation', {
              body: { type: 'direct', userId: picked[0].id, message },
            })
          : await api.call('createConversation', {
              body: {
                type: 'group',
                userIds: picked.map((p) => p.id),
                name: name.trim() || undefined,
                message,
                ...(emoji ? { emoji } : {}),
              },
            });
      upsertConversation(qc, conv);
      await navigate({ to: '/chat/c/$conversationId', params: { conversationId: conv.id } });
    } catch (e) {
      toast.error(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  const ready = spaceMode
    ? name.trim().length > 0
    : picked.length > 0 && (group ? Boolean(text.trim()) : true);
  const summary = spaceMode
    ? t('chat.new.spaceSummary')
    : picked.length === 0
      ? t('chat.new.pickHint')
      : group
        ? t('chat.new.groupSummary', { count: picked.length })
        : t('chat.new.directSummary');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header
        {...titleBar}
        className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-3 md:px-6"
      >
        <PhoneBack to="/chat" />
        <h1 className="m-0 text-[15px] font-bold">{t('chat.new.title')}</h1>
        <BarClose className="ml-auto" onClick={() => void navigate({ to: '/chat' })} />
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
        {!spaceMode ? (
          <SuggestionPanel
            open={Boolean(q.trim()) && dismissed !== q}
            onDismiss={() => setDismissed(q)}
            anchor={
              <label className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-lg px-3 py-1.5 shadow-line2 focus-within:shadow-[inset_0_0_0_1.5px_var(--fg)]">
                <span className="text-cap font-semibold text-fg2">{t('chat.new.to')}</span>
                {picked.map((p) => (
                  <span
                    key={p.id}
                    className="flex h-7 items-center gap-1.5 rounded-full bg-bg2 pr-1 pl-1"
                  >
                    <Avatar name={p.name} src={p.imageUrl} size="sm" />
                    <span className="text-xs font-semibold">{p.name}</span>
                    <IconButton
                      size="xs"
                      tone="plain"
                      className="size-5"
                      aria-label={t('chat.new.remove', { name: p.name })}
                      onClick={() => setPicked((cur) => cur.filter((x) => x.id !== p.id))}
                    >
                      <Icon name="x" size={11} />
                    </IconButton>
                  </span>
                ))}
                <input
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setActive(0);
                  }}
                  onKeyDown={onKey}
                  autoFocus
                  aria-label={t('chat.new.to')}
                  placeholder={picked.length ? '' : t('chat.new.toPlaceholder')}
                  className="h-8 min-w-[160px] flex-1 bg-transparent text-[14px] outline-none placeholder:text-fg3"
                />
              </label>
            }
          >
            <span className="px-2.5 pt-1 pb-1 text-[11px] font-bold tracking-[.06em] text-fg3 uppercase">
              {t('chat.new.people')}
            </span>
            {people.map((u, i) => (
              <button
                key={u.id}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(u);
                }}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left',
                  i === active && 'bg-bg2',
                )}
              >
                <PersonAvatar user={u} size="md" card={false} />
                <span className="flex flex-col">
                  <span className="text-cap font-semibold">
                    {u.name}
                    {u.id === me ? ` ${t('chat.dialogs.members.you')}` : ''}
                  </span>
                  <span className="text-xs text-fg2">{u.email}</span>
                </span>
              </button>
            ))}
            {people.length === 0 && !remoteAddress ? (
              <span className="px-2.5 py-2 text-cap text-fg2">{t('chat.dialogs.people.none')}</span>
            ) : null}
            {remoteAddress ? (
              <>
                <span className="px-2.5 pt-2 pb-1 text-[11px] font-bold tracking-[.06em] text-fg3 uppercase">
                  {t('federation.chat.remotePerson')}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    void openRemote(remoteAddress);
                  }}
                  className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left hover:bg-bg2"
                >
                  <span className="grid size-8 place-items-center rounded-full bg-bg2 text-fg2">
                    <Icon name="globe" size={16} />
                  </span>
                  <span className="flex flex-col">
                    <span className="text-cap font-semibold">
                      {t('federation.chat.remoteHint', { address: remoteAddress })}
                    </span>
                    <span className="text-xs text-fg2">{domainOf(remoteAddress)}</span>
                  </span>
                </button>
              </>
            ) : null}
            {spaceChats.length ? (
              <>
                <span className="px-2.5 pt-2 pb-1 text-[11px] font-bold tracking-[.06em] text-fg3 uppercase">
                  {t('chat.new.spaces')}
                </span>
                {spaceChats.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      void navigate({
                        to: '/chat/c/$conversationId',
                        params: { conversationId: c.id },
                      });
                    }}
                    className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left hover:bg-bg2"
                  >
                    {c.spaceColor ? (
                      <SpaceBadge color={c.spaceColor} name={c.title} size="md" />
                    ) : null}
                    <span className="flex flex-col">
                      <span className="text-cap font-semibold">{c.title}</span>
                      <span className="text-xs text-fg2">
                        {t('chat.new.goSpace', { count: c.memberCount })}
                      </span>
                    </span>
                  </button>
                ))}
              </>
            ) : null}
          </SuggestionPanel>
        ) : null}
        <div className="flex flex-wrap items-end gap-3">
          {group || spaceMode ? (
            <Field
              label={spaceMode ? t('chat.new.spaceName') : t('chat.new.groupName')}
              className="min-w-[240px] flex-1"
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                placeholder={spaceMode ? '' : picked.map((p) => firstName(p.name)).join(', ')}
              />
            </Field>
          ) : null}
          {group || spaceMode ? (
            <Field label={t('chat.emoji.label')}>
              <EmojiField value={emoji} onChange={setEmoji} />
            </Field>
          ) : null}
          {adminSpaces.length && picked.length !== 1 ? (
            <Field label={t('chat.new.linkSpace')} className="w-[240px]">
              <Select value={spaceId} onValueChange={setSpaceId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('chat.new.noSpace')}</SelectItem>
                  {adminSpaces.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
        </div>
        <p className="m-0 text-cap text-fg2">{summary}</p>
        {existing ? (
          <Button
            variant="out"
            className="self-start"
            onClick={() =>
              void navigate({
                to: '/chat/c/$conversationId',
                params: { conversationId: existing.id },
              })
            }
          >
            <Icon name="chat" size={15} />
            {t('chat.new.openExisting')}
          </Button>
        ) : null}
        <div className="mt-auto flex flex-col gap-2">
          {group || spaceMode ? (
            <p className="m-0 text-xs text-fg2">{t('chat.new.firstMessageHint')}</p>
          ) : null}
          <div className="flex items-end gap-2 rounded-xl px-4 py-2 shadow-line2 focus-within:shadow-[inset_0_0_0_1.5px_var(--fg)]">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (ready && !busy) void create();
                }
              }}
              rows={2}
              aria-label={t('chat.new.firstMessage')}
              placeholder={t('chat.new.firstMessage')}
              className="min-h-10 flex-1 resize-none bg-transparent py-1.5 text-[14px] outline-none placeholder:text-fg3"
            />
            <Button
              variant="inv"
              size="sm"
              loading={busy}
              disabled={!ready}
              onClick={() => void create()}
            >
              <Icon name="send" size={15} />
              {picked.length === 1 && !text.trim() && !spaceMode
                ? t('chat.new.open')
                : t('chat.composer.send')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
