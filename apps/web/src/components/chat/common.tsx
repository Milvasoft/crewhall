import { type AppLocale } from '@crewhall/i18n';
import { type UserSummary } from '@crewhall/shared';
import { Avatar, cn, Icon, initials, SpaceBadge, type AvatarProps } from '@crewhall/ui';
import { type ReactNode } from 'react';
import { usePresence } from '@/lib/chat/stores';
import { type Conversation, type Presence } from '@/lib/chat/types';
import { formatDate, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useMeetingLive } from '@/lib/meet/live';
import { useChangeCount } from '@/lib/motion';
import { useMe } from '@/lib/session';
import { PersonHover } from './PersonCard';

/** Pieces every chat screen uses: avatars with presence, time labels, my id. */

export function useMyId(): string {
  return useMe()?.user.id ?? '';
}

export function presenceDot(p: Presence | null | undefined): AvatarProps['presence'] {
  if (!p || p.state === 'offline') return null;
  return p.state;
}

/**
 * The presence dot pops when the person's state changes while on screen (not on load).
 * Two identical keyframes alternate so every change restarts the animation.
 */
export function usePresencePop(dot: AvatarProps['presence']): string | undefined {
  const n = useChangeCount(dot);
  if (n === 0) return undefined;
  return n % 2 ? 'animate-pop' : 'animate-[ch-pop-alt_260ms_var(--ease-out-std)_both]';
}

/** A person's avatar with the live presence dot; opens the person card on hover. */
export function PersonAvatar({
  user,
  size,
  card = true,
  className,
}: {
  user: Pick<UserSummary, 'id' | 'name' | 'imageUrl'>;
  size?: AvatarProps['size'];
  card?: boolean;
  className?: string;
}) {
  const p = usePresence(user.id);
  const dot = presenceDot(p);
  const pop = usePresencePop(dot);
  const avatar = (
    <Avatar
      name={user.name}
      src={user.imageUrl}
      size={size}
      presence={dot}
      presenceClassName={pop}
      className={className}
    />
  );
  return card ? <PersonHover userId={user.id}>{avatar}</PersonHover> : avatar;
}

const BOX: Record<'sm' | 'md' | 'base', string> = {
  sm: 'size-6 rounded-[7px]',
  md: 'size-8 rounded-[9px]',
  base: 'size-9 rounded-[10px]',
};

/** List and header avatar by chat type (4.1): person, stacked group, space letter, alarm, meeting. */
export function ConversationAvatar({
  conv,
  size = 'base',
}: {
  conv: Conversation;
  size?: 'sm' | 'md' | 'base';
}) {
  const peer = usePresence(conv.peer?.id);
  const dot = presenceDot(peer);
  const pop = usePresencePop(dot);
  // A meeting's chat: its icon turns green while people are in the meeting.
  const live = useMeetingLive(conv.type === 'meeting' ? conv.meetingId : null);
  if (conv.type === 'direct' && conv.peer) {
    return (
      <Avatar
        name={conv.peer.name}
        src={conv.peer.imageUrl}
        size={size}
        presence={dot}
        presenceClassName={pop}
      />
    );
  }
  // A channel emoji replaces the letter or icon placeholder.
  if (conv.emoji) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'flex shrink-0 items-center justify-center bg-bg2 leading-none',
          BOX[size],
          size === 'sm' ? 'text-[14px]' : size === 'md' ? 'text-[17px]' : 'text-[20px]',
        )}
      >
        {conv.emoji}
      </span>
    );
  }
  if (conv.type === 'alert' || conv.type === 'meeting') {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'flex shrink-0 items-center justify-center',
          live ? 'bg-success/15 text-success' : 'bg-bg2 text-fg',
          BOX[size],
        )}
      >
        <Icon name={conv.type === 'alert' ? 'alert' : 'video'} size={size === 'sm' ? 14 : 17} />
      </span>
    );
  }
  if (conv.type === 'space' && conv.spaceColor) {
    return (
      <SpaceBadge
        color={conv.spaceColor}
        name={conv.title}
        size={size === 'sm' ? 'sm' : size === 'md' ? 'md' : 'lg'}
      >
        {initials(conv.title, 2)}
      </SpaceBadge>
    );
  }
  // Unnamed or named group: two stacked initials of the title.
  const parts = conv.title.split(/,\s*/).filter(Boolean);
  if (parts.length >= 2 && !conv.name) {
    return (
      <span aria-hidden="true" className={cn('relative shrink-0', BOX[size])}>
        <Avatar name={parts[0] ?? ''} size="sm" className="absolute top-0 left-0" />
        <Avatar
          name={parts[1] ?? ''}
          size="sm"
          className="absolute right-0 bottom-0 shadow-[0_0_0_2px_var(--bg)]"
        />
      </span>
    );
  }
  return <Avatar name={conv.title} size={size} />;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** List time: today "09:38", yesterday "Dün", this week the weekday, else "12 Eki". */
export function listTime(value: string, locale: AppLocale, now: number, yesterday: string): string {
  const d = new Date(value);
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return formatTime(d, locale);
  if (days === 1) return yesterday;
  if (days < 7) return formatDate(d, locale, { weekday: 'long' });
  return formatDate(d, locale, { day: 'numeric', month: 'short' });
}

/** Day divider: "Bugün", "Dün", or "Cuma, 16 Ekim". */
export function dayLabel(
  value: string,
  locale: AppLocale,
  now: number,
  t: (k: 'today' | 'yesterday') => string,
): string {
  const d = new Date(value);
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return t('today');
  if (days === 1) return t('yesterday');
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return formatDate(d, locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Subtitle of a chat header and list rows ("Milvasoft space'i · 7 üye"). */
export function useConversationSubtitle(conv: Conversation, peerLine?: ReactNode): ReactNode {
  const { t } = useI18n();
  const local = localSubtitle(t, conv, peerLine);
  const f = conv.federation;
  if (!f) return local;
  // Shared with other installations (roadmap 26): say with which, and when it is cut off.
  const federated = f.active
    ? t('federation.chat.federated', { domains: f.domains.join(', ') })
    : f.shared
      ? t('federation.shared.archived')
      : t('federation.chat.readOnly');
  return conv.type === 'direct' || !local ? federated : `${String(local)} · ${federated}`;
}

function localSubtitle(
  t: ReturnType<typeof useI18n>['t'],
  conv: Conversation,
  peerLine?: ReactNode,
): ReactNode {
  if (conv.type === 'direct') return peerLine ?? null;
  if (conv.type === 'space') {
    return t('chat.header.spaceMembers', { space: conv.spaceName ?? '', count: conv.memberCount });
  }
  if (conv.type === 'alert') {
    return conv.spaceName
      ? t('chat.header.alertSpace', { space: conv.spaceName, count: conv.memberCount })
      : t('chat.header.members', { count: conv.memberCount });
  }
  if (conv.type === 'meeting') return t('chat.header.meeting', { count: conv.memberCount });
  return t('chat.header.members', { count: conv.memberCount });
}
