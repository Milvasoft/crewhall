import { Button, Icon, IconButton, Tooltip } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { type Conversation } from '@/lib/chat/types';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useModuleEnabled } from '@/lib/identity/modules';
import { writePrefs } from '@/lib/meet/prefs';
import { meetingQuery } from '@/lib/meet/queries';
import { usePermissions } from '@/lib/session';
import { AvatarStack } from './bits';
import { useOpenMeeting } from './openMeeting';

/**
 * A meeting's own chat (a persistent room's, a scheduled meeting's): join the room from it. The
 * header has "Sesli katıl" and "Görüntülü katıl"; while people are inside, a strip under the
 * header says so with their faces and Katıl.
 */
function useChatMeeting(conv: Conversation) {
  const meetOn = useModuleEnabled('meet');
  const { role } = usePermissions();
  const enabled = meetOn && role !== 'guest' && conv.type === 'meeting' && Boolean(conv.meetingId);
  const meeting = useQuery({
    ...meetingQuery(conv.meetingId ?? ''),
    enabled,
    // People come and go (no meet events on the socket yet).
    refetchInterval: 15_000,
  }).data;
  return enabled && meeting && !meeting.cancelledAt && meeting.permissions.join ? meeting : null;
}

function useJoin() {
  const openMeeting = useOpenMeeting();
  return (slug: string, video: boolean) => {
    // The waiting room starts with the camera as chosen here.
    writePrefs({ joinCameraOff: !video });
    openMeeting(slug);
  };
}

export function MeetingChatJoin({ conv }: { conv: Conversation }) {
  const { t } = useI18n();
  const meeting = useChatMeeting(conv);
  const join = useJoin();
  if (!meeting) return null;
  return (
    <>
      <Tooltip content={t('meet.chatJoin.voice')}>
        <IconButton
          size="sm"
          tone="plain"
          aria-label={t('meet.chatJoin.voice')}
          onClick={() => join(meeting.slug, false)}
        >
          <Icon name="call" size={17} />
        </IconButton>
      </Tooltip>
      <Tooltip content={t('meet.chatJoin.video')}>
        <IconButton
          size="sm"
          tone="plain"
          aria-label={t('meet.chatJoin.video')}
          onClick={() => join(meeting.slug, true)}
        >
          <Icon name="video" size={17} />
        </IconButton>
      </Tooltip>
    </>
  );
}

export function MeetingChatStrip({ conv }: { conv: Conversation }) {
  const { t } = useI18n();
  const meeting = useChatMeeting(conv);
  const join = useJoin();
  const live = meeting?.live;
  if (!meeting || !live || !live.participantCount) return null;
  return (
    <div
      role="status"
      className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-success/10 px-4 text-sm md:px-6"
    >
      <span className="size-2 animate-pulse rounded-full bg-success" />
      <AvatarStack people={live.participants} max={4} />
      <span className="min-w-0 flex-1 truncate font-semibold">
        {t('meet.chatJoin.live', { count: live.participantCount })}
      </span>
      <Button size="xs" variant="pri" onClick={() => join(meeting.slug, true)}>
        <Icon name="video" size={14} />
        {t('meet.actions.join')}
      </Button>
    </div>
  );
}
