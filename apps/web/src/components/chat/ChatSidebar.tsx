import { Chip, cn, Count, Icon, IconButton, Kbd, Skeleton, Tooltip } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActionContextMenu } from '@/components/common/ActionMenu';
import { firstName } from '@/lib/chat/text';
import { archivedConversationsQuery, conversationsQuery } from '@/lib/chat/queries';
import { useTyping } from '@/lib/chat/stores';
import { type Conversation } from '@/lib/chat/types';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useArrivals, useBadgeMotion, useFlip, useReducedMotion } from '@/lib/motion';
import { useNow } from '@/lib/useNow';
import { ConversationAvatar, listTime, useMyId } from './common';
import { useConversationEntries } from './conversationMenu';
import { nameOf } from '@/lib/chat/names';
import { ModuleSidebar } from '@/components/shell/ModuleSidebar';
import { useShownPath } from '@/lib/shell';
import { localize } from '@crewhall/plugin-sdk';
import { PluginSettingsButton } from '@/components/plugins/PluginSettings';
import { pluginIcon, usePluginSurfaces } from '@/components/plugins/surfaces';

type Filter = 'unread' | 'direct' | 'group' | 'space' | 'meeting' | 'archive';
const FILTERS: Filter[] = ['unread', 'direct', 'group', 'space', 'meeting', 'archive'];

function matches(c: Conversation, f: Filter | null, q: string, locale: string): boolean {
  if (q && !c.title.toLocaleLowerCase(locale).includes(q)) return false;
  if (!f || f === 'archive') return true;
  if (f === 'unread') return c.my.unread > 0 || c.my.unreadMentions > 0;
  if (f === 'group') return c.type === 'group';
  if (f === 'space') return c.type === 'space' || c.type === 'alert';
  return c.type === f;
}

/** 248px chat list (4.1): pinned first, then by last message; filters and title search. */
export function ChatSidebar() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter | null>(null);
  const main = useQuery(conversationsQuery);
  // "Arşiv" (H19) lists chats archived for everyone or by me; the main list never shows them.
  const archived = useQuery({ ...archivedConversationsQuery, enabled: filter === 'archive' });
  const mainList = useMemo(() => main.data?.filter((c) => !c.my.archivedAt), [main.data]);
  const data = filter === 'archive' ? archived.data : mainList;
  const isPending = filter === 'archive' ? archived.isPending : main.isPending;
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const activeId = useRouterState({
    select: (s) => /^\/chat\/c\/([^/]+)/.exec(s.location.pathname)?.[1] ?? null,
  });
  // Phone (H10): on /chat the list is the whole screen; inside a chat it is the drawer.
  const atList = useShownPath() === '/chat';

  // Ctrl E focuses the chat search (4.1).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const query = q.trim().toLocaleLowerCase(locale);
  const list = useMemo(
    () => (data ?? []).filter((c) => matches(c, filter, query, locale)),
    [data, filter, query, locale],
  );
  const pinned = list.filter((c) => c.my.pinnedAt);
  const rest = list.filter((c) => !c.my.pinnedAt);
  // Rows slide to their new place (a chat with a new message jumps to the top); a chat that
  // just appeared rises in. Filtering and search swap the whole list, so those never count.
  const nav = useRef<HTMLElement>(null);
  useFlip(nav);
  const reduced = useReducedMotion();
  const keys = useMemo(() => (data ?? []).map((c) => c.id), [data]);
  const arrived = useArrivals(keys, { ready: !isPending, max: 2 });
  const fresh = (id: string) => !reduced && arrived.has(id);

  return (
    <ModuleSidebar
      label={t('chat.list.title')}
      className="w-[300px]"
      phone={atList ? 'full' : 'drawer'}
      collapsible={false}
      defaultWidth={300}
    >
      {/* Desktop app: drags the window like the title bar next to it (index.css). */}
      <div data-titlebar-drag="" className="flex h-14 shrink-0 items-center gap-1 pr-3 pl-5">
        <h1 className="m-0 flex-1 text-sub font-bold">{t('chat.list.title')}</h1>
        <Tooltip content={t('chat.list.newChat')}>
          <IconButton
            size="sm"
            tone="plain"
            aria-label={t('chat.list.newChat')}
            onClick={() => void navigate({ to: '/chat/new' })}
          >
            <Icon name="compose" size={17} />
          </IconButton>
        </Tooltip>
      </div>
      <form
        role="search"
        className="px-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) void navigate({ to: '/chat/search', search: { q: q.trim() } });
        }}
      >
        <label className="flex h-9 items-center gap-2 rounded-md bg-bg2 pr-1.5 pl-3 text-fg2 focus-within:shadow-[inset_0_0_0_1.5px_var(--fg)]">
          <Icon name="search" size={15} />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQ('');
            }}
            placeholder={t('chat.list.search')}
            aria-label={t('chat.list.search')}
            className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] text-fg outline-none placeholder:text-fg3"
          />
          <Kbd>Ctrl E</Kbd>
        </label>
      </form>
      <div
        className="flex shrink-0 gap-1.5 overflow-x-auto px-3 pt-2.5 pb-2 [scrollbar-width:none]"
        role="group"
        aria-label={t('chat.list.filters')}
      >
        {FILTERS.map((f) => (
          <Chip
            key={f}
            size="sm"
            on={filter === f}
            onClick={() => setFilter(filter === f ? null : f)}
          >
            {t(`chat.list.filter.${f}`)}
          </Chip>
        ))}
      </div>
      <nav ref={nav} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3">
        {isPending ? (
          <div className="flex flex-col gap-3 p-3" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-9 rounded-full" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="w-24" />
                  <Skeleton className="w-40" />
                </div>
              </div>
            ))}
          </div>
        ) : list.length === 0 ? (
          <p className="animate-fade-in px-3 py-6 text-center text-cap text-fg2">
            {query || filter ? t('chat.list.noMatch') : t('chat.list.empty')}
          </p>
        ) : (
          <div className="flex flex-col">
            {pinned.length ? (
              <Section label={t('chat.list.pinned')} icon="pin">
                {pinned.map((c) => (
                  <Row key={c.id} conv={c} active={c.id === activeId} fresh={fresh(c.id)} />
                ))}
              </Section>
            ) : null}
            {rest.length ? (
              <Section label={t('chat.list.recent')}>
                {rest.map((c) => (
                  <Row key={c.id} conv={c} active={c.id === activeId} fresh={fresh(c.id)} />
                ))}
              </Section>
            ) : null}
          </div>
        )}
      </nav>
      <PluginChatTabs />
    </ModuleSidebar>
  );
}

/** Plugin tabs placed in chat, e.g. WhatsApp (docs/contracts/eklentiler.md › Giriş noktaları). */
function PluginChatTabs() {
  const { t, locale } = useI18n();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const tabs = usePluginSurfaces().flatMap((s) =>
    s.tabs.filter((x) => x.placement === 'chat').map((tab) => ({ s, tab })),
  );
  if (tabs.length === 0) return null;
  return (
    <div
      className="shrink-0 border-t border-line px-2 py-2"
      role="group"
      aria-label={t('plugins.chat.tabs')}
    >
      <div className="eyebrow px-2.5 pb-1">{t('plugins.chat.tabs')}</div>
      {tabs.map(({ s, tab }) => {
        const to = `/chat/plugins/${s.installationId}/${tab.id}`;
        return (
          <div key={to} className="group/plugin relative">
            <Link
              to={to}
              className={cn(
                'flex h-9 items-center gap-2.5 rounded-md px-2.5 pr-9 text-cap font-semibold text-fg2 hover:bg-bg2 hover:text-fg',
                path.startsWith(to) && 'bg-bg2 text-fg',
              )}
            >
              <Icon name={pluginIcon(tab.icon)} size={16} />
              <span className="truncate">{localize(tab.title, locale)}</span>
            </Link>
            {/* "Bu eklentinin ayarları" (web has no bar over a chat plugin tab). */}
            <span className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity group-hover/plugin:opacity-100 focus-within:opacity-100">
              <PluginSettingsButton installationId={s.installationId} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Section({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: 'pin';
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col">
      <h2 className="m-0 flex items-center gap-1 px-3 pt-3 pb-1 text-[11px] font-bold tracking-[.06em] text-fg3 uppercase">
        {icon ? <Icon name={icon} size={11} /> : null}
        {label}
      </h2>
      <ul className="m-0 flex list-none flex-col gap-px p-0">{children}</ul>
    </section>
  );
}

function Row({ conv, active, fresh }: { conv: Conversation; active: boolean; fresh: boolean }) {
  const { t, locale } = useI18n();
  const me = useMyId();
  const now = useNow(60_000);
  const entries = useConversationEntries(conv);
  const typing = useTyping(conv.id);
  const unread = conv.my.unread > 0;
  const muted =
    conv.my.notify === 'none' ||
    (conv.my.mutedUntil !== null && Date.parse(conv.my.mutedUntil) > now);
  const last = conv.lastMessage;
  const badge = conv.my.unreadMentions > 0 ? 'mention' : unread ? 'unread' : null;
  const pulse = useBadgeMotion(badge ? conv.my.unreadMentions || conv.my.unread : 0);

  let preview: string;
  if (typing.length) {
    preview = t('chat.typing.one', { name: firstName(nameOf(typing[0] ?? '') ?? '') });
  } else if (!last) {
    preview = conv.type === 'direct' ? t('chat.list.draft') : t('chat.list.noMessages');
  } else if (last.deleted) {
    preview = t('chat.message.deleted');
  } else {
    const body = last.excerpt || (last.hasAttachments ? t('chat.list.attachment') : '');
    const who =
      last.kind === 'system'
        ? ''
        : last.authorId === me
          ? t('chat.list.you')
          : conv.type === 'direct'
            ? ''
            : firstName(last.authorName ?? '');
    preview = who ? `${who}: ${body}` : body;
  }

  return (
    <li data-flip-key={conv.id} className={cn(fresh && 'animate-rise-in')}>
      <ActionContextMenu entries={entries}>
        <Link
          to="/chat/c/$conversationId"
          params={{ conversationId: conv.id }}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors duration-(--t-fast)',
            active ? 'bg-capsule' : 'hover:bg-bg2',
          )}
        >
          <ConversationAvatar conv={conv} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-[14px] leading-5',
                  unread ? 'font-bold text-fg' : 'font-semibold text-fg',
                )}
              >
                {conv.title}
              </span>
              {conv.private ? (
                <Icon
                  name="lock"
                  size={12}
                  className="shrink-0 text-fg3"
                  aria-label={t('chat.header.private')}
                />
              ) : null}
              {muted ? <Icon name="speaker" size={12} className="shrink-0 text-fg3" /> : null}
              {conv.lastMessageAt ? (
                <span
                  className={cn(
                    'shrink-0 text-[11.5px]',
                    unread ? 'font-bold text-fg' : 'text-fg3',
                  )}
                >
                  {listTime(conv.lastMessageAt, locale, now, t('chat.time.yesterday'))}
                </span>
              ) : null}
            </span>
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-[12.5px] leading-[18px]',
                  typing.length ? 'text-fg2 italic' : unread ? 'font-semibold text-fg' : 'text-fg2',
                )}
              >
                {preview}
              </span>
              {badge === 'mention' ? (
                <Count
                  key={pulse.key}
                  tone="accent"
                  className={pulse.className}
                  aria-label={t('chat.list.mentions', { count: conv.my.unreadMentions })}
                >
                  @ {conv.my.unreadMentions}
                </Count>
              ) : badge === 'unread' ? (
                <Count
                  key={pulse.key}
                  tone={muted ? 'mute' : 'default'}
                  className={pulse.className}
                  aria-label={t('chat.list.unread', { count: conv.my.unread })}
                >
                  {conv.my.unread > 99 ? '99+' : conv.my.unread}
                </Count>
              ) : null}
            </span>
          </span>
        </Link>
      </ActionContextMenu>
    </li>
  );
}
