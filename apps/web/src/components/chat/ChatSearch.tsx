import {
  Button,
  Chip,
  EmptyState,
  Icon,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Skeleton,
} from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Fragment, useMemo, useState } from 'react';
import { conversationsQuery, searchQuery } from '@/lib/chat/queries';
import { formatDate, formatTime } from '@/lib/i18n/format';
import { BarClose } from '@/components/shell/BarClose';
import { useTitleBarProps } from '@/lib/desktop-titlebar';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useNow } from '@/lib/useNow';
import { membersQuery } from '@/lib/queries';
import { ConversationAvatar, PersonAvatar } from './common';
import { PhoneBack } from '@/components/shell/ModuleSidebar';

export interface ChatSearchParams {
  q?: string;
  from?: string;
  conv?: string;
  file?: boolean;
  days?: number;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);

/** Server excerpt: only `<mark>` is markup, the rest is escaped text; matches are bold and underlined. */
function Highlight({ html }: { html: string }) {
  const parts = html.split(/(<mark>[\s\S]*?<\/mark>)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('<mark>') ? (
          <b key={i} className="font-bold underline underline-offset-2">
            {decode(p.slice(6, -7))}
          </b>
        ) : (
          <Fragment key={i}>{decode(p)}</Fragment>
        ),
      )}
    </>
  );
}

/** 4.16: chats by title, then every message the person can read; filters as chips, "from:" too. */
export function ChatSearch({ params }: { params: ChatSearchParams }) {
  const { t, locale } = useI18n();
  // In the desktop app this bar is the window's title bar (lib/desktop-titlebar).
  const titleBar = useTitleBarProps<HTMLElement>();
  const navigate = useNavigate();
  const [input, setInput] = useState(params.q ?? '');
  // Day precision is enough for the date chip; keeps the query key stable while typing.
  const now = Math.floor(useNow() / 86_400_000) * 86_400_000;
  const { data: members } = useQuery(membersQuery({ status: 'active' }));
  const { data: convs } = useQuery(conversationsQuery);
  const people = (members?.items ?? []).map((m) => m.user);

  const set = (patch: Partial<ChatSearchParams>) =>
    void navigate({ to: '/chat/search', search: { ...params, ...patch } });

  // "from:mert retry" becomes a Kimden chip.
  const submit = () => {
    let q = input.trim();
    let from = params.from;
    const m = /(?:^|\s)from:(\S+)/i.exec(q);
    if (m) {
      const key = (m[1] ?? '').toLocaleLowerCase(locale);
      const who = people.find(
        (p) =>
          p.email.toLocaleLowerCase(locale).startsWith(key) ||
          p.name
            .toLocaleLowerCase(locale)
            .split(/\s+/)
            .some((x) => x.startsWith(key)),
      );
      if (who) from = who.id;
      q = q.replace(m[0], ' ').trim();
      setInput(q);
    }
    set({ q, from });
  };

  const after = params.days ? new Date(now - params.days * 86_400_000).toISOString() : undefined;
  const query = {
    q: params.q ?? '',
    fromUserId: params.from,
    conversationId: params.conv,
    hasFile: params.file ? 'true' : undefined,
    after,
  };
  const { data, isFetching } = useQuery(searchQuery(query));
  const needle = (params.q ?? '').toLocaleLowerCase(locale);
  const chats = useMemo(
    () =>
      needle ? (convs ?? []).filter((c) => c.title.toLocaleLowerCase(locale).includes(needle)) : [],
    [convs, needle, locale],
  );
  const matchedPeople = needle
    ? people.filter((p) => p.name.toLocaleLowerCase(locale).includes(needle)).slice(0, 6)
    : [];
  const fromPerson = people.find((p) => p.id === params.from);
  const inConv = convs?.find((c) => c.id === params.conv);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header
        {...titleBar}
        className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-3 md:px-6"
      >
        <PhoneBack to="/chat" />
        <form
          role="search"
          className="flex h-9 flex-1 items-center gap-2 rounded-md bg-bg2 px-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Icon name="search" size={16} className="text-fg2" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoFocus
            aria-label={t('chat.search.label')}
            placeholder={t('chat.search.placeholder')}
            className="h-full flex-1 bg-transparent text-[14px] outline-none placeholder:text-fg3"
          />
        </form>
        <BarClose onClick={() => void navigate({ to: '/chat' })} />
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
        {chats.length || matchedPeople.length ? (
          <div className="grid gap-4 md:grid-cols-2">
            <section className="flex flex-col gap-1.5">
              <h2 className="m-0 text-[11px] font-bold tracking-[.06em] text-fg3 uppercase">
                {t('chat.search.chats', { count: chats.length })}
              </h2>
              {chats.slice(0, 5).map((c) => (
                <Link
                  key={c.id}
                  to="/chat/c/$conversationId"
                  params={{ conversationId: c.id }}
                  className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-bg2"
                >
                  <ConversationAvatar conv={c} size="md" />
                  <span className="truncate text-cap font-semibold">{c.title}</span>
                </Link>
              ))}
            </section>
            <section className="flex flex-col gap-1.5">
              <h2 className="m-0 text-[11px] font-bold tracking-[.06em] text-fg3 uppercase">
                {t('chat.search.people')}
              </h2>
              {matchedPeople.length ? (
                matchedPeople.map((p) => (
                  <Link
                    key={p.id}
                    to="/people/$userId"
                    params={{ userId: p.id }}
                    className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-bg2"
                  >
                    <PersonAvatar user={p} size="md" />
                    <span className="truncate text-cap font-semibold">{p.name}</span>
                  </Link>
                ))
              ) : (
                <span className="text-cap text-fg2">
                  {t('chat.search.noPeople', { q: params.q ?? '' })}
                </span>
              )}
            </section>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Menu>
            <MenuTrigger asChild>
              <Chip size="sm" on={Boolean(fromPerson)}>
                {fromPerson
                  ? t('chat.search.fromWho', { name: fromPerson.name })
                  : t('chat.search.from')}
                <Icon name="chevD" size={12} />
              </Chip>
            </MenuTrigger>
            <MenuContent className="max-h-[300px] w-[240px] overflow-y-auto">
              {fromPerson ? (
                <MenuItem onSelect={() => set({ from: undefined })}>
                  {t('chat.search.anyone')}
                </MenuItem>
              ) : null}
              {people.map((p) => (
                <MenuItem key={p.id} onSelect={() => set({ from: p.id })}>
                  {p.name}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
          <Menu>
            <MenuTrigger asChild>
              <Chip size="sm" on={Boolean(inConv)}>
                {inConv ? inConv.title : t('chat.search.inChat')}
                <Icon name="chevD" size={12} />
              </Chip>
            </MenuTrigger>
            <MenuContent className="max-h-[300px] w-[260px] overflow-y-auto">
              {inConv ? (
                <MenuItem onSelect={() => set({ conv: undefined })}>
                  {t('chat.search.allChats')}
                </MenuItem>
              ) : null}
              {(convs ?? []).map((c) => (
                <MenuItem key={c.id} onSelect={() => set({ conv: c.id })}>
                  {c.title}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
          <Chip
            size="sm"
            on={Boolean(params.file)}
            onClick={() => set({ file: params.file ? undefined : true })}
          >
            {t('chat.search.hasFile')}
          </Chip>
          <Menu>
            <MenuTrigger asChild>
              <Chip size="sm" on={Boolean(params.days)}>
                {params.days
                  ? t('chat.search.lastDays', { days: params.days })
                  : t('chat.search.date')}
                <Icon name="chevD" size={12} />
              </Chip>
            </MenuTrigger>
            <MenuContent className="w-[200px]">
              <MenuItem onSelect={() => set({ days: undefined })}>
                {t('chat.search.anyTime')}
              </MenuItem>
              {[7, 30, 90].map((d) => (
                <MenuItem key={d} onSelect={() => set({ days: d })}>
                  {t('chat.search.lastDays', { days: d })}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
          {params.from || params.conv || params.file || params.days ? (
            <Button
              size="xs"
              variant="gh"
              onClick={() =>
                set({ from: undefined, conv: undefined, file: undefined, days: undefined })
              }
            >
              {t('chat.search.clear')}
            </Button>
          ) : null}
        </div>
        {!params.q ? (
          <EmptyState
            className="m-auto"
            icon="search"
            title={t('chat.search.start')}
            description={t('chat.search.startHint')}
          />
        ) : isFetching && !data ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : data && data.items.length === 0 ? (
          <EmptyState
            className="m-auto"
            icon="search"
            title={t('chat.search.none', { q: params.q })}
            description={t('chat.search.noneHint')}
          />
        ) : (
          <section className="flex flex-col gap-2">
            <h2 className="m-0 text-cap font-semibold">
              {t('chat.search.results', { q: params.q, count: data?.items.length ?? 0 })}
            </h2>
            <ul className="stagger-in m-0 flex list-none flex-col gap-2 p-0">
              {(data?.items ?? []).map((h) => (
                <li
                  key={h.message.id}
                  className="flex gap-3 rounded-xl p-3 shadow-line hover:bg-bg2"
                >
                  {h.message.author ? (
                    <PersonAvatar user={h.message.author} size="md" />
                  ) : (
                    <Icon name="alert" size={18} />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-2 text-xs text-fg2">
                      <span className="font-bold text-fg">{h.conversation.title}</span>
                      <span>
                        {h.message.author?.name ?? h.message.webhook?.name} ·{' '}
                        {formatDate(h.message.createdAt, locale, {
                          day: 'numeric',
                          month: 'short',
                        })}{' '}
                        {formatTime(h.message.createdAt, locale)}
                      </span>
                      <Button
                        size="xs"
                        variant="gh"
                        className="ml-auto"
                        onClick={() =>
                          void navigate({
                            to: '/chat/c/$conversationId',
                            params: { conversationId: h.conversation.id },
                            search: { seq: h.message.seq },
                          })
                        }
                      >
                        {t('chat.search.show')}
                      </Button>
                    </div>
                    <p className="m-0 text-[13.5px] leading-5">
                      <Highlight html={h.highlight} />
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
