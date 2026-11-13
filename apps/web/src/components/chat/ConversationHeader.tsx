import {
  cn,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  SpaceDot,
  Tooltip,
} from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { ActionDropdown } from '@/components/common/ActionMenu';
import { CallButton } from '@/components/meet/CallButton';
import { MeetingChatJoin } from '@/components/meet/MeetingChat';
import { StartMeetingButton } from '@/components/meet/StartMeetingButton';
import { userCardQuery } from '@/lib/chat/queries';
import { usePresence } from '@/lib/chat/stores';
import { type Conversation } from '@/lib/chat/types';
import { useTitleBarProps } from '@/lib/desktop-titlebar';
import { useI18n } from '@/lib/i18n/I18nContext';
import { ConversationAvatar, useConversationSubtitle } from './common';
import { useConversationEntries } from './conversationMenu';
import { openChatDialog } from './dialogs';
import { useLocalTime, usePresenceLabel } from './PersonCard';
import { PhoneBack } from '@/components/shell/ModuleSidebar';
import { useShellLayout } from '@/lib/shell';

/** Title bar of a chat: who or what, tabs, and the chat menu (4.1, 4.5, 4.11). */
export function ConversationHeader({
  conv,
  tab,
}: {
  conv: Conversation;
  tab: 'chat' | 'files' | 'pinned';
}) {
  const { t } = useI18n();
  // In the desktop app this bar is the window's title bar (lib/desktop-titlebar).
  const titleBar = useTitleBarProps<HTMLElement>();
  const entries = useConversationEntries(conv);
  const peerLine = usePeerLine(conv);
  const subtitle = useConversationSubtitle(conv, peerLine);
  const params = { conversationId: conv.id };

  const phone = useShellLayout() === 'phone';
  const navigate = useNavigate();
  const navRef = useRef<HTMLElement>(null);
  const fade = useEdgeFade(navRef);
  const tabs = [
    { key: 'chat', to: '/chat/c/$conversationId', label: t('chat.tabs.chat'), icon: 'chat' },
    {
      key: 'files',
      to: '/chat/c/$conversationId/files',
      label: t('chat.tabs.files'),
      icon: 'folder',
    },
    {
      key: 'pinned',
      to: '/chat/c/$conversationId/pinned',
      label: t('chat.tabs.pinned'),
      icon: 'pin',
    },
  ] as const;

  const nav = (
    <nav
      ref={navRef}
      aria-label={t('chat.tabs.label')}
      className={cn(
        'flex h-full items-stretch gap-4',
        // A narrow window squeezes the tabs (they scroll, a cut edge fades), never the call
        // buttons; below about 460 px of header (420 px inside its padding) they become one menu.
        phone
          ? 'px-4'
          : 'ml-4 hidden min-w-0 shrink overflow-x-auto [scrollbar-width:none] @[420px]/chathead:flex',
      )}
      style={phone ? undefined : fadeMask(fade)}
    >
      {tabs.map((x) => (
        <Link
          key={x.key}
          to={x.to}
          params={params}
          aria-current={tab === x.key ? 'page' : undefined}
          className={cn(
            'flex shrink-0 items-center border-b-2 text-[13.5px] font-semibold whitespace-nowrap transition-colors',
            tab === x.key ? 'border-accent text-fg' : 'border-transparent text-fg2 hover:text-fg',
          )}
        >
          {x.label}
        </Link>
      ))}
    </nav>
  );

  return (
    <>
      <header
        {...titleBar}
        className="@container/chathead flex h-14 shrink-0 items-center gap-3 border-b border-line pr-3 pl-3 md:pr-4 md:pl-6"
      >
        <PhoneBack to="/chat" />
        <ConversationAvatar conv={conv} size="md" />
        <div className="flex min-w-0 flex-col">
          <h1 className="m-0 flex min-w-0 items-center gap-1.5 text-[15px] leading-5 font-bold">
            <span className="truncate">{conv.title}</span>
            {conv.private ? (
              <Icon
                name="lock"
                size={13}
                className="shrink-0 text-fg2"
                aria-label={t('chat.header.private')}
              />
            ) : null}
          </h1>
          {subtitle ? (
            <span className="flex items-center gap-1.5 truncate text-xs text-fg2">
              {conv.spaceColor && conv.type !== 'direct' ? (
                <SpaceDot color={conv.spaceColor} />
              ) : null}
              {subtitle}
            </span>
          ) : null}
        </div>
        {/* Phone (H10): the tabs get their own row so the chat name stays readable. */}
        {phone ? null : nav}
        {phone ? null : (
          <Menu>
            <MenuTrigger asChild>
              <button
                type="button"
                aria-label={t('chat.tabs.label')}
                className="ml-2 flex h-8 shrink-0 items-center gap-1 rounded-sm px-2 text-[13.5px] font-semibold text-fg hover:bg-bg2 @[420px]/chathead:hidden"
              >
                {tabs.find((x) => x.key === tab)?.label}
                <Icon name="chevD" size={14} className="text-fg2" />
              </button>
            </MenuTrigger>
            <MenuContent align="start" className="w-[200px]">
              {tabs.map((x) => (
                <MenuItem
                  key={x.key}
                  icon={x.icon}
                  shortcut={tab === x.key ? <Icon name="check" size={14} /> : undefined}
                  aria-current={tab === x.key ? 'page' : undefined}
                  onSelect={() => void navigate({ to: x.to, params })}
                >
                  {x.label}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {conv.archivedAt ? (
            <span className="mr-2 rounded-xs bg-bg2 px-2 py-0.5 text-tag font-semibold text-fg2">
              {t('chat.header.archived')}
            </span>
          ) : null}
          <CallButton conv={conv} />
          <MeetingChatJoin conv={conv} />
          <StartMeetingButton conv={conv} />
          {(conv.type === 'group' || conv.type === 'alert') && conv.permissions.manage ? (
            <Tooltip content={t('chat.menu.addPeople')}>
              <IconButton
                size="sm"
                tone="plain"
                aria-label={t('chat.menu.addPeople')}
                onClick={() => openChatDialog({ kind: 'addPeople', conv })}
              >
                <Icon name="userPlus" size={17} />
              </IconButton>
            </Tooltip>
          ) : null}
          <ActionDropdown entries={entries}>
            <IconButton size="sm" tone="plain" aria-label={t('chat.header.menu')}>
              <Icon name="dots" size={17} />
            </IconButton>
          </ActionDropdown>
        </div>
      </header>
      {phone ? <div className="h-11 shrink-0 border-b border-line">{nav}</div> : null}
    </>
  );
}

/** Which ends of a horizontally scrolling row have more content past them. */
function useEdgeFade(ref: React.RefObject<HTMLElement | null>) {
  const [fade, setFade] = useState({ start: false, end: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      const next = { start: el.scrollLeft > 1, end: max - el.scrollLeft > 1 };
      setFade((f) => (f.start === next.start && f.end === next.end ? f : next));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [ref]);
  return fade;
}

/** A soft 20 px fade on the cut ends, so a squeezed tab reads as "more this way". */
function fadeMask({ start, end }: { start: boolean; end: boolean }) {
  if (!start && !end) return undefined;
  const mask = `linear-gradient(to right, ${start ? 'transparent, #000 20px' : '#000'}, ${
    end ? '#000 calc(100% - 20px), transparent' : '#000'
  })`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

/** Direct chats: "Çevrimiçi · Üye · yerel saat 09:41" (4.5). */
function usePeerLine(conv: Conversation): string | null {
  const { t } = useI18n();
  const peerId = conv.type === 'direct' ? (conv.peer?.id ?? '') : '';
  const { data: card } = useQuery({ ...userCardQuery(peerId), enabled: Boolean(peerId) });
  const live = usePresence(peerId || null);
  const label = usePresenceLabel(live ?? card?.presence ?? null);
  const local = useLocalTime(card?.timezone ?? null);
  if (!peerId) return null;
  return [
    label,
    card ? t(`admin.members.role.${card.orgRole}`) : null,
    local ? t('chat.header.localTime', { time: local.time }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
