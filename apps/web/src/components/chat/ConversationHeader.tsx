import { cn, Icon, IconButton, SpaceDot, Tooltip } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
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
  const tabs = [
    { key: 'chat', to: '/chat/c/$conversationId', label: t('chat.tabs.chat') },
    { key: 'files', to: '/chat/c/$conversationId/files', label: t('chat.tabs.files') },
    { key: 'pinned', to: '/chat/c/$conversationId/pinned', label: t('chat.tabs.pinned') },
  ] as const;

  const nav = (
    <nav
      aria-label={t('chat.tabs.label')}
      className={cn(
        'flex h-full items-stretch gap-4',
        // A narrow window squeezes the tabs (they scroll), never the call buttons.
        phone ? 'px-4' : 'ml-4 min-w-0 shrink overflow-x-auto [scrollbar-width:none]',
      )}
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
          <h1 className="m-0 truncate text-[15px] leading-5 font-bold">{conv.title}</h1>
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
